/**
 * DecoderInstance — ASR 解码器实例包装器
 *
 * 将 WhisperGPU、WhisperCPU、Baidu 等现有引擎包装为统一的 IDecoderInstance 接口，
 * 供 MultiPathDecoderManager 透明管理。
 *
 * 每个 DecoderInstance 负责：
 * 1. 维护自身的健康计数器（成功/失败/延迟统计）
 * 2. 封装引擎特定的转录调用与异常转换
 * 3. 提供心跳探测（ping）支持
 * 4. 滑动窗口历史准确率计算
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { WhisperGpuEngine } from '../WhisperGpuEngine'
import type { WhisperEngine } from '../WhisperEngine'
import type { BaiduEngine } from '../BaiduEngine'
import { asrConfidenceScorer } from '../AsrConfidenceScorer'
import type { AudioFeatures } from '.././types'
import type { DecoderBackend, DecoderConfig, DecoderHealth, DecoderHealthState, DecoderResult, IDecoderInstance } from './types'

// ══════════════════════════════════════════
//  滑动窗口参数
// ══════════════════════════════════════════

/** 历史准确率滑动窗口大小 */
const HISTORY_WINDOW_SIZE = 20

/** 默认解码器超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 15000

// ══════════════════════════════════════════
//  WhisperGPU 解码器实例
// ══════════════════════════════════════════

export class WhisperGpuDecoderInstance implements IDecoderInstance {
  readonly name: string
  readonly backend: DecoderBackend = 'whisper_gpu'
  readonly config: DecoderConfig

  private engine: WhisperGpuEngine
  private health: DecoderHealth
  private accuracyHistory: boolean[] = []

  constructor(engine: WhisperGpuEngine, config: DecoderConfig) {
    this.engine = engine
    this.config = { ...config }
    this.name = config.name
    this.health = this.createInitialHealth()
  }

  getModelInfo(): string {
    return this.engine.getModelInfo()
  }

  async transcribe(audio: Float32Array, options?: { timeoutMs?: number; requestId?: string }): Promise<DecoderResult> {
    const t0 = Date.now()
    this.health.totalCalls++

    try {
      const timeout = options?.timeoutMs ?? this.config.timeoutMs
      const result = await this.engine.transcribe(audio, timeout)

      const latencyMs = Date.now() - t0
      const confidence = asrConfidenceScorer.score(result.text) + this.config.confidenceBias
      const clampedConfidence = Math.max(0, Math.min(1, confidence))

      // 更新健康状态
      this.health.successfulCalls++
      this.health.consecutiveFailures = 0
      this.health.lastHeartbeat = Date.now()
      this.health.lastError = null
      this.health.averageLatency = this.updateMovingAverage(this.health.averageLatency, latencyMs, 10)
      this.health.state = this.determineHealthState()
      this.accuracyHistory.push(true)
      this.trimHistory()
      this.health.historicalAccuracy = this.computeHistoricalAccuracy()

      // 检查文本是否为空或噪声
      const isValidText = result.text && result.text.trim().length > 0

      return {
        name: this.name,
        text: result.text,
        confidence: isValidText ? clampedConfidence : 0,
        latencyMs,
        success: true,
        timestamp: Date.now(),
      }
    } catch (err) {
      const latencyMs = Date.now() - t0
      const msg = err instanceof Error ? err.message : String(err)

      this.health.consecutiveFailures++
      this.health.lastHeartbeat = Date.now()
      this.health.lastError = msg

      // 判断是否为严重异常
      if (this.isFatalError(msg)) {
        this.health.state = 'crashed'
      } else {
        this.health.state = this.determineHealthState()
      }

      this.accuracyHistory.push(false)
      this.trimHistory()
      this.health.historicalAccuracy = this.computeHistoricalAccuracy()

      log('WARN', 'multipath_decoder_failure', {
        decoder: this.name,
        consecutive_failures: this.health.consecutiveFailures,
        error: msg.slice(0, 120),
        latency_ms: latencyMs,
      })

      return {
        name: this.name,
        text: '',
        confidence: 0,
        latencyMs,
        success: false,
        error: msg,
        timestamp: Date.now(),
      }
    }
  }

  getHealth(): DecoderHealth {
    return { ...this.health }
  }

  resetHealth(): void {
    this.health = this.createInitialHealth()
    this.accuracyHistory = []
    log('INFO', 'multipath_decoder_reset', { decoder: this.name })
  }

  async ping(): Promise<boolean> {
    try {
      const status = this.engine.getStatus()
      const loaded = status.loaded && !status.error

      if (loaded) {
        this.health.lastHeartbeat = Date.now()
        // degraded 状态下恢复为 healthy
        if (this.health.state === 'degraded') {
          this.health.state = 'healthy'
        }
      }
      return loaded
    } catch {
      this.health.consecutiveFailures++
      if (this.health.state === 'healthy') {
        this.health.state = 'degraded'
      }
      return false
    }
  }

  async destroy(): Promise<void> {
    log('INFO', 'multipath_decoder_destroy', { decoder: this.name })
    // GPU 引擎由外部管理生命周期，此处仅标记
    this.health.state = 'dead'
    this.health.active = false
  }

  // ── 私有方法 ──

  private createInitialHealth(): DecoderHealth {
    return {
      name: this.name,
      state: 'healthy',
      consecutiveFailures: 0,
      lastHeartbeat: Date.now(),
      lastError: null,
      totalCalls: 0,
      successfulCalls: 0,
      averageLatency: 0,
      historicalAccuracy: 1.0,
      active: true,
    }
  }

  private determineHealthState(): DecoderHealthState {
    if (this.health.consecutiveFailures >= 5) return 'dead'
    if (this.health.consecutiveFailures >= 2) {
      return this.health.state === 'crashed' ? 'crashed' : 'degraded'
    }
    return 'healthy'
  }

  private isFatalError(msg: string): boolean {
    const fatal = ['OOM', 'out of memory', 'ENOMEM', 'CUDA error', 'model corrupted', 'segmentation fault']
    return fatal.some((keyword) => msg.toLowerCase().includes(keyword.toLowerCase()))
  }

  private updateMovingAverage(current: number, newValue: number, windowSize: number): number {
    if (current === 0) return newValue
    return current * (1 - 1 / windowSize) + newValue * (1 / windowSize)
  }

  private computeHistoricalAccuracy(): number {
    if (this.accuracyHistory.length === 0) return 1.0
    const recent = this.accuracyHistory.slice(-HISTORY_WINDOW_SIZE)
    return recent.filter(Boolean).length / recent.length
  }

  private trimHistory(): void {
    if (this.accuracyHistory.length > HISTORY_WINDOW_SIZE * 2) {
      this.accuracyHistory = this.accuracyHistory.slice(-HISTORY_WINDOW_SIZE)
    }
  }
}

// ══════════════════════════════════════════
//  WhisperCPU 解码器实例
// ══════════════════════════════════════════

export class WhisperCpuDecoderInstance implements IDecoderInstance {
  readonly name: string
  readonly backend: DecoderBackend = 'whisper_cpu'
  readonly config: DecoderConfig

  private engine: WhisperEngine
  private health: DecoderHealth
  private accuracyHistory: boolean[] = []

  constructor(engine: WhisperEngine, config: DecoderConfig) {
    this.engine = engine
    this.config = { ...config }
    this.name = config.name
    this.health = this.createInitialHealth()
  }

  getModelInfo(): string {
    return this.engine.getModelInfo()
  }

  async transcribe(audio: Float32Array, options?: { timeoutMs?: number; requestId?: string }): Promise<DecoderResult> {
    const t0 = Date.now()
    this.health.totalCalls++

    try {
      const timeout = options?.timeoutMs ?? this.config.timeoutMs
      const rid = options?.requestId
      const result = await this.engine.transcribe(audio, timeout, rid)

      const latencyMs = Date.now() - t0
      const confidence = asrConfidenceScorer.score(result.text) + this.config.confidenceBias
      const clampedConfidence = Math.max(0, Math.min(1, confidence))

      this.health.successfulCalls++
      this.health.consecutiveFailures = 0
      this.health.lastHeartbeat = Date.now()
      this.health.lastError = null
      this.health.averageLatency = this.updateMovingAverage(this.health.averageLatency, latencyMs, 10)
      this.health.state = this.determineHealthState()
      this.accuracyHistory.push(true)
      this.trimHistory()
      this.health.historicalAccuracy = this.computeHistoricalAccuracy()

      const isValidText = result.text && result.text.trim().length > 0

      return {
        name: this.name,
        text: result.text,
        confidence: isValidText ? clampedConfidence : 0,
        latencyMs,
        success: true,
        timestamp: Date.now(),
      }
    } catch (err) {
      const latencyMs = Date.now() - t0
      const msg = err instanceof Error ? err.message : String(err)

      this.health.consecutiveFailures++
      this.health.lastHeartbeat = Date.now()
      this.health.lastError = msg

      if (this.isFatalError(msg)) {
        this.health.state = 'crashed'
      } else {
        this.health.state = this.determineHealthState()
      }

      this.accuracyHistory.push(false)
      this.trimHistory()
      this.health.historicalAccuracy = this.computeHistoricalAccuracy()

      log('WARN', 'multipath_decoder_failure', {
        decoder: this.name,
        error: msg.slice(0, 120),
        latency_ms: latencyMs,
      })

      return {
        name: this.name,
        text: '',
        confidence: 0,
        latencyMs,
        success: false,
        error: msg,
        timestamp: Date.now(),
      }
    }
  }

  getHealth(): DecoderHealth {
    return { ...this.health }
  }

  resetHealth(): void {
    this.health = this.createInitialHealth()
    this.accuracyHistory = []
  }

  async ping(): Promise<boolean> {
    try {
      const status = this.engine.getStatus()
      const loaded = status.loaded && !status.error

      if (loaded) {
        this.health.lastHeartbeat = Date.now()
        if (this.health.state === 'degraded') {
          this.health.state = 'healthy'
        }
      }
      return loaded
    } catch {
      this.health.consecutiveFailures++
      if (this.health.state === 'healthy') {
        this.health.state = 'degraded'
      }
      return false
    }
  }

  async destroy(): Promise<void> {
    log('INFO', 'multipath_decoder_destroy', { decoder: this.name })
    this.health.state = 'dead'
    this.health.active = false
  }

  private createInitialHealth(): DecoderHealth {
    return {
      name: this.name,
      state: 'healthy',
      consecutiveFailures: 0,
      lastHeartbeat: Date.now(),
      lastError: null,
      totalCalls: 0,
      successfulCalls: 0,
      averageLatency: 0,
      historicalAccuracy: 1.0,
      active: true,
    }
  }

  private determineHealthState(): DecoderHealthState {
    if (this.health.consecutiveFailures >= 5) return 'dead'
    if (this.health.consecutiveFailures >= 2) return this.health.state === 'crashed' ? 'crashed' : 'degraded'
    return 'healthy'
  }

  private isFatalError(msg: string): boolean {
    const fatal = ['OOM', 'out of memory', 'ENOMEM', 'model corrupted', 'segmentation fault']
    return fatal.some((keyword) => msg.toLowerCase().includes(keyword.toLowerCase()))
  }

  private updateMovingAverage(current: number, newValue: number, windowSize: number): number {
    if (current === 0) return newValue
    return current * (1 - 1 / windowSize) + newValue * (1 / windowSize)
  }

  private computeHistoricalAccuracy(): number {
    if (this.accuracyHistory.length === 0) return 1.0
    const recent = this.accuracyHistory.slice(-HISTORY_WINDOW_SIZE)
    return recent.filter(Boolean).length / recent.length
  }

  private trimHistory(): void {
    if (this.accuracyHistory.length > HISTORY_WINDOW_SIZE * 2) {
      this.accuracyHistory = this.accuracyHistory.slice(-HISTORY_WINDOW_SIZE)
    }
  }
}

// ══════════════════════════════════════════
//  Baidu 解码器实例
// ══════════════════════════════════════════

export class BaiduDecoderInstance implements IDecoderInstance {
  readonly name: string
  readonly backend: DecoderBackend = 'baidu'
  readonly config: DecoderConfig

  private engine: BaiduEngine
  private apiKey: string
  private secretKey: string
  private health: DecoderHealth
  private accuracyHistory: boolean[] = []

  constructor(engine: BaiduEngine, config: DecoderConfig, apiKey?: string, secretKey?: string) {
    this.engine = engine
    this.config = { ...config }
    this.name = config.name
    this.apiKey = apiKey ?? ''
    this.secretKey = secretKey ?? ''
    this.health = this.createInitialHealth()
  }

  /** 设置百度 API 凭证 */
  setCredentials(apiKey: string, secretKey: string): void {
    this.apiKey = apiKey
    this.secretKey = secretKey
  }

  get hasCredentials(): boolean {
    return !!(this.apiKey && this.secretKey)
  }

  getModelInfo(): string {
    return `baidu_asr (cloud, dev_pid=1537)`
  }

  async transcribe(audio: Float32Array, options?: { timeoutMs?: number; requestId?: string }): Promise<DecoderResult> {
    const t0 = Date.now()
    this.health.totalCalls++

    // 百度 API 需要 Int16 PCM Buffer
    const int16 = new Int16Array(audio.length)
    for (let i = 0; i < audio.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32768)))
    }
    const pcmBuffer = Buffer.from(int16.buffer)

    try {
      if (!this.hasCredentials) {
        throw new Error('Baidu API credentials not configured')
      }

      const text = await this.engine.transcribe(pcmBuffer, this.apiKey, this.secretKey)

      const latencyMs = Date.now() - t0
      const confidence = asrConfidenceScorer.score(text) + this.config.confidenceBias
      const clampedConfidence = Math.max(0, Math.min(1, confidence))

      this.health.successfulCalls++
      this.health.consecutiveFailures = 0
      this.health.lastHeartbeat = Date.now()
      this.health.lastError = null
      this.health.averageLatency = this.updateMovingAverage(this.health.averageLatency, latencyMs, 10)
      this.health.state = this.determineHealthState()
      this.accuracyHistory.push(true)
      this.trimHistory()
      this.health.historicalAccuracy = this.computeHistoricalAccuracy()

      const isValidText = text && text.trim().length > 0

      return {
        name: this.name,
        text,
        confidence: isValidText ? clampedConfidence : 0,
        latencyMs,
        success: true,
        timestamp: Date.now(),
      }
    } catch (err) {
      const latencyMs = Date.now() - t0
      const msg = err instanceof Error ? err.message : String(err)

      this.health.consecutiveFailures++
      this.health.lastHeartbeat = Date.now()
      this.health.lastError = msg

      if (this.isFatalError(msg)) {
        this.health.state = 'crashed'
      } else {
        this.health.state = this.determineHealthState()
      }

      this.accuracyHistory.push(false)
      this.trimHistory()
      this.health.historicalAccuracy = this.computeHistoricalAccuracy()

      log('WARN', 'multipath_decoder_failure', {
        decoder: this.name,
        error: msg.slice(0, 120),
        latency_ms: latencyMs,
      })

      return {
        name: this.name,
        text: '',
        confidence: 0,
        latencyMs,
        success: false,
        error: msg,
        timestamp: Date.now(),
      }
    }
  }

  getHealth(): DecoderHealth {
    return { ...this.health }
  }

  resetHealth(): void {
    this.health = this.createInitialHealth()
    this.accuracyHistory = []
  }

  async ping(): Promise<boolean> {
    try {
      if (!this.hasCredentials) {
        this.health.lastError = 'credentials not configured'
        return false
      }
      // 百度引擎无持久连接，凭据有效即视为 alive
      this.health.lastHeartbeat = Date.now()
      if (this.health.state === 'degraded') {
        this.health.state = 'healthy'
      }
      return true
    } catch {
      this.health.consecutiveFailures++
      return false
    }
  }

  async destroy(): Promise<void> {
    log('INFO', 'multipath_decoder_destroy', { decoder: this.name })
    this.health.state = 'dead'
    this.health.active = false
  }

  private createInitialHealth(): DecoderHealth {
    return {
      name: this.name,
      state: this.hasCredentials ? 'healthy' : 'degraded',
      consecutiveFailures: 0,
      lastHeartbeat: Date.now(),
      lastError: null,
      totalCalls: 0,
      successfulCalls: 0,
      averageLatency: 0,
      historicalAccuracy: 1.0,
      active: this.hasCredentials,
    }
  }

  private determineHealthState(): DecoderHealthState {
    if (this.health.consecutiveFailures >= 5) return 'dead'
    if (this.health.consecutiveFailures >= 2) return this.health.state === 'crashed' ? 'crashed' : 'degraded'
    return 'healthy'
  }

  private isFatalError(msg: string): boolean {
    const fatal = ['OOM', 'out of memory', 'ENOMEM', 'model corrupted', 'network error']
    return fatal.some((keyword) => msg.toLowerCase().includes(keyword.toLowerCase()))
  }

  private updateMovingAverage(current: number, newValue: number, windowSize: number): number {
    if (current === 0) return newValue
    return current * (1 - 1 / windowSize) + newValue * (1 / windowSize)
  }

  private computeHistoricalAccuracy(): number {
    if (this.accuracyHistory.length === 0) return 1.0
    const recent = this.accuracyHistory.slice(-HISTORY_WINDOW_SIZE)
    return recent.filter(Boolean).length / recent.length
  }

  private trimHistory(): void {
    if (this.accuracyHistory.length > HISTORY_WINDOW_SIZE * 2) {
      this.accuracyHistory = this.accuracyHistory.slice(-HISTORY_WINDOW_SIZE)
    }
  }
}
