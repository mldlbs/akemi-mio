/**
 * ToolErrorAggregator — 多工具错误聚合器
 *
 * 职责：
 * 1. 收集一批并行工具调用的结果和异常
 * 2. 按错误类型和上下文分类每个失败
 * 3. 区分可恢复错误（网络超时 → 自动重试/回退）和不可恢复错误
 * 4. 提供批量级别的结果聚合，供下游决策
 *
 * 数据流：
 *   ToolScheduler.executeAll()
 *     → 每个工具调用产生 ToolResult
 *     → push to SharedResultQueue
 *     → Aggregator.aggregateBatch() 批量分析
 *     → 对可恢复错误，生成 FallbackAction 建议
 *
 * 与 ToolErrorType 的关系：
 * - ToolErrorType 对单条错误消息分类（底层）
 * - ToolErrorAggregator 在批量级别组合这些分类（上层）
 */

import { log } from '../logger/Logger'
import { classifyToolError, ToolErrorType } from './ToolErrorType'
import type { FallbackSuggestion } from './ToolFallbackRegistry'

/**
 * 最小工具结果接口，避免循环依赖 (agent/ToolScheduler → tool/ToolErrorAggregator → agent/ToolScheduler)。
 * 与完整的 ToolResult (agent/ToolScheduler) 兼容。
 */
export interface MinimalToolResult {
  id: string
  name: string
  success: boolean
  content: string
  error?: string
  latencyMs: number
}

// =============================================================================
// 类型定义
// =============================================================================

/** 单次工具执行事件（写入共享队列的条目） */
export interface ToolExecutionEvent {
  /** 工具调用 ID */
  callId: string
  /** 工具名 */
  toolName: string
  /** 执行参数 */
  args: Record<string, any>
  /** 是否成功 */
  success: boolean
  /** 结果文本（成功时） */
  result?: string
  /** 错误消息（失败时） */
  error?: string
  /** 错误分类 */
  errorType: ToolErrorType
  /** 耗时（毫秒） */
  latencyMs: number
  /** 事件时间戳 */
  timestamp: number
  /** 属于哪个批次 */
  batchId: string
}

/** 批量执行结果摘要 */
export interface AggregatedBatchResult {
  /** 批次 ID */
  batchId: string
  /** 总调用数 */
  totalCalls: number
  /** 成功数 */
  successCount: number
  /** 失败数 */
  failureCount: number
  /** 成功率 (0-1) */
  successRate: number
  /** 整体错误类型分布 */
  errorTypeDistribution: Record<string, number>
  /** 可恢复失败的详情 */
  recoverableFailures: ToolExecutionEvent[]
  /** 不可恢复失败的详情 */
  unrecoverableFailures: ToolExecutionEvent[]
  /** 所有事件 */
  events: ToolExecutionEvent[]
  /** 是否需要回退 */
  needsFallback: boolean
  /** 批量级别的建议 */
  batchAdvice: BatchAdvice
}

/** 批量级别建议 */
export type BatchAdvice =
  | { action: 'all_ok' }
  | { action: 'retry_recoverable'; failedTools: string[]; reason: string }
  | { action: 'fallback_needed'; failedTools: Array<{ primary: string; suggestion: FallbackSuggestion }>; reason: string }
  | { action: 'partial_failure'; failedTools: string[]; reason: string }
  | { action: 'critical_failure'; failedTools: string[]; reason: string }

// =============================================================================
// SharedResultQueue — 共享结果队列
// =============================================================================

/**
 * 线程安全的异步结果队列。
 * 收集所有并行工具调用的结果和异常。
 * 支持按批次查询和消费。
 */
export class SharedResultQueue {
  private events: ToolExecutionEvent[] = []
  private maxSize: number

  constructor(maxSize: number = 500) {
    this.maxSize = maxSize
  }

  /**
   * 向队列推入一个执行事件
   */
  push(event: Omit<ToolExecutionEvent, 'timestamp'>): void {
    const fullEvent: ToolExecutionEvent = {
      ...event,
      timestamp: Date.now(),
    }
    this.events.push(fullEvent)

    // 超出上限时丢弃最旧的事件
    if (this.events.length > this.maxSize) {
      this.events.splice(0, this.events.length - this.maxSize)
    }
  }

  /**
   * 从队列中消费指定批次的所有事件。
   * 返回后从队列中移除这些事件。
   */
  consumeBatch(batchId: string): ToolExecutionEvent[] {
    const consumed: ToolExecutionEvent[] = []
    const remaining: ToolExecutionEvent[] = []

    for (const event of this.events) {
      if (event.batchId === batchId) {
        consumed.push(event)
      } else {
        remaining.push(event)
      }
    }

    this.events = remaining
    return consumed
  }

  /**
   * 获取指定批次的事件（不消费，保留在队列中）
   */
  peekBatch(batchId: string): ToolExecutionEvent[] {
    return this.events.filter((e) => e.batchId === batchId)
  }

  /**
   * 获取所有未消费的事件
   */
  peekAll(): ToolExecutionEvent[] {
    return [...this.events]
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.events = []
  }

