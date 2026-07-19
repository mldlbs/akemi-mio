/**
 * PiperOrchestrator — 本地语音引擎智能编排
 *
 * 功能：
 * 1. 任务标签 → Piper 模型智能映射 (chat/story/alert → 不同的语音模型)
 * 2. 异步请求队列（串行合成，避免多个 Piper 进程争抢资源）
 * 3. 模型加载失败时自动回退到默认模型（容错）
 * 4. 用户可持久切换当前活跃模型
 *
 * 与现有系统的关系：
 * - PiperTtsTool: MCP 工具层，Agent 通过 speak_with_piper 调用
 * - TtsService:    自动 TTS 管道（ChatExecutor 自动朗读），独立运作
 * - VoiceStyleMap:  语义风格映射（edge-tts 的 voice 选择），本模块互补
 *
 * 设计原则：
 * - 所有合成请求排队处理，防止并发 Piper 进程导致音频重叠
 * - 模型回退链：用户指定模型 → 任务标签推荐模型 → 默认模型
 * - 容错不抛异常：失败时回退到默认模型继续合成
 *
 * 重构说明：
 * - 队列管理委托给 AsyncQueue（core/patterns），消除手动 QueuedTask[] + processQueue 样板代码
 * - 内部操作使用 Result<T, E>（core/patterns），替代 ad-hoc {success, error} 模式
 * - 模型解析保持独立（领域特定逻辑，不适合泛化）
 */

import { execFile } from 'child_process'
import { unlinkSync } from 'fs'
import { join, extname, dirname } from 'path'
import { tmpdir } from 'os'
import { log } from '../logger/Logger'
import { PIPER_SCRIPT, PIPER_MODEL } from '../config'
import { cleanTTS } from './TtsService'
import { AsyncQueue, ok, err, type Result } from '../core/patterns'
import { MetricsCollector } from '../core/metrics/MetricsCollector'
import type { IEngineService, EngineStatus, EngineMetrics } from '../engine/types'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 任务标签 — 用于自动选择模型 */
export type PiperTaskTag = 'chat' | 'story' | 'alert'

/** Piper 模型配置 */
export interface PiperModelConfig {
  /** 模型名（Piper ONNX 模型文件名前缀） */
  name: string
  /** 人类可读的显示名 */
  displayName: string
  /** 描述 */
  description: string
  /** 推荐语速因子 */
  speed: number
  /** 推荐音调因子 */
  pitch: number
}

/** 合成请求 */
export interface PiperSynthesizeRequest {
  /** 要朗读的文本 */
  text: string
  /** 任务标签（可选，用于自动选模型） */
  taskTag?: PiperTaskTag
  /** 显式指定模型（可选，优先级最高） */
  model?: string
  /** 语速（可选，覆盖推荐值） */
  speed?: number
  /** 音调（可选，覆盖推荐值） */
  pitch?: number
  /** 请求 ID（用于日志追踪） */
  requestId?: string
}

/** 合成结果 */
export interface PiperSynthesizeResult {
  success: boolean
  /** 实际使用的模型 */
  model: string
  /** 音频文件路径（成功时） */
  audioFile?: string
  /** 错误信息（失败时） */
  error?: string
  /** 耗时毫秒 */
  durationMs: number
  /** 是否触发了回退 */
  fallbackUsed: boolean
}

// ══════════════════════════════════════════
//  模型目录
// ══════════════════════════════════════════

/** 所有可用 Piper 模型的配置 */
export const PIPER_MODEL_CATALOG: Record<string, PiperModelConfig> = {
  'zh_CN-huayan-medium': {
    name: 'zh_CN-huayan-medium',
    displayName: '花颜·女声',
    description: '通用女声，响应快速，适合日常对话',
    speed: 1.0,
    pitch: 1.0,
  },
  'zh_CN-ling_ling-medium': {
    name: 'zh_CN-ling_ling-medium',
    displayName: '玲玲·温柔女声',
    description: '温柔女声，高表现力，适合讲故事、朗读',
    speed: 0.9,
    pitch: 1.0,
  },
  'zh_CN-tx_mati-medium': {
    name: 'zh_CN-tx_mati-medium',
    displayName: '马提·沉稳男声',
    description: '沉稳男声，清晰有力，适合通知、提醒',
    speed: 1.1,
    pitch: 0.95,
  },
}

/** 任务标签 → 推荐模型映射 */
const TAG_MODEL_MAP: Record<PiperTaskTag, string> = {
  chat: 'zh_CN-huayan-medium',
  story: 'zh_CN-ling_ling-medium',
  alert: 'zh_CN-tx_mati-medium',
}

