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
 */

import { execFile } from 'child_process'
import { unlinkSync } from 'fs'
import { join, extname, dirname } from 'path'
import { tmpdir } from 'os'
import { log } from '../logger/Logger'
import { PIPER_SCRIPT, PIPER_MODEL } from '../config'
import { cleanTTS } from './TtsService'

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

/** 队列中的合成任务 */
interface QueuedTask {
  request: PiperSynthesizeRequest
  resolve: (result: PiperSynthesizeResult) => void
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
//  PiperOrchestrator
// ══════════════════════════════════════════

export class PiperOrchestrator {
  /** 当前用户选择的模型（可通过 switchModel 切换） */
  private currentModel: string = DEFAULT_PIPER_MODEL

  /** 请求队列 */
  private queue: QueuedTask[] = []

  /** 是否正在处理 */
  private isProcessing = false

  /** 是否已停止 */
  private stopped = false

  /** 最大队列长度（防止无限堆积） */
  private readonly MAX_QUEUE_SIZE = 50

  /** 单次合成超时（毫秒） */
  private readonly SYNTHESIS_TIMEOUT_MS = 30000

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
   * 如果队列已满，返回错误结果而非排队。
   */
  async synthesize(request: PiperSynthesizeRequest): Promise<PiperSynthesizeResult> {
    if (this.stopped) {
      return {
        success: false,
        model: request.model || DEFAULT_PIPER_MODEL,
        error: 'Piper 编排器已停止',
        durationMs: 0,
        fallbackUsed: false,
      }
    }

    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      return {
        success: false,
        model: request.model || DEFAULT_PIPER_MODEL,
        error: `请求队列已满 (${this.MAX_QUEUE_SIZE})，请稍后重试`,
        durationMs: 0,
        fallbackUsed: false,
      }
    }

    return new Promise((resolve) => {
      this.queue.push({ request, resolve })
      if (!this.isProcessing) {
        this.processQueue()
      }
    })
  }

  /**
   * 清空队列并停止处理。
   */
  stop(): void {
    this.stopped = true
    // 拒绝所有排队请求
    while (this.queue.length > 0) {
      const task = this.queue.shift()!
      task.resolve({
        success: false,
        model: DEFAULT_PIPER_MODEL,
        error: 'Piper 编排器已停止',
        durationMs: 0,
        fallbackUsed: false,
      })
    }
    this.isProcessing = false
  }

  /**
   * 重置停止状态（恢复处理）。
   */
  reset(): void {
    this.stopped = false
  }

  /** 获取当前队列状态 */
  getQueueStatus(): { queueSize: number; isProcessing: boolean; currentModel: string } {
    return {
      queueSize: this.queue.length,
      isProcessing: this.isProcessing,
      currentModel: this.currentModel,
    }
  }

  // ── 私有：队列处理 ──

  /**
   * 串行处理队列中的合成请求。
   *
   * 每个请求独立合成，失败时自动回退到默认模型重试一次。
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.stopped) return
    this.isProcessing = true

    try {
      while (this.queue.length > 0 && !this.stopped) {
        const task = this.queue.shift()!
        const result = await this.processOne(task.request)
        task.resolve(result)
      }
    } finally {
      this.isProcessing = false
      // 处理期间可能有新任务入队
      if (this.queue.length > 0 && !this.stopped) {
        this.processQueue()
      }
    }
  }

  /**
   * 处理单个合成请求（含回退逻辑）。
   */
  private async processOne(request: PiperSynthesizeRequest): Promise<PiperSynthesizeResult> {
    const text = cleanTTS(request.text || '')
    if (!text || text.length < 2) {
      return {
        success: false,
        model: request.model || DEFAULT_PIPER_MODEL,
        error: '文本太短或清理后为空',
        durationMs: 0,
        fallbackUsed: false,
      }
    }

    const primaryModel = this.resolveModel(request)
    const speed = request.speed ?? PIPER_MODEL_CATALOG[primaryModel]?.speed ?? 1.0
    const pitch = request.pitch ?? PIPER_MODEL_CATALOG[primaryModel]?.pitch ?? 1.0

    // 验证参数范围
    if (speed < 0.5 || speed > 2.0) {
      return {
        success: false,
        model: primaryModel,
        error: `语速超出范围: ${speed}。应在 0.5-2.0 之间。`,
        durationMs: 0,
        fallbackUsed: false,
      }
    }

    const t0 = Date.now()

    // 第一次尝试：使用选定的模型
    const firstResult = await this.synthesizeWithModel(text, primaryModel, speed, pitch)
    if (firstResult.success) {
      return {
        success: true,
        model: primaryModel,
        audioFile: firstResult.audioFile,
        durationMs: Date.now() - t0,
        fallbackUsed: false,
      }
    }

    // 回退逻辑：如果主模型失败且不是默认模型，尝试默认模型
    if (primaryModel !== DEFAULT_PIPER_MODEL) {
      log('WARN', 'piper_orchestrator_fallback', {
        primaryModel,
        fallbackModel: DEFAULT_PIPER_MODEL,
        error: firstResult.error,
      })

      const fallbackResult = await this.synthesizeWithModel(
        text,
        DEFAULT_PIPER_MODEL,
        speed,
        pitch,
      )

      if (fallbackResult.success) {
        return {
          success: true,
          model: DEFAULT_PIPER_MODEL,
          audioFile: fallbackResult.audioFile,
          durationMs: Date.now() - t0,
          fallbackUsed: true,
        }
      }

      // 默认模型也失败
      return {
        success: false,
        model: primaryModel,
        error: `主模型 (${primaryModel}) 和默认模型 (${DEFAULT_PIPER_MODEL}) 均失败: ${fallbackResult.error}`,
        durationMs: Date.now() - t0,
        fallbackUsed: true,
      }
    }

    // 已经是默认模型，直接返回失败
    return {
      success: false,
      model: primaryModel,
      error: firstResult.error,
      durationMs: Date.now() - t0,
      fallbackUsed: false,
    }
  }

  /**
   * 使用指定模型合成语音。
   */
  private synthesizeWithModel(
    text: string,
    model: string,
    speed: number,
    pitch: number,
  ): Promise<{ success: boolean; audioFile?: string; error?: string }> {
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
            '--model', modelPath,
            '--output_file', tempFile,
            '--length_scale', lengthScale,
            '--noise_scale', noiseScale,
            '--noise_w', noiseW,
          ],
          {
            timeout: this.SYNTHESIS_TIMEOUT_MS,
            windowsHide: true,
          },
          (err) => {
            if (err) {
              // 清理可能不完整的文件
              try { unlinkSync(tempFile) } catch { /* ignore */ }
              resolve({
                success: false,
                error: err.message || String(err),
              })
            } else {
              resolve({
                success: true,
                audioFile: tempFile,
              })
            }
          },
        )

        proc.stdin?.end(text)
        proc.stderr?.on('data', (d) => {
          log('DEBUG', 'piper_orchestrator_stderr', { msg: d.toString().trim() })
        })
      } catch (err) {
        resolve({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const piperOrchestrator = new PiperOrchestrator()
