/**
 * ThresholdTracker — 阈值计数器 / 连续失败跟踪器
 *
 * 核心抽象：追踪连续事件次数，在达到预设阈值时触发对应动作。
 * 替代各模块中分散的 consecutiveError 计数器 + if-else 阈值判断。
 *
 * 用法：
 *   const tracker = new ThresholdTracker()
 *   tracker.addThreshold(3, () => injectDiagnostic())
 *   tracker.addThreshold(5, () => stopExecution())
 *
 *   tracker.increment()  // 内部计数 +1，达到阈值时自动触发
 *   tracker.reset()      // 重置计数
 *
 * 设计原则：
 * - 无偏见：不关心计数的是什么事件，只提供阈值触发机制
 * - 阈值仅触发一次：达到阈值后不会重复触发，reset 后会重新计数
 * - 支持同步和异步动作
 *
 * 来源分析（Guardrail + EvolutionExecutor）：
 * - Guardrail.checkConsecutiveToolErrors() — 3次注入诊断、5次中断
 * - EvolutionExecutor.planExecConsecutiveErrors — 3次放弃计划
 * - Guardrail.checkConsecutiveReadOnlyErrors() — 3次切换策略
 * - RunContext 中的 consecutiveTimeouts / consecutiveToolErrors 等计数器
 */

import { log } from '@akemi-mio/core/logger/Logger'

// ── 类型 ──

export interface ThresholdAction {
  /** 触发阈值（必须 >= 1） */
  threshold: number
  /** 达到阈值时的回调 */
  action: () => void | Promise<void>
  /** 动作名称（日志用） */
  name?: string
}

export interface ThresholdTrackerOptions {
  /** 日志分类名前缀 */
  loggerName?: string
}

// ── 核心类 ──

export class ThresholdTracker {
  private count = 0
  private readonly thresholds: ThresholdAction[] = []
  /** 已触发的阈值集合（threshold 值），reset 时清空 */
  private firedThresholds = new Set<number>()
  private readonly loggerName: string

  constructor(options?: ThresholdTrackerOptions) {
    this.loggerName = options?.loggerName ?? 'threshold_tracker'
  }

  // ── 配置 ──

  /**
   * 添加一个阈值动作。
   * 阈值应按升序添加，但 addThreshold 会自动排序。
   */
  addThreshold(threshold: number, action: () => void | Promise<void>, name?: string): void {
    if (threshold < 1) {
      log('WARN', `${this.loggerName}_invalid_threshold`, { threshold })
      return
    }
    this.thresholds.push({ threshold, action, name })
    this.thresholds.sort((a, b) => a.threshold - b.threshold)
  }

  /**
   * 批量设置阈值动作（覆盖已有）。
   */
  setThresholds(actions: ThresholdAction[]): void {
    this.thresholds.length = 0
    for (const a of actions) {
      this.addThreshold(a.threshold, a.action, a.name)
    }
  }

  // ── 操作 ──

  /** 递增计数，检查是否达到任何未触发的阈值 */
  increment(): number {
    this.count++

    for (const t of this.thresholds) {
      if (this.count >= t.threshold && !this.firedThresholds.has(t.threshold)) {
        this.firedThresholds.add(t.threshold)
        const name = t.name ?? `threshold_${t.threshold}`
        log('INFO', `${this.loggerName}_triggered`, {
          threshold: t.threshold,
          count: this.count,
          name,
        })

        // 同步执行 action（如果返回 Promise 则 await，但这里不阻塞后续阈值检查）
        const result = t.action()
        if (result instanceof Promise) {
          result.catch((err) => {
            log('WARN', `${this.loggerName}_action_failed`, {
              threshold: t.threshold,
              error: String(err),
            })
          })
        }
      }
    }

    return this.count
  }

  /** 重置计数和已触发阈值 */
  reset(): void {
    this.count = 0
    this.firedThresholds.clear()
  }

  /** 重置计数但保留已触发阈值的记录（用于需要升级的场景） */
  resetCount(): void {
    this.count = 0
  }

  /** 获取当前计数 */
  getCount(): number {
    return this.count
  }

  /** 检查指定阈值是否已触发过 */
  hasFired(threshold: number): boolean {
    return this.firedThresholds.has(threshold)
  }

  /** 获取所有已触发的阈值（排序） */
  getFiredThresholds(): number[] {
    return Array.from(this.firedThresholds).sort((a, b) => a - b)
  }

  /** 获取尚未触发的最近阈值（用于日志/诊断） */
  getNextThreshold(): number | null {
    for (const t of this.thresholds) {
      if (!this.firedThresholds.has(t.threshold)) {
        return t.threshold
      }
    }
    return null
  }

  /** 获取最大阈值级别（已触发的最高级别） */
  getMaxFiredLevel(): number {
    const fired = this.getFiredThresholds()
    return fired.length > 0 ? fired[fired.length - 1] : 0
  }

  /** 是否达到最高阈值并已触发 */
  isMaxFired(): boolean {
    if (this.thresholds.length === 0) return false
    const maxThreshold = this.thresholds[this.thresholds.length - 1].threshold
    return this.firedThresholds.has(maxThreshold)
  }
}

// ── 便捷工厂 ──

/**
 * 创建一个带标准动作的跟踪器（用于连续错误场景）。
 *
 * 示例：
 *   const tracker = createErrorTracker(
 *     [
 *       { threshold: 3, action: () => injectDiagnostic(), name: 'diagnostic' },
 *       { threshold: 5, action: () => stopExecution(), name: 'stop' },
 *     ],
 *     'tool_errors',
 *   )
 */
export function createThresholdTracker(
  thresholds: Array<{ threshold: number; action: () => void | Promise<void>; name?: string }>,
  loggerName?: string,
): ThresholdTracker {
  const tracker = new ThresholdTracker({ loggerName })
  for (const t of thresholds) {
    tracker.addThreshold(t.threshold, t.action, t.name)
  }
  return tracker
}
