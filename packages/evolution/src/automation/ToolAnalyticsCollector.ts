/**
 * ToolAnalyticsCollector — 工具分析优化计划采集器
 *
 * ## 职责
 * 从 ToolAnalytics 读取全维度工具性能数据，生成配置优化计划：
 * 1. 高成功率低延迟工具 → 建议提升优先级
 * 2. 低成功率工具 → 建议降低优先级或禁用
 * 3. 高延迟工具 → 建议调整超时
 * 4. 趋势恶化工具 → 建议降低优先级
 * 5. 高频失败工具 → 建议禁用或降级
 *
 * ## 与 ToolEvolutionCollector 的职责分工
 * - ToolEvolutionCollector: 仅报告错误率超过阈值的工具（问题发现 → 源码修复）
 * - ToolAnalyticsCollector: 全维度分析，生成配置优化计划（性能分析 → 配置调优）
 *   前者触发源码级修复，后者触发配置级调优，两者互补而非重叠。
 *
 * ## 数据流
 *   ToolAnalytics.analyzeAll() → ToolAnalyticsCollector.collect() → Problem[]
 *   → PipelineOrchestrator → ToolConfigOptimizationExecutor.execute()
 *
 * ## 判断阈值
 * - 高成功率: >= 95% 且样本 >= 5 → 建议 priority boost
 * - 高错误率: >= 20% 且样本 >= 5 → 建议 priority penalty 或 disable
 * - 高延迟: avg > 10s 且样本 >= 3 → 建议 timeout 调整
 * - 趋势恶化: success rate trend === 'declining' → 建议 priority penalty
 * - 低数据: totalCalls < 5 → 跳过
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { SignalCollector, Problem } from './types'
import { toolAnalytics } from '@akemi-mio/capabilities/tool/ToolAnalytics'
import { toolConfigManager } from '@akemi-mio/capabilities/tool/ToolConfigManager'

// =============================================================================
// 采集器配置
// =============================================================================

const COLLECTOR_CONFIG = {
  /** 最小样本数：少于该值不生成优化建议 */
  MIN_SAMPLES: 5,
  /** 高成功率阈值（>= 此值视为高可靠，建议提升优先级） */
  HIGH_SUCCESS_RATE: 0.95,
  /** 高错误率阈值（>= 此值视为问题工具，建议降低优先级） */
  HIGH_ERROR_RATE: 0.2,
  /** 高延迟阈值（avg > 此毫秒数，建议调整超时） */
  HIGH_LATENCY_MS: 10_000,
  /** 低延迟阈值（avg < 此毫秒数，极速工具可提升优先级） */
  LOW_LATENCY_MS: 100,
  /** 最小运行间隔（毫秒），避免每周期都在采集 */
  MIN_INTERVAL_MS: 60 * 60 * 1000, // 1 小时
  /** 单次采集最大生成问题数 */
  MAX_PROBLEMS_PER_CYCLE: 5,
  /** 对同一工具的冷却时间（毫秒），避免频繁优化 */
  TOOL_COOLDOWN_MS: 6 * 60 * 60 * 1000, // 6 小时
}

// =============================================================================
// ToolAnalyticsCollector
// =============================================================================

export class ToolAnalyticsCollector implements SignalCollector {
  readonly name = 'tool-analytics-collector'
  readonly source = 'tool' as const

