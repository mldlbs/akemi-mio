/**
 * ToolAnalytics — MCP 工具调用统一分析引擎
 *
 * 职责：
 * 1. 融合 ToolCallLogStore、ToolStatsTracker、FailurePatternAnalyzer 数据
 * 2. 计算延迟百分位（P50/P95/P99）
 * 3. 成功率趋势分析（近期 vs 远期对比）
 * 4. 每参数级别的失败模式分析（增强）
 * 5. 基于分析结果生成工具优先级推荐（供 ServerManager 使用）
 * 6. 为 ToolEvolutionCollector 提供更丰富的上下文
 *
 * 数据流：
 *   ToolCallLogStore → ToolAnalytics.analyzeTool() → ToolAnalyticsReport
 *   ToolStatsTracker  → ToolAnalytics.getPriorityRecommendations() → ServerManager
 *
 * 与 ToolStatsTracker 的区别：
 * - ToolStatsTracker 侧重错误率检测 + 问题工具发现（给 Evolution 用）
 * - ToolAnalytics 侧重全维度分析 + 趋势追踪 + 优先级推荐（给 MCP 调度用）
 */

import { log } from '../logger/Logger'
import { toolCallLogStore, type ToolCallRecord, type CallLogStats } from './ToolCallLogStore'
import { toolStatsTracker, type ToolCallSummary, type ProblematicTool } from './ToolStatsTracker'
import { failurePatternAnalyzer, type FailurePattern } from './FailurePatternAnalyzer'
import { ToolErrorType } from './ToolErrorType'

// =============================================================================
// 类型定义
// =============================================================================

/** 延迟百分位 */
export interface LatencyPercentiles {
  p50: number
  p95: number
  p99: number
  avg: number
  max: number
  min: number
  sampleCount: number
}

/** 趋势方向 */
export type TrendDirection = 'improving' | 'stable' | 'declining' | 'insufficient_data'

/** 成功率趋势 */
export interface SuccessRateTrend {
  /** 当前窗口成功率 (0-1) */
  currentRate: number
  /** 上一个窗口成功率 (0-1) */
  previousRate: number
  /** 变化量 (正 = 改善) */
  delta: number
  /** 趋势方向 */
  direction: TrendDirection
  /** 当前窗口样本数 */
  currentSamples: number
  /** 上一个窗口样本数 */
  previousSamples: number
}

/** 工具分析报告（单工具） */
export interface ToolAnalyticsReport {
  toolName: string
  /** 基础统计 */
  totalCalls: number
  successCount: number
  failureCount: number
  errorRate: number
  /** 延迟百分位 */
  latency: LatencyPercentiles | null
  /** 成功率趋势 */
  trend: SuccessRateTrend
  /** 失败模式分析 */
  failurePatterns: FailurePattern[]
  /** 问题工具判定（仅当满足阈值时存在） */
  problematic: ProblematicTool | null
  /** 按错误类型的分布 */
  errorTypeDistribution: Record<string, number>
  /** 调用频率（次/小时） */
  callsPerHour: number
  /** 推荐优先级调整值 [-10, +10]，正=提升，负=降低 */
  priorityDelta: number
  /** 优先级调整理由 */
  priorityReason: string
  /** 最近调用时间 */
  lastCallAt: number
}

/** 全工具分析汇总 */
export interface ToolAnalyticsSummary {
  reports: ToolAnalyticsReport[]
  /** 全局统计 */
  totalTools: number
  totalCalls: number
  overallErrorRate: number
  /** 需要关注的问题工具（errorRate >= ERROR_RATE_THRESHOLD） */
  problematicCount: number
  /** 趋势向下工具 */
  decliningCount: number
  /** 分析时间戳 */
  analyzedAt: number
  /** 全局统计 */
  stats: CallLogStats
}

/** 优先级调整建议 */
export interface PriorityRecommendation {
  toolName: string
  /** 建议的调整值 [-10, +10] */
  delta: number
  reason: string
  /** 当前错误率 */
  errorRate: number
  /** 当前延迟平均值 */
  avgLatencyMs: number
}

// =============================================================================
// 配置常量
// =============================================================================

