/**
 * RejectionTracker — 滑动窗口熔断计数器
 *
 * 跟踪 GoalGuardrail 发出的拒绝决策，在达到阈值时触发熔断。
 * 支持信用恢复机制：每次成功工具调用逐步清除一条旧记录。
 *
 * 滑动窗口：默认 60 秒窗口内的拒绝计数超过阈值 → shouldTrip() = true
 */
import { log } from '../logger/Logger'

export type RejectionReason = 'HARD_BLOCK' | 'GOAL_DRIFT' | 'RESOURCE_EXHAUSTED' | 'MAX_REJECTION_EXCEEDED'

interface RejectionRecord {
  reason: RejectionReason
  toolName: string
  timestamp: number
}

export interface RejectionTrackerConfig {
  /** 熔断阈值：窗口内记录数达到此值时触发 */
  threshold: number
  /** 滑动窗口大小（毫秒），默认 60 秒 */
  windowMs: number
}

const DEFAULT_CONFIG: RejectionTrackerConfig = {
  threshold: 3,
  windowMs: 60_000,
}

export class RejectionTracker {
  private records: RejectionRecord[] = []
  private config: RejectionTrackerConfig

  constructor(config?: Partial<RejectionTrackerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ───── 公共 API ─────

  /** 记录一次拒绝 */
  record(reason: RejectionReason, toolName: string): void {
    this.records.push({ reason, toolName, timestamp: Date.now() })
    this.prune()
    log('WARN', 'goal_guardrail_rejection', {
      reason,
      toolName,
      windowCount: this.records.length,
      threshold: this.config.threshold,
    })
  }

  /** 在当前滑动窗口内是否达到熔断阈值 */
  shouldTrip(): boolean {
    this.prune()
    return this.records.length >= this.config.threshold
  }

  /**
   * 信用恢复：每次工具成功执行后调用。
   * 从最旧的记录开始清除一条，逐步降低熔断计数器。
   */
  onToolSuccess(): void {
    this.prune()
    if (this.records.length > 0) {
      const removed = this.records.shift()!
      log('DEBUG', 'goal_guardrail_credit_restored', {
        clearedReason: removed.reason,
        remainingCount: this.records.length,
      })
    }
  }

  /** 获取当前统计信息 */
  getStats(): { count: number; reasons: RejectionReason[]; isTripped: boolean } {
    this.prune()
    return {
      count: this.records.length,
      reasons: this.records.map((r) => r.reason),
      isTripped: this.records.length >= this.config.threshold,
    }
  }

  /** 重置所有记录（跨会话时调用） */
  reset(): void {
    const prev = this.records.length
    this.records = []
    log('INFO', 'goal_guardrail_rejection_reset', { previousCount: prev })
  }

  /** 获取当前窗口内已触发的拒绝原因集合（去重） */
  getActiveReasons(): RejectionReason[] {
    this.prune()
    return [...new Set(this.records.map((r) => r.reason))]
  }

  // ───── 内部 ─────

  /** 清除超出时间窗口的旧记录 */
  private prune(): void {
    const cutoff = Date.now() - this.config.windowMs
    const before = this.records.length
    this.records = this.records.filter((r) => r.timestamp >= cutoff)
    if (before > 0 && this.records.length !== before) {
      log('DEBUG', 'goal_guardrail_window_pruned', { pruned: before - this.records.length, remaining: this.records.length })
    }
  }
}