  private lastRun = 0
  /** 工具 → 上次生成问题的时间戳（冷却列表） */
  private toolCooldowns = new Map<string, number>()

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < COLLECTOR_CONFIG.MIN_INTERVAL_MS) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const problems: Problem[] = []

    try {
      // ── 阶段 1: 获取全工具分析报告 ──
      const summary = toolAnalytics.analyzeAll()

      if (summary.totalCalls < 5) {
        log('INFO', 'tool_analytics_collector_insufficient_data', {
          totalCalls: summary.totalCalls,
        })
        return []
      }

      log('INFO', 'tool_analytics_collector_analysis', {
        totalTools: summary.totalTools,
        totalCalls: summary.totalCalls,
        problematicCount: summary.problematicCount,
        overallErrorRate: (summary.overallErrorRate * 100).toFixed(1) + '%',
      })

      // ── 阶段 2: 逐个工具分析，生成优化问题 ──
      const candidates: Array<{ tool: (typeof summary.reports)[0]; priority: number }> = []

      for (const report of summary.reports) {
        // 跳过样本不足的工具
        if (report.totalCalls < COLLECTOR_CONFIG.MIN_SAMPLES) continue

        // 检查冷却
        if (this.isOnCooldown(report.toolName)) continue

        // 检查是否已优化过（避免重复）
        if (!toolConfigManager.canOptimize(report.toolName)) continue

        let priority = 0
        let problemType: string | null = null
        let title = ''
        let description = ''
        let metadata: Record<string, string> = {}

        // ── 条件 A: 高成功率 + 低延迟 → 提升优先级 ──
        if (
          report.errorRate <= 1 - COLLECTOR_CONFIG.HIGH_SUCCESS_RATE &&
          report.latency &&
          report.latency.avg <= COLLECTOR_CONFIG.LOW_LATENCY_MS &&
          report.trend.direction !== 'declining'
        ) {
          const boost = Math.min(Math.floor((1 - report.errorRate) * 3 + (report.latency.avg < 50 ? 1 : 0)), 5)
          priority = boost
          problemType = 'boost_priority'
          title = `工具 "${report.toolName}" 性能优秀，建议提升优先级`
          description = this.buildBoostDescription(report)
          metadata = {
            toolName: report.toolName,
            suggestion: 'boost_priority',
            priorityDelta: String(boost),
            currentErrorRate: String(report.errorRate),
            avgLatencyMs: String(report.latency.avg),
            totalCalls: String(report.totalCalls),
          }
        }

        // ── 条件 B: 高错误率 → 降低优先级 ──
        if (report.errorRate >= COLLECTOR_CONFIG.HIGH_ERROR_RATE) {
          const penalty = Math.min(Math.ceil(report.errorRate * 5), 5)
          priority = -penalty
          problemType = 'reduce_priority'
          title = `工具 "${report.toolName}" 错误率过高，建议降低优先级`
          description = this.buildReduceDescription(report)
          metadata = {
            toolName: report.toolName,
            suggestion: 'reduce_priority',
            priorityDelta: String(-penalty),
            currentErrorRate: String(report.errorRate),
            totalCalls: String(report.totalCalls),
            failurePattern: report.failurePatterns[0]?.description?.slice(0, 100) || '',
          }
        }

        // ── 条件 C: 高延迟 → 建议调整超时 ──
        if (!problemType && report.latency && report.latency.avg > COLLECTOR_CONFIG.HIGH_LATENCY_MS && report.successCount > 0) {
          const suggestedTimeout = Math.ceil((report.latency.p95 * 1.5) / 1000) * 1000
          priority = -1
          problemType = 'adjust_timeout'
          title = `工具 "${report.toolName}" 延迟较高，建议调整超时设置`
          description = this.buildTimeoutDescription(report, suggestedTimeout)
          metadata = {
            toolName: report.toolName,
            suggestion: 'adjust_timeout',
            avgLatencyMs: String(report.latency.avg),
            p95LatencyMs: String(report.latency.p95),
            suggestedTimeoutMs: String(suggestedTimeout),
            totalCalls: String(report.totalCalls),
          }
        }

        // ── 条件 D: 趋势恶化 → 建议降低优先级 ──
        if (!problemType && report.trend.direction === 'declining' && report.totalCalls >= 10) {
          priority = -2
          problemType = 'reduce_priority_trend'
          title = `工具 "${report.toolName}" 成功率趋势恶化，建议降低优先级`
          description = this.buildTrendDescription(report)
          metadata = {
            toolName: report.toolName,
            suggestion: 'reduce_priority_trend',
            priorityDelta: '-2',
            currentRate: String(report.trend.currentRate),
            previousRate: String(report.trend.previousRate),
            totalCalls: String(report.totalCalls),
          }
        }

        // ── 条件 E: 极高错误率（> 50%）→ 建议禁用 ──
        if (report.errorRate >= 0.5 && report.totalCalls >= COLLECTOR_CONFIG.MIN_SAMPLES) {
          priority = -10
          problemType = 'consider_disable'
          title = `工具 "${report.toolName}" 错误率极高（${(report.errorRate * 100).toFixed(0)}%），建议暂时禁用`
          description = this.buildDisableDescription(report)
          metadata = {
            toolName: report.toolName,
            suggestion: 'consider_disable',
            currentErrorRate: String(report.errorRate),
            totalCalls: String(report.totalCalls),
            failurePattern: report.failurePatterns[0]?.description?.slice(0, 100) || '',
          }
        }

        if (problemType && priority !== 0) {
          const completeIdentity = report.identitySummary?.mixed ? undefined : report.identitySummary
          candidates.push({
            tool: report,
            priority: Math.abs(priority),
          })

          problems.push({
            id: `tool_config_opt:${report.toolName}:${problemType}:${Date.now()}`,
            source: 'tool',
            severity: report.errorRate >= 0.5 ? 'error' : 'warning',
            title,
            description,
            estimatedCostChars: 100,
            lastSeen: Date.now(),
            occurrenceCount: 1,
            context: {
              raw: [
                `工具配置优化分析:`,
                `工具名: ${report.toolName}`,
                `错误率: ${(report.errorRate * 100).toFixed(1)}%`,
                `总调用: ${report.totalCalls}`,
                `成功率: ${report.totalCalls > 0 ? ((report.successCount / report.totalCalls) * 100).toFixed(1) : 0}%`,
                report.latency ? `平均延迟: ${report.latency.avg}ms` : '',
                `优化类型: ${problemType}`,
                `优先级偏移: ${priority >= 0 ? '+' : ''}${priority}`,
                `趋势: ${report.trend.direction}`,
              ]
                .filter(Boolean)
                .join('\n'),
              metadata: {
                ...metadata,
                ...(completeIdentity
                  ? {
                      operation: completeIdentity.operation,
                      issueType: problemType,
                      provider: completeIdentity.provider,
                      identityProvenance: JSON.stringify(completeIdentity.provenance),
                    }
                  : {}),
              },
            },
            ...(completeIdentity ? { affectedCapability: completeIdentity.capability } : {}),
          })

          // 标记冷却
          this.toolCooldowns.set(report.toolName, Date.now() + COLLECTOR_CONFIG.TOOL_COOLDOWN_MS)
        }
      }

      // 按优先级排序
      candidates.sort((a, b) => b.priority - a.priority)
      const prioritizedProblems = candidates
        .slice(0, COLLECTOR_CONFIG.MAX_PROBLEMS_PER_CYCLE)
        .map((c) => problems.find((p) => p.context.metadata?.toolName === c.tool.toolName)!)
        .filter(Boolean)

      if (prioritizedProblems.length > 0) {
        log('INFO', 'tool_analytics_collector_problems', {
          count: prioritizedProblems.length,
          tools: prioritizedProblems.map((p) => `${p.context.metadata?.toolName}(${p.context.metadata?.suggestion})`).join(', '),
        })
      }

      return prioritizedProblems
    } catch (err: any) {
      log('ERROR', 'tool_analytics_collector_error', { error: err.message })
      return []
    }
  }

  // ==================== 内部方法 ====================

  private isOnCooldown(toolName: string): boolean {
    const until = this.toolCooldowns.get(toolName)
    if (!until) return false
    if (Date.now() > until) {
      this.toolCooldowns.delete(toolName)
      return false
    }
    return true
  }

  private buildBoostDescription(report: any): string {
    return [
      `工具 "${report.toolName}" 性能优秀：`,
      `- 错误率: ${(report.errorRate * 100).toFixed(1)}%`,
      `- 平均延迟: ${report.latency?.avg ?? '?'}ms`,
      `- 总调用: ${report.totalCalls} 次`,
      `- 趋势: ${report.trend.direction === 'improving' ? '持续改善' : '稳定'}`,
      ``,
      `建议提升优先级以加快系统响应速度。`,
    ].join('\n')
  }

  private buildReduceDescription(report: any): string {
    return [
      `工具 "${report.toolName}" 错误率过高：`,
      `- 错误率: ${(report.errorRate * 100).toFixed(1)}%`,
      `- 成功: ${report.successCount}/${report.totalCalls}`,
      `- 平均延迟: ${report.latency?.avg ?? '?'}ms`,
      report.failurePatterns.length > 0 ? `- 主要失败模式: ${report.failurePatterns[0].description}` : '',
      ``,
      `建议降低优先级，减少其对整体响应速度的影响。`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  private buildTimeoutDescription(report: any, suggestedTimeout: number): string {
    return [
      `工具 "${report.toolName}" 延迟较高：`,
      `- 平均延迟: ${report.latency?.avg ?? '?'}ms`,
      `- P95 延迟: ${report.latency?.p95 ?? '?'}ms`,
      `- P99 延迟: ${report.latency?.p99 ?? '?'}ms`,
      `- 总调用: ${report.totalCalls} 次`,
      ``,
      `建议超时设置为 ${suggestedTimeout}ms（基于 P95 延迟 × 1.5）`,
    ].join('\n')
  }

  private buildTrendDescription(report: any): string {
    return [
      `工具 "${report.toolName}" 成功率趋势恶化：`,
      `- 近期成功率: ${(report.trend.currentRate * 100).toFixed(1)}%`,
      `- 远期成功率: ${(report.trend.previousRate * 100).toFixed(1)}%`,
      `- 变化: ${(report.trend.delta * 100).toFixed(1)}%`,
      `- 总调用: ${report.totalCalls} 次`,
      ``,
      `建议降低优先级，减少其对用户体验的潜在影响。`,
    ].join('\n')
  }

  private buildDisableDescription(report: any): string {
    return [
      `工具 "${report.toolName}" 错误率极高：`,
      `- 错误率: ${(report.errorRate * 100).toFixed(0)}%`,
      `- 成功: ${report.successCount}/${report.totalCalls}`,
      `- 总调用: ${report.totalCalls} 次`,
      report.failurePatterns.length > 0 ? `- 主要失败模式: ${report.failurePatterns[0].description}` : '',
      ``,
      `建议暂时禁用，待修复后再启用。`,
    ]
      .filter(Boolean)
      .join('\n')
  }
}