/** 默认模型（所有回退链的终点） */
export const DEFAULT_PIPER_MODEL = 'zh_CN-huayan-medium'

/** 模型白名单 */
const VALID_MODELS = Object.keys(PIPER_MODEL_CATALOG)

// ══════════════════════════════════════════
//  合成统计数据（供 TtsPiperBridge 使用）
// ══════════════════════════════════════════

/** 单模型的合成统计 */
export interface PiperModelSynthesisStat {
  /** 总合成请求数 */
  totalRequests: number
  /** 成功数 */
  successCount: number
  /** 失败数 */
  failureCount: number
  /** 总延迟（毫秒，用于计算平均） */
  totalLatencyMs: number
  /** 平均延迟（毫秒） */
  avgLatencyMs: number
}

/** 合成统计聚合 */
export interface PiperSynthesisStats {
  /** 各模型的统计 */
  perModel: Record<string, PiperModelSynthesisStat>
  /** 总计数据 */
  total: { requests: number; success: number; failure: number }
}

// ══════════════════════════════════════════
//  PiperOrchestrator
// ══════════════════════════════════════════

export class PiperOrchestrator implements IEngineService {
  /** IEngineService 引擎名 */
  readonly name = 'piper-tts'

  /** 暂停状态标志（pause() 设置，resume() 清除） */
  private _paused = false

  /** 当前用户选择的模型（可通过 switchModel 切换） */
  private currentModel: string = DEFAULT_PIPER_MODEL

  /** 单次合成超时（毫秒），同时用于 AsyncQueue 超时和 execFile 超时 */
  private readonly SYNTHESIS_TIMEOUT_MS = 30000

  /**
   * 各模型延迟指标收集器。
   * 替代手动 synthesisStats 的累积逻辑，同时提供滑动窗口统计。
   * 成功合成时记录延迟数值；失败计数通过 failureCounts 独立追踪，
   * 避免 0 值污染平均延迟。
   */
  private readonly latencyMetrics = new MetricsCollector<string>({
    slidingWindowSize: 10,
    loggerName: 'piper_latency',
  })

  /** 各模型失败次数（独立追踪，避免影响延迟统计） */
  private readonly failureCounts = new Map<string, number>()

  /**
   * 通用异步串行队列 — 替代手动 QueuedTask[] + processQueue + isProcessing/stopped。
   * 配置：最大 50 项，每项超时 30s。
   */
  private readonly queue: AsyncQueue<PiperSynthesizeRequest, PiperSynthesizeResult>

  // ── 构造 ──

  constructor() {
    this.queue = new AsyncQueue<PiperSynthesizeRequest, PiperSynthesizeResult>({
      processor: (request) => this.processOneWithResult(request),
      maxSize: 50,
      timeoutMs: this.SYNTHESIS_TIMEOUT_MS,
    })
  }

  // ── 模型管理 ──

  /**
   * 切换当前活跃的 Piper 模型。
   * 返回是否切换成功（模型名无效时拒绝）。
   */
  switchModel(modelName: string): { success: boolean; model: string; message: string } {
    if (!VALID_MODELS.includes(modelName)) {
      return {
        success: false,
        model: this.currentModel,
        message: `无效模型: ${modelName}。可用: ${VALID_MODELS.join(', ')}`,
      }
    }
    const prev = this.currentModel
    this.currentModel = modelName
    log('INFO', 'piper_orchestrator_model_switched', { from: prev, to: modelName })
    return {
      success: true,
      model: this.currentModel,
      message: `已切换为 ${PIPER_MODEL_CATALOG[modelName].displayName} (${modelName})`,
    }
  }

  /**
   * 预热指定模型 — 加速首次合成。
   *
   * 角色化方案切换时调用，通过一次极短的语音合成（1 字符）触发
   * Piper Python 进程和 ONNX 模型的初始化，后续实际合成时跳过冷启动。
   *
   * 预热不会阻塞正常合成队列，但建议在后台静默执行。
   *
   * @param modelName 要预热的模型名
   */
  async warmupModel(modelName: string): Promise<void> {
    if (!VALID_MODELS.includes(modelName)) {
      log('WARN', 'piper_warmup_invalid_model', { model: modelName })
      return
    }

    // 使用一个极短文本预热（仅触发模型加载，不产生有效音频）
    const warmupText = ' '
    const speed = PIPER_MODEL_CATALOG[modelName]?.speed ?? 1.0
    const pitch = PIPER_MODEL_CATALOG[modelName]?.pitch ?? 1.0

    // 在队列外直接调用 synthesizeWithModel（不走队列，避免阻塞正常请求）
    const result = await this.synthesizeWithModel(warmupText, modelName, speed, pitch)
    if (result.ok) {
      // 清理预热产生的临时文件
      try {
        unlinkSync(result.value)
      } catch {
        /* ignore */
      }
      log('DEBUG', 'piper_warmup_success', { model: modelName })
    } else {
      log('WARN', 'piper_warmup_failed', { model: modelName, error: result.error })
    }
  }

