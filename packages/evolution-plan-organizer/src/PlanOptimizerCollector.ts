/**
 * PlanOptimizerCollector — 计划优化采集器
 *
 * 作为 SignalCollector 接入自动化管道：
 * 1. 从 DrizzlePlanManager 读取所有活跃计划
 * 2. 使用 PlanOptimizerEngine 进行跨计划重叠/冲突分析
 * 3. 将 OptimizationSuggestion 转换为 Problem 条目
 *    （source: 'feature'，供后续 Executor 消费）
 *
 * 运行条件：
 * - 至少间隔 2 小时（匹配进化周期）
 * - 至少 2 个活跃计划（单计划仅做内部检查）
 *
 * 安全设计：
 * - 所有建议默认 autoExecutable=false
 * - 只有在 LLM 高置信度（>= 0.85）且明确标注时才自动执行
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { SignalCollector, Problem, ProblemSource } from '@akemi-mio/evolution/automation/types'
import type { PlanManagerLike } from '@akemi-mio/evolution/types'
import { PlanIntegrityChecker } from '@akemi-mio/evolution-core'
import { planOptimizerEngine } from './PlanOptimizerEngine'
import type { OptimizationSuggestion } from './PlanOptimizerTypes'

// =============================================================================
// 配置
// =============================================================================

/** 采集最小间隔（匹配进化周期 2h） */
const COLLECT_INTERVAL_MS = 2 * 60 * 60 * 1000
/** 单次采集最大生成的问题数 */
const MAX_PROBLEMS_PER_COLLECT = 5

// =============================================================================
// PlanOptimizerCollector
// =============================================================================

export class PlanOptimizerCollector implements SignalCollector {
  readonly name = 'PlanOptimizerCollector'
  readonly source: ProblemSource = 'feature'

  private lastRunAt = 0
  private planManager: PlanManagerLike | null = null
  private seenSuggestionIds = new Set<string>()

  /** 注入 PlanManager */
  setPlanManager(pm: PlanManagerLike): void {
    this.planManager = pm
  }

  shouldRun(): boolean {
    if (Date.now() - this.lastRunAt < COLLECT_INTERVAL_MS) return false
    if (!this.planManager) return false

    // 至少 2 个活跃计划才有跨计划优化的价值
    const plans = this.planManager.listPlans()
    const activePlans = plans.filter((p) => p.status === 'active')
    if (activePlans.length < 2) return false

    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRunAt = Date.now()
    log('INFO', 'plan_optimizer_collector_start')

    const problems: Problem[] = []

    if (!this.planManager) {
      log('INFO', 'plan_optimizer_collector_no_manager')
      return problems
    }

    try {
      const allPlans = this.planManager.listPlans()
      const activePlans = allPlans.filter((p) => p.status === 'active')

      if (activePlans.length < 2) {
        log('INFO', 'plan_optimizer_collector_insufficient', {
          activeCount: activePlans.length,
        })
        return problems
      }

      log('INFO', 'plan_optimizer_collector_analyzing', {
        totalPlans: allPlans.length,
        activePlans: activePlans.length,
      })

      // 运行完整性检查（与 SelfEvolutionService.performIntegrityCheck 一致）
      this.performIntegrityCheck()

      // 使用优化引擎分析
      const analysis = await planOptimizerEngine.analyze(activePlans)

      if (!analysis.hasOpportunity) {
        log('INFO', 'plan_optimizer_collector_no_opportunity', {
          summary: analysis.summary,
        })
        return problems
      }

      // 将 OptimizationSuggestion 转换为 Problem
      for (const suggestion of analysis.suggestions) {
        if (problems.length >= MAX_PROBLEMS_PER_COLLECT) break

        // 跨采集去重
        if (this.seenSuggestionIds.has(suggestion.id)) continue
        this.seenSuggestionIds.add(suggestion.id)

        const problem = this.suggestionToProblem(suggestion, analysis.analyzedAt)
        if (problem) problems.push(problem)
      }

      log('INFO', 'plan_optimizer_collector_result', {
        suggestions: analysis.suggestions.length,
        problemsGenerated: problems.length,
      })
    } catch (err) {
      log('ERROR', 'plan_optimizer_collector_error', {
        error: String(err),
      })
    }

    return problems
  }

