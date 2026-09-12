/**
 * PlanFeedbackStore — 调度反馈收集与策略优化存储
 *
 * 职责（Agnost AI 风格反馈提取）：
 * 1. 收集每次 PlanTask 执行的反馈数据
 * 2. 按时间窗口聚合指标
 * 3. 识别工具选择偏差和错误模式
 * 4. 生成可操作的调度优化建议
 *
 * 设计：
 * - FeedbackRecord 包含完整上下文（工具选择、耗时、错误）
 * - 聚合器统计工具成功率、常见错误
 * - 优化建议基于统计异常触发
 */

import { type FeedbackRecord, type SchedulerMetrics, type PlanSchedulerDeps } from './types'

export class PlanFeedbackStore {
  private records: FeedbackRecord[] = []
  private deps: PlanSchedulerDeps
  private feedbackWindowMs: number

  constructor(deps: PlanSchedulerDeps, feedbackWindowMs = 7 * 24 * 60 * 60 * 1000) {
    this.deps = deps
    this.feedbackWindowMs = feedbackWindowMs
  }

  // ── 记录收集 ──────────────────────────────────────────────

  /**
   * 记录一次步骤执行的反馈。
   */
  record(record: FeedbackRecord): void {
    this.records.push(record)
    this.deps.emitEvent({ type: 'feedback.collected', record })

    this.deps.log('INFO', 'plan_feedback_recorded', {
      planId: record.planId,
      stepIndex: record.stepIndex,
      toolUsed: record.toolUsed,
      success: record.success,
      durationMs: record.durationMs,
      wasDegraded: record.wasDegraded,
    })

    // 自动清理旧数据
    this.prune()
  }

  /**
   * 批量记录反馈。
   */
  recordBatch(records: FeedbackRecord[]): void {
    for (const r of records) {
      this.record(r)
    }
  }

  // ── 查询 ──────────────────────────────────────────────

  /**
   * 获取指定计划的所有反馈记录。
   */
  getPlanRecords(planId: string): FeedbackRecord[] {
    return this.records.filter((r) => r.planId === planId)
  }

  /**
   * 获取指定工具的反馈记录。
   */
  getToolRecords(toolName: string): FeedbackRecord[] {
    return this.records.filter((r) => r.toolUsed === toolName)
  }

  /**
   * 获取最近的反馈记录（按时间窗口）。
   */
  getRecentRecords(): FeedbackRecord[] {
    const cutoff = Date.now() - this.feedbackWindowMs
    return this.records.filter((r) => r.createdAt >= cutoff)
  }

  /** 获取所有记录 */
  getAllRecords(): FeedbackRecord[] {
    return [...this.records]
  }

  // ── 指标聚合 ──────────────────────────────────────────────

  /**
   * 聚合当前窗口内的调度指标。
   * 包含工具使用统计、成功率、错误模式、优化建议。
   */
  getMetrics(): SchedulerMetrics {
    const recent = this.getRecentRecords()
    const total = recent.length
    if (total === 0) {
      return {
        totalTasks: 0,
        succeededTasks: 0,
        failedTasks: 0,
        successRate: 0,
        avgDurationMs: 0,
        toolUsage: {},
        toolSuccessRate: {},
        errorPatterns: [],
        suggestions: [],
      }
    }

    const succeeded = recent.filter((r) => r.success).length
    const failed = total - succeeded
    const avgDuration = recent.reduce((s, r) => s + r.durationMs, 0) / total

    // 工具使用统计
    const toolUsage: Record<string, number> = {}
    const toolSuccess: Record<string, { ok: number; total: number }> = {}
    for (const r of recent) {
      if (r.toolUsed) {
        toolUsage[r.toolUsed] = (toolUsage[r.toolUsed] ?? 0) + 1
        if (!toolSuccess[r.toolUsed]) toolSuccess[r.toolUsed] = { ok: 0, total: 0 }
        toolSuccess[r.toolUsed].total++
        if (r.success) toolSuccess[r.toolUsed].ok++
      }
    }

    const toolSuccessRate: Record<string, number> = {}
    for (const [tool, stats] of Object.entries(toolSuccess)) {
      toolSuccessRate[tool] = stats.total > 0 ? stats.ok / stats.total : 0
    }

    // 错误模式
    const errorCounts = new Map<string, number>()
    for (const r of recent) {
      if (r.error) {
        // 截取错误类型前缀（归类）
        const normalized = r.error.replace(/:\s*\d+.*$/, '') // 去掉行号等细节
        errorCounts.set(normalized, (errorCounts.get(normalized) ?? 0) + 1)
      }
    }

    const errorPatterns = Array.from(errorCounts.entries())
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    // 优化建议
    const suggestions = this.generateSuggestions(toolSuccessRate, errorPatterns, total, succeeded)

    return {
      totalTasks: total,
      succeededTasks: succeeded,
      failedTasks: failed,
      successRate: total > 0 ? succeeded / total : 0,
      avgDurationMs: avgDuration,
      toolUsage,
      toolSuccessRate,
      errorPatterns,
      suggestions,
    }
  }

  /**
   * 基于统计数据生成优化建议。
   * Agnost AI 风格：从数据中提取 actionable 的改进点。
   */
  private generateSuggestions(
    toolSuccessRate: Record<string, number>,
    errorPatterns: Array<{ error: string; count: number }>,
    total: number,
    succeeded: number,
  ): string[] {
    const suggestions: string[] = []

    // 1. 低成功率的工具
    for (const [tool, rate] of Object.entries(toolSuccessRate)) {
      if (rate < 0.5 && total >= 3) {
        suggestions.push(`工具 "${tool}" 成功率仅 ${(rate * 100).toFixed(0)}%，考虑使用备选工具或检查环境配置`)
      } else if (rate < 0.8 && total >= 5) {
        suggestions.push(`工具 "${tool}" 成功率 ${(rate * 100).toFixed(0)}%，建议检查是否存在间歇性问题`)
      }
    }

    // 2. 高频错误模式
    for (const { error, count } of errorPatterns) {
      if (count >= 3) {
        suggestions.push(`高频错误 "${error}" 出现 ${count} 次，建议检查相关依赖或环境配置`)
      }
    }

    // 3. 整体成功率
    if (total >= 5) {
      const rate = succeeded / total
      if (rate < 0.6) {
        suggestions.push(`整体成功率 ${(rate * 100).toFixed(0)}% 偏低，建议减少并行度或增加重试次数`)
      } else if (rate > 0.95) {
        suggestions.push(`整体成功率 ${(rate * 100).toFixed(0)}% 良好，可考虑增加并行度以提高效率`)
      }
    }

    // 4. 降级使用率
    const degradedCount = this.getRecentRecords().filter((r) => r.wasDegraded).length
    if (degradedCount > total * 0.3 && total >= 3) {
      suggestions.push(`降级执行比例 ${((degradedCount / total) * 100).toFixed(0)}% 偏高，可能需要优先调整工具分配的初始策略`)
    }

    return suggestions
  }

  // ── 维护 ──────────────────────────────────────────────

  /** 清理窗口外的旧数据 */
  private prune(): void {
    const cutoff = Date.now() - this.feedbackWindowMs
    const before = this.records.length
    this.records = this.records.filter((r) => r.createdAt >= cutoff)
    const pruned = before - this.records.length
    if (pruned > 0) {
      this.deps.log('INFO', 'plan_feedback_pruned', { pruned, remaining: this.records.length })
    }
  }

  /** 清空所有记录 */
  clear(): void {
    this.records = []
  }
}
