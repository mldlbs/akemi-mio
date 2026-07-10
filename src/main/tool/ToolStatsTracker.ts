/**
 * ToolStatsTracker — 工具调用统计追踪器
 *
 * 职责：
 * 1. 从 BehaviorPredictor 和 MemoryAwareInterceptor 读取工具调用数据
 * 2. 计算每个工具的错误率、调用频率
 * 3. 识别问题工具（高错误率、高频失败的候选）
 * 4. 维护已优化工具的冷却列表
 *
 * 与 Evolution 管道集成：
 * - ToolEvolutionCollector 读取此模块的判断结果生成 Problem
 * - ToolEvolutionExecutor 在优化完成后调用 markOptimized()
 */

import { log } from '../logger/Logger'
import { behaviorPredictor } from '../mcp/BehaviorPredictor'

// =============================================================================
// 类型定义
// =============================================================================

export interface ToolCallSummary {
  /** 工具名 */
  toolName: string
  /** 窗口内总调用次数 */
  totalCalls: number
  /** 成功次数 */
  successCount: number
  /** 失败次数 */
  failureCount: number
  /** 错误率 (0-1) */
  errorRate: number
  /** 最近一次调用时间戳 */
  lastCallAt: number
  /** 窗口内平均调用间隔毫秒 */
  avgIntervalMs: number
  /** 窗口内平均延迟毫秒（仅成功调用） */
  avgLatencyMs: number
}

export interface ProblematicTool {
  toolName: string
  errorRate: number
  totalCalls: number
  reason: string
  /** 建议的优化类型 */
  suggestion: ToolImprovementSuggestion
}

export type ToolImprovementSuggestion = 'retry' | 'timeout' | 'parameter_validation' | 'error_handling' | 'cache' | 'general'

// =============================================================================
// 配置常量
// =============================================================================

const DEFAULT_CONFIG = {
  /** 错误率阈值：超过此值视为问题工具（80% 成功率 = 20% 错误率） */
  ERROR_RATE_THRESHOLD: 0.20,
  /** 最小调用次数：少于此次数不视为问题（样本不足） */
  MIN_CALLS_THRESHOLD: 5,
  /** 优化后冷却时间（毫秒）：同一工具不重复优化 */
  COOLDOWN_MS: 24 * 60 * 60 * 1000,
  /** 分析窗口大小（最近 N 条调用记录） */
  ANALYSIS_WINDOW: 50,
}

// =============================================================================
// ToolStatsTracker 实现
// =============================================================================

export class ToolStatsTracker {
  private config: typeof DEFAULT_CONFIG
  /** 已优化过的工具及其时间戳（冷却列表） */
  private optimizedTools = new Map<string, number>()