const DEFAULT_CONFIG = {
  /** 错误率阈值：超过此值视为问题工具（80% 成功率 = 20% 错误率） */
  ERROR_RATE_THRESHOLD: 0.20,
  /** 趋势分析：近期窗口（最近 N 条记录） */
  TREND_CURRENT_WINDOW: 20,
  /** 趋势分析：远期窗口（前 N 条记录） */
  TREND_PREVIOUS_WINDOW: 20,
  /** 最小样本数：少于该值不计算延迟百分位 */
  MIN_LATENCY_SAMPLES: 3,
  /** 延迟最大值兜底（毫秒） */
  MAX_LATENCY_MS: 300_000,
  /** 优先级调整：高成功率（>=95%）工具的提升值 */
  HIGH_SUCCESS_BOOST: 3,
  /** 优先级调整：低成功率（<80%）工具的降低值 */
  LOW_SUCCESS_PENALTY: -3,
  /** 优先级调整：高延迟（>10s 平均）工具的降低值 */
  HIGH_LATENCY_PENALTY: -1,
  /** 优先级调整：低延迟（<100ms 平均）工具的提升值 */
  LOW_LATENCY_BOOST: 1,
  /** 优先级调整的封顶值 */
  MAX_PRIORITY_DELTA: 10,
}

// =============================================================================
// ToolAnalytics 实现
// =============================================================================

export class ToolAnalytics {
  private config: typeof DEFAULT_CONFIG

