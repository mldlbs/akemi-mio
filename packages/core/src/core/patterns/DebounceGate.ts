/**
 * DebounceGate — 通用防抖/节流控制器
 *
 * 核心抽象：控制操作的执行频率，支持防抖（延迟执行）和节流（限制执行频率）。
 * 替代手动管理 setTimeout + 时间戳比较的模式。
 *
 * 用法：
 *   const gate = new DebounceGate({ delayMs: 500, maxFrequencyMs: 200 })
 *
 *   // 防抖模式：每次 call 重置计时器，计时结束后执行
 *   gate.call(() => save())       // 被延迟
 *   gate.call(() => save())       // 重置计时器
 *   // 500ms 后执行一次 save()
 *
 *   // 节流模式：限制某操作每 2 秒最多执行一次
 *   const throttle = new DebounceGate({ maxFrequencyMs: 2000 })
 *   throttle.throttle(() => log())  // 执行
 *   throttle.throttle(() => log())  // 被跳过（不足 2 秒）
 *
 * 设计原则：
 * - 无偏见：不依赖具体领域逻辑
 * - 零成本抽象：不使用额外定时器，纯时间戳比较
 * - 可组合：支持同时使用防抖 + 节流
 *
 * 来源分析（PiperOrchestrator + DualModeController）：
 * - DualModeController: SWITCH_DEBOUNCE_MS (30s), MIN_SWITCH_INTERVAL_MS (10s), EVALUATION_INTERVAL_MS (5s)
 * - PiperOrchestrator: 隐式节流（队列串行处理，但无显式时间控制）
 */
import { log } from '@akemi-mio/core/logger/Logger'

// ── 类型 ──

/** DebounceGate 配置 */
export interface DebounceGateOptions {
  /** 防抖延迟 ms（默认 0 = 不防抖） */
  delayMs?: number
  /** 最小执行间隔 ms（默认 0 = 不节流） */
  maxFrequencyMs?: number
  /** 日志分类名 */
  loggerName?: string
}

/** 门控状态 */
export interface GateStatus {
  /** 是否有待执行的防抖任务 */
  pending: boolean
  /** 距上次实际执行的时间 ms */
  timeSinceLastExecutionMs: number
  /** 距上次 call 的时间 ms */
  timeSinceLastCallMs: number
  /** 是否在节流中 */
  throttled: boolean
}

// ── 核心类 ──

export class DebounceGate {
  private readonly delayMs: number
  private readonly maxFrequencyMs: number
  private readonly loggerName: string

  /** 防抖计时器 */
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 上次实际执行时间戳 */
  private lastExecutionTime = 0
  /** 上次 call 时间戳 */
  private lastCallTime = 0
  /** 待执行的防抖函数 */
  private pendingFn: (() => void) | null = null

  constructor(options?: DebounceGateOptions) {
    this.delayMs = options?.delayMs ?? 0
    this.maxFrequencyMs = options?.maxFrequencyMs ?? 0
    this.loggerName = options?.loggerName ?? 'debounce_gate'
  }

  // ── 防抖模式 ──

  /**
   * 防抖调用：每次 call 重置计时器。
   * 仅在距上次 call 超过 delayMs 且不处于节流状态时执行。
   *
   * @param fn 要执行的函数
   * @param immediate 是否立即执行第一次（默认 false）
   */
  call(fn: () => void, immediate = false): void {
    this.lastCallTime = Date.now()
    this.pendingFn = fn

    if (this.delayMs <= 0) {
      // 不防抖 → 直接受节流控制
      this.executeIfNotThrottled(fn)
      return
    }

    // 立即执行模式：第一次立即执行，后续防抖
    if (immediate && !this.timer && !this.isThrottled()) {
      this.execute(fn)
      return
    }

    // 重置防抖计时器
    if (this.timer) {
      clearTimeout(this.timer)
    }

    this.timer = setTimeout(() => {
      this.timer = null
      if (this.pendingFn) {
        this.executeIfNotThrottled(this.pendingFn)
        this.pendingFn = null
      }
    }, this.delayMs)
  }

  // ── 节流模式 ──

  /**
   * 节流调用：如果距上次执行不足 maxFrequencyMs，则跳过。
   *
   * @param fn 要执行的函数
   * @returns 是否实际执行了
   */
  throttle(fn: () => void): boolean {
    if (this.isThrottled()) {
      log('DEBUG', `${this.loggerName}_throttled`, {
        timeSinceLastExecution: Date.now() - this.lastExecutionTime,
        maxFrequencyMs: this.maxFrequencyMs,
      })
      return false
    }

    this.execute(fn)
    return true
  }

  // ── 状态管理 ──

  /**
   * 重置门控状态（清除待执行任务和定时器）。
   */
  reset(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pendingFn = null
    this.lastCallTime = 0
    this.lastExecutionTime = 0
  }

  /** 是否正在等防抖延迟 */
  isPending(): boolean {
    return this.timer !== null
  }

  /** 获取当前门控状态 */
  getStatus(): GateStatus {
    return {
      pending: this.isPending(),
      timeSinceLastExecutionMs: this.lastExecutionTime > 0 ? Date.now() - this.lastExecutionTime : -1,
      timeSinceLastCallMs: this.lastCallTime > 0 ? Date.now() - this.lastCallTime : -1,
      throttled: this.isThrottled(),
    }
  }

  /**
   * 标记一次执行时间（不实际执行任何函数）。
   * 用于仅需要记录时间戳的场景（如条件评估中的节流标记）。
   */
  markExecution(): void {
    this.lastExecutionTime = Date.now()
  }

  // ── 内部 ──

  /**
   * 判断当前是否在节流中。
   * 公开暴露供外部仅查询不执行时使用（如条件评估中的节流判断）。
   */
  isThrottled(): boolean {
    if (this.maxFrequencyMs <= 0) return false
    return Date.now() - this.lastExecutionTime < this.maxFrequencyMs
  }

  /**
   * 执行函数（如果不在节流状态）。
   */
  private executeIfNotThrottled(fn: () => void): void {
    if (!this.isThrottled()) {
      this.execute(fn)
    }
  }

  /**
   * 执行函数并记录时间。
   */
  private execute(fn: () => void): void {
    this.lastExecutionTime = Date.now()
    try {
      fn()
    } catch (e) {
      log('WARN', `${this.loggerName}_execute_error`, {
        error: String(e).slice(0, 100),
      })
    }
  }
}