  constructor(config?: Partial<typeof DEFAULT_CONFIG>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 获取所有工具的调用摘要 */
  getAllToolSummaries(): ToolCallSummary[] {
    const recentCalls = behaviorPredictor.getRecentCalls()
    const now = Date.now()

    // 按工具名分组
    const toolMap = new Map<string, { success: number; failure: number; timestamps: number[] }>()

    for (const call of recentCalls) {
      const entry = toolMap.get(call.toolName)
      if (entry) {
        if (call.success) entry.success++
        else entry.failure++
        entry.timestamps.push(call.timestamp)
      } else {
        toolMap.set(call.toolName, {
          success: call.success ? 1 : 0,
          failure: call.success ? 0 : 1,
          timestamps: [call.timestamp],
        })
      }
    }

    const summaries: ToolCallSummary[] = []

    for (const [toolName, stats] of toolMap) {
      const totalCalls = stats.success + stats.failure
      const errorRate = totalCalls > 0 ? stats.failure / totalCalls : 0
      const timestamps = stats.timestamps.sort((a, b) => a - b)
      const lastCallAt = timestamps.length > 0 ? timestamps[timestamps.length - 1] : 0

      // 计算平均间隔
      let avgIntervalMs = 0
      if (timestamps.length >= 2) {
        let totalInterval = 0
        for (let i = 1; i < timestamps.length; i++) {
          totalInterval += timestamps[i] - timestamps[i - 1]
        }
        avgIntervalMs = totalInterval / (timestamps.length - 1)
      }

      // 计算平均延迟（从 BehaviorPredictor 记录中读取 durationMs）
      let avgLatencyMs = 0
      const toolCalls = recentCalls.filter((c) => c.toolName === toolName && c.success && c.durationMs > 0)
      if (toolCalls.length > 0) {
        avgLatencyMs = Math.round(toolCalls.reduce((s, c) => s + c.durationMs, 0) / toolCalls.length)
      }

      summaries.push({
        toolName,
        totalCalls,
        successCount: stats.success,
        failureCount: stats.failure,
        errorRate,
        lastCallAt,
        avgIntervalMs,
        avgLatencyMs,
      })
    }

    return summaries.sort((a, b) => b.errorRate - a.errorRate)
  }

  /** 获取问题工具列表（按严重度排序） */
  getProblematicTools(): ProblematicTool[] {
    const summaries = this.getAllToolSummaries()
    const now = Date.now()
    const problems: ProblematicTool[] = []

    for (const s of summaries) {
      // 跳过样本不足的工具
      if (s.totalCalls < this.config.MIN_CALLS_THRESHOLD) continue

      // 跳过冷却中的工具
      const cooldownUntil = this.optimizedTools.get(s.toolName)
      if (cooldownUntil && now < cooldownUntil) continue

      // 错误率超过阈值
      if (s.errorRate >= this.config.ERROR_RATE_THRESHOLD) {
        let suggestion: ToolImprovementSuggestion = 'general'
        const reason = buildSuggestionReason(s, suggestion)
        problems.push({
          toolName: s.toolName,
          errorRate: s.errorRate,
          totalCalls: s.totalCalls,
          reason,
          suggestion,
        })
      }
    }

    return problems.sort((a, b) => b.errorRate - a.errorRate)
  }

  /** 标记工具已优化（进入冷却期） */
  markOptimized(toolName: string): void {
    this.optimizedTools.set(toolName, Date.now() + this.config.COOLDOWN_MS)
    log('INFO', 'tool_stats_optimized', { toolName, cooldownMs: this.config.COOLDOWN_MS })
  }

  /** 清除冷却状态（如回滚后） */
  clearCooldown(toolName: string): void {
    this.optimizedTools.delete(toolName)
    log('INFO', 'tool_stats_cooldown_cleared', { toolName })
  }

  /** 获取冷却列表快照 */
  getCooldownSnapshot(): Array<{ toolName: string; remainingMs: number }> {
    const now = Date.now()
    const result: Array<{ toolName: string; remainingMs: number }> = []
    for (const [toolName, until] of this.optimizedTools) {
      const remaining = until - now
      if (remaining > 0) {
        result.push({ toolName, remainingMs: remaining })
      }
    }
    return result
  }

  /** 更新配置 */
  setConfig(config: Partial<typeof DEFAULT_CONFIG>): void {
    this.config = { ...this.config, ...config }
  }
}

// =============================================================================
// 辅助函数
// =============================================================================

function buildSuggestionReason(summary: ToolCallSummary, suggestion: ToolImprovementSuggestion): string {
  const errorRatePct = (summary.errorRate * 100).toFixed(0)
  const parts: string[] = [
    `工具 "${summary.toolName}" 错误率 ${errorRatePct}%（${summary.failureCount}/${summary.totalCalls}），`,
  ]

  switch (suggestion) {
    case 'retry':
      parts.push('建议添加重试机制')
      break
    case 'timeout':
      parts.push('超时问题频发，建议优化超时控制')
      break
    case 'parameter_validation':
      parts.push('参数校验不足导致错误，建议增强参数验证')
      break
    case 'error_handling':
      parts.push('错误处理不完善，建议改进异常捕获和降级逻辑')
      break
    case 'cache':
      parts.push('重复调用频繁，建议添加缓存机制减少重复执行')
      break
    default:
      parts.push('建议优化错误处理和健壮性')
  }

  return parts.join('')
}

// =============================================================================
// 全局单例
// =============================================================================

export const toolStatsTracker = new ToolStatsTracker()