  constructor(config?: Partial<typeof DEFAULT_CONFIG>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 分析单个工具的完整数据
   */
  analyzeTool(toolName: string): ToolAnalyticsReport {
    // ── 1. 获取基础统计 ──
    const summaries = toolStatsTracker.getAllToolSummaries()
    const summary = summaries.find((s) => s.toolName === toolName)
    const totalCalls = summary?.totalCalls ?? 0
    const successCount = summary?.successCount ?? 0
    const failureCount = summary?.failureCount ?? 0
    const errorRate = totalCalls > 0 ? failureCount / totalCalls : 0

    // ── 2. 获取延迟百分位 ──
    const latency = this.computeLatencyPercentiles(toolName)

    // ── 3. 获取成功率趋势 ──
    const trend = this.computeSuccessRateTrend(toolName)

    // ── 4. 获取失败模式 ──
    const failurePatterns = failurePatternAnalyzer.analyzeTool(toolName)

    // ── 5. 问题工具判定 ──
    const problematicTools = toolStatsTracker.getProblematicTools()
    const problematic = problematicTools.find((p) => p.toolName === toolName) ?? null

    // ── 6. 错误类型分布 ──
    const errorTypeDistribution = this.computeErrorTypeDistribution(toolName)

    // ── 7. 调用频率 ──
    const callsPerHour = this.computeCallsPerHour(toolName)

    // ── 8. 优先级推荐 ──
    const { delta: priorityDelta, reason: priorityReason } = this.computePriorityDelta(
      toolName, errorRate, latency,
    )

    return {
      toolName,
      totalCalls,
      successCount,
      failureCount,
      errorRate,
      latency,
      trend,
      failurePatterns,
      problematic,
      errorTypeDistribution,
      callsPerHour,
      priorityDelta,
      priorityReason,
      lastCallAt: summary?.lastCallAt ?? 0,
    }
  }

  /**
   * 分析所有已记录的 MCP 工具
   */
  analyzeAll(): ToolAnalyticsSummary {
    const reports: ToolAnalyticsReport[] = []
    const stats = toolCallLogStore.getStats()
    const toolNames = Object.keys(stats.byTool)

    for (const name of toolNames) {
      reports.push(this.analyzeTool(name))
    }

    // 按错误率降序排列（问题最严重的排最前）
    reports.sort((a, b) => b.errorRate - a.errorRate)

    const totalCalls = reports.reduce((sum, r) => sum + r.totalCalls, 0)
    const totalFailures = reports.reduce((sum, r) => sum + r.failureCount, 0)
    const problematicCount = reports.filter(
      (r) => r.errorRate >= this.config.ERROR_RATE_THRESHOLD && r.totalCalls >= 5,
    ).length
    const decliningCount = reports.filter((r) => r.trend.direction === 'declining').length

    return {
      reports,
      totalTools: reports.length,
      totalCalls,
      overallErrorRate: totalCalls > 0 ? totalFailures / totalCalls : 0,
      problematicCount,
      decliningCount,
      analyzedAt: Date.now(),
      stats,
    }
  }

  /**
   * 获取优先级推荐列表（供 ServerManager 使用）
   * 返回按 delta 绝对值降序排列的推荐
   */
  getPriorityRecommendations(): PriorityRecommendation[] {
    const recommendations: PriorityRecommendation[] = []
    const stats = toolCallLogStore.getStats()

    for (const [toolName, toolStats] of Object.entries(stats.byTool)) {
      const errorRate = toolStats.total > 0 ? toolStats.failure / toolStats.total : 0
      const latency = this.computeLatencyPercentiles(toolName)
      const avgLatencyMs = latency?.avg ?? 0

      const { delta, reason } = this.computePriorityDelta(toolName, errorRate, latency)

      if (delta !== 0) {
        recommendations.push({
          toolName,
          delta,
          reason,
          errorRate,
          avgLatencyMs,
        })
      }
    }

    return recommendations.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  }

  /**
   * 获取报告给 Evolution 系统的上下文
   * 包含最需要关注的工具列表（错误率高或趋势恶化）
   */
  getEvolutionContext(): {
    urgentProblems: ToolAnalyticsReport[]
    warnings: ToolAnalyticsReport[]
    summary: ToolAnalyticsSummary
  } {
    const summary = this.analyzeAll()

    // 紧急问题：错误率 >= 阈值 且 样本数 >= 5
    const urgentProblems = summary.reports.filter(
      (r) => r.errorRate >= this.config.ERROR_RATE_THRESHOLD && r.totalCalls >= 5,
    )

    // 警告：趋势恶化 或 延迟异常高
    const warnings = summary.reports.filter(
      (r) =>
        !urgentProblems.includes(r) &&
        (r.trend.direction === 'declining' ||
          (r.latency && r.latency.avg > 10_000)),
    )

    return { urgentProblems, warnings, summary }
  }

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * 计算延迟百分位
   * 从 ToolCallLogStore 读取成功调用的耗时记录
   */
  private computeLatencyPercentiles(toolName: string): LatencyPercentiles | null {
    const allCalls = this.getRawCalls(toolName)
    if (allCalls.length < this.config.MIN_LATENCY_SAMPLES) return null

    const durations = allCalls
      .map((c) => c.durationMs)
      .filter((d) => d > 0 && d < this.config.MAX_LATENCY_MS)
      .sort((a, b) => a - b)

    if (durations.length < this.config.MIN_LATENCY_SAMPLES) return null

    const p50 = durations[Math.floor(durations.length * 0.5)]
    const p95 = durations[Math.floor(durations.length * 0.95)]
    const p99 = durations[Math.floor(durations.length * 0.99)]
    const avg = durations.reduce((s, d) => s + d, 0) / durations.length

    return {
      p50,
      p95,
      p99,
      avg: Math.round(avg),
      max: durations[durations.length - 1],
      min: durations[0],
      sampleCount: durations.length,
    }
  }

  /**
   * 计算成功率趋势（近期 vs 远期）
   */
  private computeSuccessRateTrend(toolName: string): SuccessRateTrend {
    const allCalls = this.getRawCalls(toolName)
    if (allCalls.length < 5) {
      return {
        currentRate: 0,
        previousRate: 0,
        delta: 0,
        direction: 'insufficient_data',
        currentSamples: 0,
        previousSamples: 0,
      }
    }

    // 按时间倒序排列（最新的在前）
    const sorted = [...allCalls].sort((a, b) => b.timestamp - a.timestamp)

    const currentWindow = sorted.slice(0, this.config.TREND_CURRENT_WINDOW)
    const previousWindow = sorted.slice(
      this.config.TREND_CURRENT_WINDOW,
      this.config.TREND_CURRENT_WINDOW + this.config.TREND_PREVIOUS_WINDOW,
    )

    const currentSamples = currentWindow.length
    const previousSamples = previousWindow.length

    if (previousSamples < 3) {
      return {
        currentRate: 0,
        previousRate: 0,
        delta: 0,
        direction: 'insufficient_data',
        currentSamples,
        previousSamples,
      }
    }

    const currentRate =
      currentWindow.filter((c) => c.success).length / currentSamples
    const previousRate =
      previousWindow.filter((c) => c.success).length / previousSamples
    const delta = currentRate - previousRate

    let direction: TrendDirection
    if (delta > 0.05) {
      direction = 'improving'
    } else if (delta < -0.05) {
      direction = 'declining'
    } else {
      direction = 'stable'
    }

    return {
      currentRate,
      previousRate,
      delta,
      direction,
      currentSamples,
      previousSamples,
    }
  }

  /**
   * 计算错误类型分布
   */
  private computeErrorTypeDistribution(toolName: string): Record<string, number> {
    const allCalls = this.getRawCalls(toolName)
    const distribution: Record<string, number> = {}

    for (const call of allCalls) {
      if (call.success) continue
      const type = call.errorType ?? ToolErrorType.UNKNOWN
      distribution[type] = (distribution[type] ?? 0) + 1
    }

    return distribution
  }

  /**
   * 计算调用频率（次/小时）
   */
  private computeCallsPerHour(toolName: string): number {
    const allCalls = this.getRawCalls(toolName, 100)
    if (allCalls.length < 2) return 0

    const sorted = [...allCalls].sort((a, b) => a.timestamp - b.timestamp)
    const timeSpanMs = sorted[sorted.length - 1].timestamp - sorted[0].timestamp
    if (timeSpanMs < 1000) return allCalls.length // 不足一秒，直接返回总数

    const hours = timeSpanMs / (1000 * 60 * 60)
    return hours > 0 ? Math.round(allCalls.length / hours) : allCalls.length
  }

  /**
   * 计算优先级调整值
   * 高成功率 → 提升；低成功率 → 降低；高延迟 → 降低；低延迟 → 提升
   */
  private computePriorityDelta(
    toolName: string,
    errorRate: number,
    latency: LatencyPercentiles | null,
  ): { delta: number; reason: string } {
    let delta = 0
    const reasons: string[] = []

    // 成功率因子
    if (errorRate <= 0.05 && toolStatsTracker.getAllToolSummaries().find((s) => s.toolName === toolName)?.totalCalls >= 5) {
      delta += this.config.HIGH_SUCCESS_BOOST
      reasons.push('高成功率 (>=95%)')
    } else if (errorRate >= this.config.ERROR_RATE_THRESHOLD) {
      delta += this.config.LOW_SUCCESS_PENALTY
      reasons.push(`低成功率 (${((1 - errorRate) * 100).toFixed(0)}% < 80%)`)
    }

    // 延迟因子
    if (latency && latency.sampleCount >= this.config.MIN_LATENCY_SAMPLES) {
      if (latency.avg <= 100) {
        delta += this.config.LOW_LATENCY_BOOST
        reasons.push('低延迟 (<100ms)')
      } else if (latency.avg > 10_000) {
        delta += this.config.HIGH_LATENCY_PENALTY
        reasons.push(`高延迟 (${(latency.avg / 1000).toFixed(1)}s)`)
      }
    }

    // 封顶处理
    delta = Math.max(-this.config.MAX_PRIORITY_DELTA, Math.min(this.config.MAX_PRIORITY_DELTA, delta))

    return {
      delta,
      reason: reasons.length > 0 ? reasons.join('; ') : '中性',
    }
  }

  /**
   * 从 ToolCallLogStore 获取原始调用记录
   */
  private getRawCalls(toolName: string, maxSamples?: number): ToolCallRecord[] {
    return toolCallLogStore.query({
      toolName,
      limit: maxSamples ?? 50,
    })
  }

  /** 设置配置 */
  setConfig(config: Partial<typeof DEFAULT_CONFIG>): void {
    this.config = { ...this.config, ...config }
  }

  /** 获取当前配置（只读快照） */
  getConfig(): Readonly<typeof DEFAULT_CONFIG> {
    return { ...this.config }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const toolAnalytics = new ToolAnalytics()