  /** 获取当前活跃模型 */
  getCurrentModel(): string {
    return this.currentModel
  }

  /** 获取所有可用模型列表 */
  getAvailableModels(): PiperModelConfig[] {
    return VALID_MODELS.map((name) => PIPER_MODEL_CATALOG[name])
  }

  /**
   * 根据任务标签解析应该使用的模型。
   *
   * 优先级：显式 model > 任务标签推荐 > 当前用户选择 > 默认模型
   */
  resolveModel(request: PiperSynthesizeRequest): string {
    // 1. 显式指定
    if (request.model && VALID_MODELS.includes(request.model)) {
      return request.model
    }
    // 2. 任务标签推荐
    if (request.taskTag && TAG_MODEL_MAP[request.taskTag]) {
      return TAG_MODEL_MAP[request.taskTag]
    }
    // 3. 当前用户选择
    return this.currentModel
  }

  // ── 合成接口 ──

  /**
   * 提交合成请求（异步，自动排队）。
   *
   * 内部委托给 AsyncQueue.enqueue()，将 Result 转换为 PiperSynthesizeResult。
   * 失败时的 model 字段回退到请求中的 model 或默认模型。
   */
  async synthesize(request: PiperSynthesizeRequest): Promise<PiperSynthesizeResult> {
    const result = await this.queue.enqueue(request)

    if (result.ok) {
      return result.value
    }

    // AsyncQueue 层错误（队列满、已停止、超时）
    return {
      success: false,
      model: request.model || DEFAULT_PIPER_MODEL,
      error: result.error,
      durationMs: 0,
      fallbackUsed: false,
    }
  }

  /**
   * 停止队列：清空所有等待中的请求，停止处理后续请求（IEngineService）。
   */
  stop(): void {
    this._paused = true
    this.queue.stop()
    log('INFO', 'piper_orchestrator_stopped')
  }

  /**
   * 重置停止状态，允许继续处理（IEngineService）。
   */
  reset(): void {
    this._paused = false
    this.queue.reset()
    log('INFO', 'piper_orchestrator_reset')
  }

  /** 获取当前队列状态 */
  getQueueStatus(): { queueSize: number; isProcessing: boolean; currentModel: string } {
    const status = this.queue.getStatus()
    return {
      queueSize: status.pending,
      isProcessing: status.isProcessing,
      currentModel: this.currentModel,
    }
  }

  /**
   * 获取各模型的合成统计数据（供 TtsPiperBridge 消费）。
   * 数据来源：latencyMetrics（成功合成延迟）+ failureCounts（失败计数）。
   */
  getSynthesisStats(): PiperSynthesisStats {
    const allModels = new Set([...this.latencyMetrics.getKeys(), ...this.failureCounts.keys()])
    const perModel: Record<string, PiperModelSynthesisStat> = {}
    let total = { requests: 0, success: 0, failure: 0 }

    for (const model of allModels) {
      const stat = this.latencyMetrics.getStats(model)
      const failures = this.failureCounts.get(model) ?? 0
      const requests = stat.count + failures
      perModel[model] = {
        totalRequests: requests,
        successCount: stat.count,
        failureCount: failures,
        totalLatencyMs: Math.round(stat.sum),
        avgLatencyMs: stat.count > 0 ? Math.round(stat.avg) : 0,
      }
      total.requests += requests
      total.success += stat.count
      total.failure += failures
    }

    return { perModel, total }
  }

  /**
   * 重置合成统计数据。
   */
  resetSynthesisStats(): void {
    this.latencyMetrics.clear()
    this.failureCounts.clear()
  }

  // ══════════════════════════════════════════
  //  IEngineService — 统一引擎接口
  // ══════════════════════════════════════════