  /**
   * 获取队列长度
   */
  get size(): number {
    return this.events.length
  }
}

// =============================================================================
// ToolErrorAggregator
// =============================================================================

export class ToolErrorAggregator {
  private resultQueue: SharedResultQueue
  private batchCounter = 0

  // 不可恢复的错误类型（触发降级链终结）
  private static readonly UNRECOVERABLE_TYPES = new Set([
    ToolErrorType.TOOL_MISSING,
    ToolErrorType.MCP_ERROR,
    ToolErrorType.PERMISSION,
  ])

  // 可恢复的错误类型（可触发回退）
  private static readonly RECOVERABLE_TYPES = new Set([
    ToolErrorType.TRANSIENT,
    ToolErrorType.ENVIRONMENT,
    ToolErrorType.UNKNOWN,
  ])

  constructor(resultQueue?: SharedResultQueue) {
    this.resultQueue = resultQueue ?? new SharedResultQueue()
  }

  /**
   * 生成唯一批次 ID
   */
  private nextBatchId(): string {
    return `batch_${++this.batchCounter}_${Date.now().toString(36)}`
  }

  /**
   * 获取共享队列实例
   */
  getQueue(): SharedResultQueue {
    return this.resultQueue
  }

  // =========================================================================
  // 单事件分类
  // =========================================================================

  /**
   * 根据错误消息和错误类型判断是否可恢复。
   *
   * 可恢复条件：
   * - 错误类型为 TRANSIENT（网络超时、连接重置等）
   * - 错误类型为 ENVIRONMENT（命令不存在等 → 有回退可能）
   * - 错误类型为 UNKNOWN（暂时归类失败 → 可重试）
   *
   * 不可恢复条件：
   * - TOOL_MISSING / MCP_ERROR（工具本身不可用）
   * - PERMISSION（权限不足，重试无意义）
   * - ARGUMENT（参数错误，重试同样会失败）
   */
  isRecoverable(errorType: ToolErrorType, _errorMessage?: string): boolean {
    if (ToolErrorAggregator.UNRECOVERABLE_TYPES.has(errorType)) return false
    if (ToolErrorAggregator.RECOVERABLE_TYPES.has(errorType)) return true
    // ARGUMENT 错误不可恢复（参数问题重试无意义）
    return false
  }

  // =========================================================================
  // 批量聚合
  // =========================================================================

  /**
   * 聚合一批工具执行结果。
   *
   * 流程：
   * 1. 将所有结果推入共享队列
   * 2. 分类每个结果（成功/可恢复失败/不可恢复失败）
   * 3. 计算错误类型分布
   * 4. 生成批量级别建议
   *
   * @param toolResults 从 ToolScheduler.executeAll() 返回的结果
   * @param batchId 可选批次 ID，默认自动生成
   * @returns AggregatedBatchResult
   */
  aggregateBatch(
    toolResults: MinimalToolResult[],
    batchId?: string,
  ): AggregatedBatchResult {
    const bid = batchId ?? this.nextBatchId()

    // 1. 将所有结果转为事件并推入队列
    const events: ToolExecutionEvent[] = toolResults.map((tr) => {
      const errorType = tr.success
        ? ToolErrorType.UNKNOWN
        : classifyToolError(tr.error || '')

      const event: ToolExecutionEvent = {
        callId: tr.id,
        toolName: tr.name,
        args: {},
        success: tr.success,
        result: tr.success ? tr.content : undefined,
        error: tr.success ? undefined : (tr.error || ''),
        errorType,
        latencyMs: tr.latencyMs,
        timestamp: Date.now(),
        batchId: bid,
      }

      this.resultQueue.push(event)
      return event
    })

    // 2. 分类
    const recoverable: ToolExecutionEvent[] = []
    const unrecoverable: ToolExecutionEvent[] = []
    const failedTools: string[] = []

    for (const event of events) {
      if (event.success) continue
      if (this.isRecoverable(event.errorType, event.error)) {
        recoverable.push(event)
      } else {
        unrecoverable.push(event)
      }
      if (!failedTools.includes(event.toolName)) {
        failedTools.push(event.toolName)
      }
    }

    // 3. 错误类型分布
    const errorTypeDistribution: Record<string, number> = {}
    for (const event of events) {
      if (event.success) continue
      const key = event.errorType
      errorTypeDistribution[key] = (errorTypeDistribution[key] ?? 0) + 1
    }

    const totalCalls = toolResults.length
    const successCount = toolResults.filter((r) => r.success).length
    const failureCount = totalCalls - successCount

    // 4. 生成批量级别建议
    const batchAdvice = this.generateBatchAdvice(
      recoverable,
      unrecoverable,
      successCount,
      totalCalls,
    )

    // 5. 判断是否需要回退
    const needsFallback = batchAdvice.action === 'fallback_needed' || batchAdvice.action === 'retry_recoverable'

    log('INFO', 'error_aggregator_batch_result', {
      batchId: bid,
      totalCalls,
      successCount,
      failureCount,
      recoverableCount: recoverable.length,
      unrecoverableCount: unrecoverable.length,
      advice: batchAdvice.action,
      errorTypes: Object.entries(errorTypeDistribution)
        .map(([k, v]) => `${k}:${v}`)
        .join(','),
    })

    return {
      batchId: bid,
      totalCalls,
      successCount,
      failureCount,
      successRate: totalCalls > 0 ? successCount / totalCalls : 0,
      errorTypeDistribution,
      recoverableFailures: recoverable,
      unrecoverableFailures: unrecoverable,
      events,
      needsFallback,
      batchAdvice,
    }
  }

