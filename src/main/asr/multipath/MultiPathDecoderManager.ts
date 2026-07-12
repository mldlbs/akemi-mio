/**
 * MultiPathDecoderManager — ASR 多路径解码器管理器
 *
 * 职责：
 * 1. 管理多个解码器实例的注册、生命周期、健康监控
 * 2. 对音频并行启动所有活跃解码器，协调融合流程
 * 3. 通过心跳监控检测解码器异常（OOM、模型损坏、超时等）
 * 4. 异常消息通过回调队列传递至融合节点，触发降级
 * 5. 故障解码器自动恢复（冷却期后重新激活）
 *
 * 架构：
 * ┌─────────────────────────────────────────────────────────┐
 * │ MultiPathDecoderManager                                 │
 * │                                                         │
 * │  register(decoder) → 加入并行池                          │
 * │  unregister(name)   → 从池移除                         │
 * │  transcribe(audio)  → 1. 心跳检查                       │
 * │                         2. 并行执行所有活跃解码器        │
 * │                         3. 融合 → 返回结果               │
 * │                         4. 更新健康/权重状态             │
 * │                                                         │
 * │  [心跳定时器] → 每秒检查所有解码器状态                   │
 * │  [错误队列]   → 异常消息回调 → FusionEngine             │
 * └─────────────────────────────────────────────────────────┘
 *
 * 与现有架构的关系：
 * - DecoderInstance 包装现有 WhisperGPU/WhisperCPU/Baidu 引擎
 * - FusionEngine 执行置信度加权融合
 * - 本管理器是 AsrService 的可选增强路径
 */

import { log } from '../../logger/Logger'
import type { WhisperGpuEngine } from '../WhisperGpuEngine'
import type { WhisperEngine } from '../WhisperEngine'
import type { BaiduEngine } from '../BaiduEngine'
import type {
  DecoderConfig,
  DecoderHealth,
  DecoderResult,
  ErrorMessageCallback,
  MultiPathFusionConfig,
  MultiPathFusionResult,
  IDecoderInstance,
} from './types'
import { DEFAULT_FUSION_CONFIG, DEFAULT_DECODER_CONFIG } from './types'
import { fusionEngine, FusionEngine } from './FusionEngine'
import {
  WhisperGpuDecoderInstance,
  WhisperCpuDecoderInstance,
  BaiduDecoderInstance,
} from './DecoderInstance'

// ══════════════════════════════════════════
//  心跳超时判断
// ══════════════════════════════════════════

function isHeartbeatTimedOut(health: DecoderHealth, timeoutMs: number): boolean {
  return Date.now() - health.lastHeartbeat > timeoutMs
}

// ══════════════════════════════════════════
//  MultiPathDecoderManager
// ══════════════════════════════════════════

export class MultiPathDecoderManager {
  private decoders = new Map<string, IDecoderInstance>()
  private fusion: FusionEngine
  private config: MultiPathFusionConfig
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private errorCallbacks: ErrorMessageCallback[] = []
  /** 崩溃解码器的冷却时间戳（decoderName → 下次可恢复时间） */
  private recoveryCooldowns = new Map<string, number>()

  constructor(config?: Partial<MultiPathFusionConfig>) {
    this.config = { ...DEFAULT_FUSION_CONFIG, ...config }
    this.fusion = fusionEngine
    this.fusion.updateConfig(this.config)
  }

  // ══════════════════════════════════════
  //  API: 配置
  // ══════════════════════════════════════

  /**
   * 更新融合配置。
   */
  updateConfig(partial: Partial<MultiPathFusionConfig>): void {
    this.config = { ...this.config, ...partial }
    this.fusion.updateConfig(partial)

    if (this.config.enabled && !this.heartbeatTimer) {
      this.startHeartbeat()
    } else if (!this.config.enabled && this.heartbeatTimer) {
      this.stopHeartbeat()
    }
  }

  /**
   * 获取当前配置。
   */
  getConfig(): MultiPathFusionConfig {
    return { ...this.config }
  }

  /**
   * 启用或禁用多路径融合。
   */
  setEnabled(enabled: boolean): void {
    this.updateConfig({ enabled })
  }

  /**
   * 检查多路径融合是否已启用且有活跃解码器。
   */
  isReady(): boolean {
    return this.config.enabled && this.getActiveDecoders().length > 0
  }

  // ══════════════════════════════════════
  //  API: 解码器注册
  // ══════════════════════════════════════