  /**
   * 获取引擎运行状态（IEngineService）。
   *
   * 返回 Piper TTS 当前的工作状态，包括队列深度、活跃模型等。
   */
  getStatus(): EngineStatus {
    const qs = this.getQueueStatus()
    const err = this.queue.getStatus().stopped ? '队列已停止' : undefined
    return {
      name: this.name,
      state: this._paused ? 'paused' : qs.isProcessing ? 'running' : qs.queueSize > 0 ? 'running' : 'idle',
      busy: qs.isProcessing || qs.queueSize > 0,
      queueSize: qs.queueSize,
      processing: qs.isProcessing,
      startedAt: undefined,
      uptimeMs: undefined,
      error: err,
      activeModel: qs.currentModel || this.currentModel,
    }
  }

  /**
   * 获取引擎性能指标（IEngineService）。
   *
   * 汇总所有模型的合成统计数据：总请求数、成功率、平均延迟等。
   */
  getMetrics(): EngineMetrics {
    const stats = this.getSynthesisStats()
    const total = stats.total
    return {
      totalRequests: total.requests,
      successCount: total.success,
      failureCount: total.failure,
      avgLatencyMs: this.calcAverageLatency(),
      reliability: total.requests > 0 ? total.success / total.requests : 1,
      extra: {
        perModel: stats.perModel,
      },
    }
  }

  /**
   * 获取引擎描述信息（IEngineService）。
   */
  getInfo(): string {
    const models = this.getAvailableModels()
    const current = this.getCurrentModel()
    const displayName = PIPER_MODEL_CATALOG[current]?.displayName || current
    return `PiperTTS 本地语音引擎 (${displayName}), ${models.length} 个可用模型, 离线低延迟`
  }

  /**
   * 暂停合成处理（IEngineService）。
   *
   * 等效于 stop() + 设置暂停标志，后续合成的首个请求自动触发 resume。
   */
  pause(): void {
    if (this._paused) return
    this._paused = true
    this.queue.stop()
    log('INFO', 'piper_orchestrator_paused')
  }

  /**
   * 恢复合成处理（IEngineService）。
   *
   * 等效于 reset() + 清除暂停标志。
   */
  resume(): void {
    if (!this._paused) return
    this._paused = false
    this.queue.reset()
    log('INFO', 'piper_orchestrator_resumed')
  }

  /**
   * 是否处于暂停状态（IEngineService）。
   */
  isPaused(): boolean {
    return this._paused
  }

  /**
   * 计算所有模型的平均延迟。
   * 委托给 MetricsCollector.getAvg()。
   */
  private calcAverageLatency(): number | undefined {
    const models = this.latencyMetrics.getKeys()
    if (models.length === 0) return undefined
    const totalLatency = models.reduce((sum, m) => sum + this.latencyMetrics.getStats(m).sum, 0)
    const totalReq = models.reduce((sum, m) => sum + this.latencyMetrics.getStats(m).count, 0)
    return totalReq > 0 ? Math.round(totalLatency / totalReq) : undefined
  }

  /**
   * 记录一次合成统计。
   * 委托给 MetricsCollector + failureCounts。
   * - 成功：记录延迟到 latencyMetrics（含滑动窗口统计）
   * - 失败：递增 failureCounts（不影响平均延迟计算）
   */
  private recordSynthesisStat(model: string, success: boolean, durationMs: number): void {
    if (success) {
      this.latencyMetrics.record(model, durationMs)
    } else {
      this.failureCounts.set(model, (this.failureCounts.get(model) ?? 0) + 1)
    }
  }

  // ── 私有：合成处理 ──

