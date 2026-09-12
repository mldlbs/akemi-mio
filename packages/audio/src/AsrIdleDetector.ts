/**
 * AsrIdleDetector — ASR 空闲检测器
 *
 * 监控最后一次语音活动时间，当超过空闲阈值时触发回调。
 * 语音活动包括：语音输入、ASR 识别、用户反馈纠正等。
 *
 * 集成点：
 * - AsrService.transcribe() 每次识别后调用 recordActivity()
 * - AsrService.feedback() 每次用户反馈后调用 recordActivity()
 * - 空闲时触发 AsrFeedbackAnalyzer.analyzeAndOptimize()
 *
 * 安全机制：
 * - 空闲仅触发一次（标记为已触发），下次活动后重置
 * - 支持运行时调整空闲阈值
 * - 空闲回调异常不会影响检测器本身
 */

import { log } from '@akemi-mio/core/logger/Logger'

type IdleCallback = () => void

export class AsrIdleDetector {
  private lastActivityTime: number = Date.now()
  private idleThresholdMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private callbacks: IdleCallback[] = []
  private _isIdle = false
  private _isRunning = false
  /** 空闲是否已被消费（单次触发），活动后重置 */
  private idleConsumed = false

  /**
   * @param idleMinutes 空闲阈值（分钟），默认 30
   */
  constructor(idleMinutes = 30) {
    this.idleThresholdMs = idleMinutes * 60 * 1000
  }

  // ── 活动记录 ──

  /**
   * 记录一次语音活动，重置空闲计时器。
   * 每次 ASR 识别或用户反馈完成后调用。
   */
  recordActivity(): void {
    this.lastActivityTime = Date.now()
    if (this._isIdle) {
      this._isIdle = false
      log('INFO', 'asr_idle_interrupted', {
        idleMs: Date.now() - this.lastActivityTime,
      })
    }
    this.idleConsumed = false
    this.resetTimer()
  }

  // ── 回调管理 ──

  /** 注册空闲回调 */
  onIdle(callback: IdleCallback): void {
    this.callbacks.push(callback)
  }

  /** 移除空闲回调 */
  offIdle(callback: IdleCallback): void {
    this.callbacks = this.callbacks.filter((cb) => cb !== callback)
  }

  // ── 生命周期 ──

  /** 启动空闲监控 */
  start(): void {
    if (this._isRunning) return
    this._isRunning = true
    this.lastActivityTime = Date.now()
    this._isIdle = false
    this.idleConsumed = false
    this.resetTimer()
    log('INFO', 'asr_idle_detector_started', {
      thresholdMs: this.idleThresholdMs,
    })
  }

  /** 停止空闲监控 */
  stop(): void {
    if (!this._isRunning) return
    this._isRunning = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    log('INFO', 'asr_idle_detector_stopped')
  }

  // ── 查询 ──

  /** 获取距离上一次活动的时间（毫秒） */
  getIdleDuration(): number {
    return Date.now() - this.lastActivityTime
  }

  /** 是否处于空闲状态 */
  get isIdle(): boolean {
    return this._isIdle
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this._isRunning
  }

  /** 获取空闲阈值（毫秒） */
  get idleThreshold(): number {
    return this.idleThresholdMs
  }

  /** 设置空闲阈值（分钟），运行时生效 */
  setIdleThreshold(minutes: number): void {
    this.idleThresholdMs = minutes * 60 * 1000
    if (this._isRunning && !this._isIdle) {
      this.resetTimer()
    }
    log('INFO', 'asr_idle_threshold_updated', {
      minutes,
      ms: this.idleThresholdMs,
    })
  }

  // ── 内部 ──

  private resetTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this._isRunning) return

    this.timer = setTimeout(() => {
      if (!this._isRunning) return
      this._isIdle = true
      this.idleConsumed = false

      log('INFO', 'asr_idle_detected', {
        idleDurationMs: this.idleThresholdMs,
        callbacks: this.callbacks.length,
      })

      for (const cb of this.callbacks) {
        try {
          cb()
        } catch (err) {
          log('ERROR', 'asr_idle_callback_failed', {
            error: String(err),
          })
        }
      }
    }, this.idleThresholdMs)
  }
}