  /**
   * 注册 Whisper GPU 解码器。
   */
  registerWhisperGpu(
    engine: WhisperGpuEngine,
    config?: Partial<DecoderConfig>,
  ): string {
    const decoderConfig: DecoderConfig = {
      ...DEFAULT_DECODER_CONFIG,
      name: `whisper_gpu_${this.decoders.size + 1}`,
      backend: 'whisper_gpu',
      ...config,
    }

    if (this.decoders.has(decoderConfig.name)) {
      log('WARN', 'multipath_decoder_already_registered', { name: decoderConfig.name })
      return decoderConfig.name
    }

    const instance = new WhisperGpuDecoderInstance(engine, decoderConfig)
    this.decoders.set(decoderConfig.name, instance)
    this.fusion.registerDecoder(decoderConfig)

    log('INFO', 'multipath_decoder_registered', {
      name: decoderConfig.name,
      backend: decoderConfig.backend,
      model_size: decoderConfig.modelSize,
      weight: decoderConfig.initialWeight,
    })

    return decoderConfig.name
  }

  /**
   * 注册 Whisper CPU 解码器。
   */
  registerWhisperCpu(
    engine: WhisperEngine,
    config?: Partial<DecoderConfig>,
  ): string {
    const decoderConfig: DecoderConfig = {
      ...DEFAULT_DECODER_CONFIG,
      name: `whisper_cpu_${this.decoders.size + 1}`,
      backend: 'whisper_cpu',
      modelSize: 'tiny',
      timeoutMs: 25000,
      ...config,
    }

    if (this.decoders.has(decoderConfig.name)) {
      log('WARN', 'multipath_decoder_already_registered', { name: decoderConfig.name })
      return decoderConfig.name
    }

    const instance = new WhisperCpuDecoderInstance(engine, decoderConfig)
    this.decoders.set(decoderConfig.name, instance)
    this.fusion.registerDecoder(decoderConfig)

    log('INFO', 'multipath_decoder_registered', {
      name: decoderConfig.name,
      backend: decoderConfig.backend,
      model_size: decoderConfig.modelSize,
      weight: decoderConfig.initialWeight,
    })

    return decoderConfig.name
  }

  /**
   * 注册 Baidu 解码器。
   */
  registerBaidu(
    engine: BaiduEngine,
    apiKey?: string,
    secretKey?: string,
    config?: Partial<DecoderConfig>,
  ): string {
    const decoderConfig: DecoderConfig = {
      ...DEFAULT_DECODER_CONFIG,
      name: `baidu_${this.decoders.size + 1}`,
      backend: 'baidu',
      timeoutMs: 20000,
      confidenceBias: 0.05, // 百度云端服务通常置信度较低，适当补偿
      ...config,
    }

    if (this.decoders.has(decoderConfig.name)) {
      log('WARN', 'multipath_decoder_already_registered', { name: decoderConfig.name })
      return decoderConfig.name
    }

    const instance = new BaiduDecoderInstance(engine, decoderConfig, apiKey, secretKey)
    this.decoders.set(decoderConfig.name, instance)
    this.fusion.registerDecoder(decoderConfig)

    log('INFO', 'multipath_decoder_registered', {
      name: decoderConfig.name,
      backend: decoderConfig.backend,
      has_credentials: instance.hasCredentials,
      weight: decoderConfig.initialWeight,
    })

    return decoderConfig.name
  }

  /**
   * 直接从 IDecoderInstance 工厂注册解码器（供扩展用）。
   */
  registerDecoder(instance: IDecoderInstance): void {
    if (this.decoders.has(instance.name)) {
      log('WARN', 'multipath_decoder_already_registered', { name: instance.name })
      return
    }

    this.decoders.set(instance.name, instance)
    this.fusion.registerDecoder(instance.config)
  }

  /**
   * 从管理器中移除解码器。
   */
  async unregisterDecoder(name: string): Promise<boolean> {
    const instance = this.decoders.get(name)
    if (!instance) return false

    await instance.destroy()
    this.decoders.delete(name)
    this.fusion.unregisterDecoder(name)

    log('INFO', 'multipath_decoder_unregistered', { name })
    return true
  }

  /**
   * 获取所有已注册解码器的名称列表。
   */
  getDecoderNames(): string[] {
    return Array.from(this.decoders.keys())
  }

  /**
   * 获取指定解码器的健康状态。
   */
  getDecoderHealth(name: string): DecoderHealth | null {
    const instance = this.decoders.get(name)
    return instance ? instance.getHealth() : null
  }

  /**
   * 获取所有解码器的健康状态快照。
   */
  getAllHealth(): DecoderHealth[] {
    return Array.from(this.decoders.values()).map((d) => d.getHealth())
  }

  /**
   * 获取活跃解码器列表（state !== dead && active === true）。
   */
  getActiveDecoders(): IDecoderInstance[] {
    return Array.from(this.decoders.values()).filter((d) => {
      const health = d.getHealth()
      return health.active && health.state !== 'dead' && health.state !== 'crashed'
    })
  }