  /**
   * 记录将执行回退的事件
   */
  recordFallbackExecution(
    originalToolName: string,
    fallbackToolName: string,
    batchId: string,
  ): void {
    const event: ToolExecutionEvent = {
      callId: `fb_${Date.now().toString(36)}`,
      toolName: `${originalToolName}→${fallbackToolName}`,
      args: {},
      success: true,
      result: `[Fallback] ${originalToolName} → ${fallbackToolName}`,
      errorType: ToolErrorType.UNKNOWN,
      latencyMs: 0,
      timestamp: Date.now(),
      batchId,
    }
    this.resultQueue.push(event)
  }

  /**
   * 从队列中消费并分析指定批次的记录（事后分析用）
   */
  consumeAndAnalyze(batchId: string): AggregatedBatchResult | null {
    const events = this.resultQueue.consumeBatch(batchId)
    if (events.length === 0) return null

    const recoverable = events.filter((e) => !e.success && this.isRecoverable(e.errorType, e.error))
    const unrecoverable = events.filter((e) => !e.success && !this.isRecoverable(e.errorType, e.error))
    const successCount = events.filter((e) => e.success).length
    const totalCalls = events.length

    const errorTypeDistribution: Record<string, number> = {}
    for (const e of events) {
      if (e.success) continue
      errorTypeDistribution[e.errorType] = (errorTypeDistribution[e.errorType] ?? 0) + 1
    }

    return {
      batchId,
      totalCalls,
      successCount,
      failureCount: totalCalls - successCount,
      successRate: totalCalls > 0 ? successCount / totalCalls : 0,
      errorTypeDistribution,
      recoverableFailures: recoverable,
      unrecoverableFailures: unrecoverable,
      events,
      needsFallback: recoverable.length > 0,
      batchAdvice: this.generateBatchAdvice(recoverable, unrecoverable, successCount, totalCalls),
    }
  }

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * 根据批量结果生成建议。
   *
   * 决策逻辑：
   * - 全部成功 → all_ok
   * - 全部失败且均为不可恢复 → critical_failure
   * - 部分成功，其余均为可恢复 → retry_recoverable / fallback_needed
   * - 全部失败，部分可恢复 → fallback_needed（如果可以）否则 critical_failure
   * - 部分成功，部分不可恢复 → partial_failure
   */
  private generateBatchAdvice(
    recoverable: ToolExecutionEvent[],
    unrecoverable: ToolExecutionEvent[],
    successCount: number,
    totalCalls: number,
  ): BatchAdvice {
    const hasRecoverable = recoverable.length > 0
    const hasUnrecoverable = unrecoverable.length > 0
    const allFailed = successCount === 0
    const allOk = successCount === totalCalls

    if (allOk) {
      return { action: 'all_ok' }
    }

    if (allFailed && !hasRecoverable) {
      // 全部失败且不可恢复 → 严重故障
      return {
        action: 'critical_failure',
        failedTools: [...new Set(unrecoverable.map((e) => e.toolName))],
        reason: `全部工具调用失败（${unrecoverable.length} 个不可恢复错误），请检查工具配置或服务器状态`,
      }
    }

    if (allFailed && hasRecoverable && !hasUnrecoverable) {
      // 全部失败但均可恢复 → 需要回退或重试
      return {
        action: 'fallback_needed',
        failedTools: recoverable.map((e) => ({
          primary: e.toolName,
          suggestion: {} as FallbackSuggestion, // 由调用者填充实际的 suggestion
        })),
        reason: `全部工具失败（可恢复），共 ${recoverable.length} 个工具需要回退`,
      }
    }

    if (hasRecoverable && !hasUnrecoverable) {
      // 部分成功，其余可恢复
      return {
        action: 'retry_recoverable',
        failedTools: [...new Set(recoverable.map((e) => e.toolName))],
        reason: `${recoverable.length} 个工具调用失败（可恢复），${successCount} 个成功`,
      }
    }

    // 混合：部分成功 + 可恢复 + 不可恢复
    if (successCount > 0 && hasUnrecoverable) {
      return {
        action: 'partial_failure',
        failedTools: [...new Set(unrecoverable.map((e) => e.toolName))],
        reason: `${unrecoverable.length} 个不可恢复工具失败，${successCount} 个成功`,
      }
    }

    return {
      action: 'partial_failure',
      failedTools: [...new Set([...recoverable, ...unrecoverable].map((e) => e.toolName))],
      reason: `部分工具失败`,
    }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const toolErrorAggregator = new ToolErrorAggregator()