  /**
   * 处理单个合成请求（含回退逻辑），返回完整的 PiperSynthesizeResult。
   *
   * 这是 AsyncQueue.processor 的实际实现。
   * 将领域逻辑与队列调度分离：此方法只关心"如何合成"，不关心"何时合成"。
   */
  private async processOneWithResult(request: PiperSynthesizeRequest): Promise<PiperSynthesizeResult> {
    const text = cleanTTS(request.text || '')
    if (!text || text.length < 2) {
      const result: PiperSynthesizeResult = {
        success: false,
        model: request.model || DEFAULT_PIPER_MODEL,
        error: '文本太短或清理后为空',
        durationMs: 0,
        fallbackUsed: false,
      }
      this.recordSynthesisStat(result.model, result.success, result.durationMs)
      return result
    }

    const primaryModel = this.resolveModel(request)
    const speed = request.speed ?? PIPER_MODEL_CATALOG[primaryModel]?.speed ?? 1.0
    const pitch = request.pitch ?? PIPER_MODEL_CATALOG[primaryModel]?.pitch ?? 1.0

    // 验证参数范围
    if (speed < 0.5 || speed > 2.0) {
      const result: PiperSynthesizeResult = {
        success: false,
        model: primaryModel,
        error: `语速超出范围: ${speed}。应在 0.5-2.0 之间。`,
        durationMs: 0,
        fallbackUsed: false,
      }
      this.recordSynthesisStat(result.model, result.success, result.durationMs)
      return result
    }

    const t0 = Date.now()

    // 第一次尝试：使用选定的模型
    const firstResult = await this.synthesizeWithModel(text, primaryModel, speed, pitch)
    if (firstResult.ok) {
      const result: PiperSynthesizeResult = {
        success: true,
        model: primaryModel,
        audioFile: firstResult.value,
        durationMs: Date.now() - t0,
        fallbackUsed: false,
      }
      this.recordSynthesisStat(result.model, result.success, result.durationMs)
      return result
    }

    // 回退逻辑：如果主模型失败且不是默认模型，尝试默认模型
    if (primaryModel !== DEFAULT_PIPER_MODEL) {
      log('WARN', 'piper_orchestrator_fallback', {
        primaryModel,
        fallbackModel: DEFAULT_PIPER_MODEL,
        error: firstResult.error,
      })

      const fallbackResult = await this.synthesizeWithModel(text, DEFAULT_PIPER_MODEL, speed, pitch)

      if (fallbackResult.ok) {
        const result: PiperSynthesizeResult = {
          success: true,
          model: DEFAULT_PIPER_MODEL,
          audioFile: fallbackResult.value,
          durationMs: Date.now() - t0,
          fallbackUsed: true,
        }
        this.recordSynthesisStat(result.model, result.success, result.durationMs)
        return result
      }

      // 默认模型也失败
      const result: PiperSynthesizeResult = {
        success: false,
        model: primaryModel,
        error: `主模型 (${primaryModel}) 和默认模型 (${DEFAULT_PIPER_MODEL}) 均失败: ${fallbackResult.error}`,
        durationMs: Date.now() - t0,
        fallbackUsed: true,
      }
      this.recordSynthesisStat(result.model, result.success, result.durationMs)
      return result
    }

    // 已经是默认模型，直接返回失败
    const result: PiperSynthesizeResult = {
      success: false,
      model: primaryModel,
      error: firstResult.error,
      durationMs: Date.now() - t0,
      fallbackUsed: false,
    }
    this.recordSynthesisStat(result.model, result.success, result.durationMs)
    return result
  }

  /**
   * 使用指定模型合成语音。
   *
   * 重构为 Result<string, string> 替代 ad-hoc {success, audioFile?, error?} 模式。
   * Ok 分支携带音频文件路径，Err 分支携带错误描述。
   */
  private synthesizeWithModel(text: string, model: string, speed: number, pitch: number): Promise<Result<string, string>> {
    const tempFile = join(tmpdir(), `akemi-mio-piper-${Date.now()}.wav`)

    return new Promise((resolve) => {
      try {
        // 构建模型路径（基于文件名替换，支持任意 locale 前缀）
        const ext = extname(PIPER_MODEL)
        const dir = dirname(PIPER_MODEL)
        const modelPath = join(dir, model + ext)
        const lengthScale = (1.0 / speed).toFixed(2)
        const noiseScale = '0.667'
        const noiseW = '0.8'

        log('DEBUG', 'piper_orchestrator_synthesize', {
          model,
          text_len: text.length,
          speed,
          length_scale: lengthScale,
          text_preview: text.slice(0, 60),
        })

        const proc = execFile(
          'python',
          [
            PIPER_SCRIPT,
            '--model',
            modelPath,
            '--output_file',
            tempFile,
            '--length_scale',
            lengthScale,
            '--noise_scale',
            noiseScale,
            '--noise_w',
            noiseW,
          ],
          {
            timeout: this.SYNTHESIS_TIMEOUT_MS,
            windowsHide: true,
          },
          (execErr) => {
            if (execErr) {
              // 清理可能不完整的文件
              try {
                unlinkSync(tempFile)
              } catch {
                /* ignore */
              }
              resolve(err(execErr.message || String(execErr)))
            } else {
              resolve(ok(tempFile))
            }
          },
        )

        proc.stdin?.end(text)
        proc.stderr?.on('data', (d) => {
          log('DEBUG', 'piper_orchestrator_stderr', { msg: d.toString().trim() })
        })
      } catch (err) {
        resolve(err(err instanceof Error ? err.message : String(err)))
      }
    })
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const piperOrchestrator = new PiperOrchestrator()