  // ══════════════════════════════════════
  //  API: 错误队列
  // ══════════════════════════════════════

  /**
   * 注册异常消息回调。
   * 当解码器崩溃/超时/OOM 时，通过此回调通知调用方。
   */
  onError(callback: ErrorMessageCallback): void {
    this.errorCallbacks.push(callback)
  }

  /**
   * 移除异常消息回调。
   */
  offError(callback: ErrorMessageCallback): void {
    const idx = this.errorCallbacks.indexOf(callback)
    if (idx >= 0) {
      this.errorCallbacks.splice(idx, 1)
    }
  }

  // ══════════════════════════════════════
  //  API: 生命周期
  // ══════════════════════════════════════

  /**
   * 启动心跳监控。
   * 在首次调用 transcribe() 或启用多路径时自动调用。
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return

    this.heartbeatTimer = setInterval(() => {
      this.performHeartbeatCheck()
    }, this.config.heartbeatIntervalMs)

    log('INFO', 'multipath_heartbeat_started', {
      interval_ms: this.config.heartbeatIntervalMs,
      decoder_count: this.decoders.size,
    })
  }

  /**
   * 停止心跳监控。
   */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * 销毁管理器，清理所有解码器和定时器。
   */
  async destroy(): Promise<void> {
    this.stopHeartbeat()

    for (const [name, instance] of this.decoders) {
      await instance.destroy()
      this.fusion.unregisterDecoder(name)
    }

    this.decoders.clear()
    this.errorCallbacks = []
    this.recoveryCooldowns.clear()

    log('INFO', 'multipath_manager_destroyed')
  }

  // ══════════════════════════════════════
  //  API: 核心转录入口
  // ══════════════════════════════════════

  /**
   * 并行执行所有活跃解码器，并融合结果。
   *
   * 流程：
   * 1. 预处理：心跳健康检查，移除死亡/崩溃解码器
   * 2. 并行执行：对所有活跃解码器启动 transcribe
   * 3. 异常捕获：捕获超时/崩溃，通过错误队列通知
   * 4. 融合：将结果传递给 FusionEngine
   * 5. 反馈：更新各解码器的健康状态和权重
   *
   * @param audio      Float32Array PCM 音频数据 (16kHz, mono)
   * @param requestId  请求 ID（可选）
   * @returns          融合后的转录结果
   */
  async transcribe(
    audio: Float32Array,
    requestId?: string,
  ): Promise<MultiPathFusionResult> {
    const activeDecoders = this.getActiveDecoders()

    if (activeDecoders.length === 0) {
      log('WARN', 'multipath_no_active_decoders')
      return {
        text: '',
        confidence: 0,
        primaryEngine: 'none',
        decoderResults: [],
        fusionMethod: 'single',
        activeDecoderCount: 0,
        totalDecoderCount: this.decoders.size,
        degraded: false,
        fusionLatencyMs: 0,
      }
    }

    log('DEBUG', 'multipath_transcribe_start', {
      active_decoders: activeDecoders.map((d) => d.name),
      request_id: requestId,
      audio_len_s: (audio.length / 16000).toFixed(1),
    })

    // ── 并行执行 ──
    const decoderPromises = activeDecoders.map((decoder) =>
      decoder
        .transcribe(audio, { requestId })
        .catch((err): DecoderResult => ({
          name: decoder.name,
          text: '',
          confidence: 0,
          latencyMs: 0,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        })),
    )

    const decoderResults = await Promise.all(decoderPromises)

    // ── 异常处理 ──
    for (const result of decoderResults) {
      if (!result.success) {
        this.handleDecoderFailure(result.name, result.error)

        // 通过错误队列通知
        const health = this.getDecoderHealth(result.name)
        if (health && (health.state === 'crashed' || health.state === 'dead')) {
          this.emitError({
            type: this.classifyError(result.error),
            decoderName: result.name,
            timestamp: Date.now(),
            message: result.error || 'Unknown error',
          })
        }
      }
    }

    // ── 自动恢复检查 ──
    if (this.config.autoRecovery) {
      this.checkRecovery()
    }

    // ── 融合 ──
    const healths = this.getAllHealth()
    const fusionResult = this.fusion.fuse(decoderResults, healths)

    // ── 降级到单解码器（如果融合后为空但至少有一个失败结果） ──
    if (!fusionResult.text && decoderResults.some((r) => r.success && r.text)) {
      // 置信度过滤可能排除了所有结果，使用最佳置信度的原始结果
      const bestSuccess = decoderResults
        .filter((r) => r.success && r.text)
        .sort((a, b) => b.confidence - a.confidence)[0]

      if (bestSuccess) {
        log('WARN', 'multipath_fusion_empty_use_best', {
          decoder: bestSuccess.name,
          confidence: bestSuccess.confidence,
        })
        return {
          text: bestSuccess.text,
          confidence: bestSuccess.confidence,
          primaryEngine: bestSuccess.name,
          decoderResults,
          fusionMethod: 'best_confidence',
          activeDecoderCount: activeDecoders.length,
          totalDecoderCount: this.decoders.size,
          degraded: true,
          fusionLatencyMs: fusionResult.fusionLatencyMs,
        }
      }
    }

    return fusionResult
  }