  /**
   * 将优化建议转换为 Problem 条目。
   */
  private suggestionToProblem(suggestion: OptimizationSuggestion, analyzedAt: number): Problem | null {
    const planTitles = [...new Set(suggestion.affectedTasks.map((t) => t.planTitle))]

    const title = `[计划优化] ${suggestion.title}`
    const description = [
      `【计划优化建议 - 自动检测】`,
      ``,
      `- 分类: ${this.categoryLabel(suggestion.category)}`,
      `- 置信度: ${(suggestion.confidence * 100).toFixed(0)}%`,
      `- 自动执行: ${suggestion.autoExecutable ? '是' : '否（需审批）'}`,
      ``,
      `- 涉及计划: ${planTitles.join('、')}`,
      `- 涉及任务数: ${suggestion.affectedTasks.length}`,
      ``,
      ...suggestion.affectedTasks.map((t) => `  [${t.planTitle}] 步骤 ${t.stepIndex}: ${t.description.slice(0, 80)}`),
      ``,
      `- 建议操作: ${this.actionLabel(suggestion.suggestedAction)}`,
      `- 详细说明:`,
      `  ${suggestion.description}`,
      ``,
      `【自动优化执行器将根据配置处理此建议】`,
    ].join('\n')

    return {
      id: `plan_opt_${suggestion.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)}`,
      source: this.source,
      severity: 'warning',
      title: title.slice(0, 200),
      description: description.slice(0, 2000),
      estimatedCostChars: description.length + 500,
      lastSeen: analyzedAt,
      occurrenceCount: 1,
      context: {
        raw: JSON.stringify(suggestion),
        metadata: {
          optimizationCategory: suggestion.category,
          confidence: String(suggestion.confidence),
          autoExecutable: String(suggestion.autoExecutable),
          suggestedAction: suggestion.suggestedAction,
          affectedPlans: planTitles.join(','),
          mergedDescription: suggestion.mergedDescription ?? '',
        },
      },
    }
  }

  // ==================== 完整性检查 ====================

  private performIntegrityCheck(): void {
    if (!this.planManager) return

    try {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      const abandonedCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      const removed = this.planManager.cleanupOldPlans?.(cutoff, abandonedCutoff) ?? 0
      if (removed > 0) log('INFO', 'plan_optimizer_plan_cleanup', { removed })
    } catch (err: any) {
      log('WARN', 'plan_optimizer_plan_cleanup_error', { error: String(err) })
    }

    try {
      const checker = new PlanIntegrityChecker()
      const allPlans = this.planManager.listPlans()
      const result = checker.checkAllPlans(allPlans)
      if (!result.passed) {
        log('WARN', 'plan_optimizer_integrity_issues', {
          error_count: result.issues.filter((i: any) => i.severity === 'error').length,
        })
      }
    } catch (err: any) {
      log('WARN', 'plan_optimizer_integrity_error', { error: String(err) })
    }
  }

  // ==================== 辅助方法 ====================

  private categoryLabel(category: string): string {
    const labels: Record<string, string> = {
      duplicate_task: '重复任务',
      conflicting_task: '冲突任务',
      redundant_task: '冗余任务',
      dependency_chain: '依赖链',
      resource_contention: '资源竞争',
    }
    return labels[category] ?? category
  }

  private actionLabel(action: string): string {
    const labels: Record<string, string> = {
      merge: '合并任务',
      delete: '删除任务',
      reorder: '重新排序',
      split: '拆分任务',
    }
    return labels[action] ?? action
  }
}

/** 全局单例 */
export const planOptimizerCollector = new PlanOptimizerCollector()