  // ══════════════════════════════════════
  //  心跳检查
  // ══════════════════════════════════════

  private async performHeartbeatCheck(): Promise<void> {
    for (const [name, decoder] of this.decoders) {
      const health = decoder.getHealth()

      // 已死亡/崩溃的不再探测
      if (health.state === 'dead') continue

      try {
        const alive = await decoder.ping()

        if (!alive) {
          log('WARN', 'multipath_heartbeat_fail', {
            decoder: name,
            state: health.state,
            consecutive_failures: health.consecutiveFailures + 1,
          })

          if (health.consecutiveFailures >= this.config.maxConsecutiveFailures) {
            this.markDecoderDead(name, 'heartbeat_timeout')
          }
        }
      } catch (err) {
        log('WARN', 'multipath_heartbeat_error', {
          decoder: name,
          error: String(err),
        })
      }
    }
  }

  // ══════════════════════════════════════
  //  异常处理
  // ══════════════════════════════════════

  private handleDecoderFailure(name: string, error?: string): void {
    const decoder = this.decoders.get(name)
    if (!decoder) return

    const health = decoder.getHealth()

    if (health.state === 'crashed' || health.state === 'dead') {
      log('WARN', 'multipath_decoder_crashed', {
        decoder: name,
        state: health.state,
        consecutive_failures: health.consecutiveFailures,
        last_error: error?.slice(0, 120),
      })

      // 记录冷却时间
      this.recoveryCooldowns.set(name, Date.now() + this.config.recoveryCooldownMs)
    }
  }

  private markDecoderDead(name: string, reason: string): void {
    const decoder = this.decoders.get(name)
    if (!decoder) return

    log('WARN', 'multipath_decoder_marked_dead', {
      decoder: name,
      reason,
    })

    const health = decoder.getHealth()
    health.state = 'dead'
    health.active = false
    this.fusion.unregisterDecoder(name)
    this.recoveryCooldowns.set(name, Date.now() + this.config.recoveryCooldownMs)

    this.emitError({
      type: 'crash',
      decoderName: name,
      timestamp: Date.now(),
      message: `Decoder marked dead: ${reason}`,
    })
  }

  private classifyError(error?: string): 'crash' | 'timeout' | 'oom' | 'model_corruption' | 'unknown' {
    if (!error) return 'unknown'

    const lower = error.toLowerCase()
    if (lower.includes('oom') || lower.includes('out of memory') || lower.includes('enomem')) return 'oom'
    if (lower.includes('timeout')) return 'timeout'
    if (lower.includes('model') && (lower.includes('corrupt') || lower.includes('load') || lower.includes('not found'))) {
      return 'model_corruption'
    }
    if (lower.includes('segmentation fault') || lower.includes('cuda error') || lower.includes('crash')) return 'crash'
    return 'unknown'
  }

  private emitError(msg: { type: 'crash' | 'timeout' | 'oom' | 'model_corruption' | 'unknown'; decoderName: string; timestamp: number; message: string }): void {
    for (const cb of this.errorCallbacks) {
      try {
        cb(msg)
      } catch {
        // 回调异常不阻塞主流程
      }
    }
  }

  // ══════════════════════════════════════
  //  自动恢复
  // ══════════════════════════════════════

  private checkRecovery(): void {
    const now = Date.now()

    for (const [name, cooldownUntil] of this.recoveryCooldowns) {
      if (now < cooldownUntil) continue

      const decoder = this.decoders.get(name)
      if (!decoder) {
        this.recoveryCooldowns.delete(name)
        continue
      }

      // 尝试恢复
      log('INFO', 'multipath_decoder_recovery_attempt', { decoder: name })
      decoder.resetHealth()
      this.fusion.registerDecoder(decoder.config)
      this.recoveryCooldowns.delete(name)
    }
  }
}

// ══════════════════════════════════════════
//  单例（默认配置，未启用）
// ══════════════════════════════════════════

export const multiPathDecoderManager = new MultiPathDecoderManager()
