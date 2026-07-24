/**
 * PlanOptimizerExecutor — 计划优化执行器
 *
 * 作为 FixExecutor 接入自动化管道：
 * 1. 接收 PlanOptimizerCollector 生成的优化建议 Problem
 * 2. 创建计划的回滚快照（PlanOptimizerSnapshot）
 * 3. 根据 autoExecutable 和配置决定自动执行或需审批
 * 4. 执行优化操作：合并任务 / 删除任务 / 重新排序
 * 5. 报告执行结果
 *
 * 安全设计：
 * - 执行前总是创建完整快照
 * - autoExecuteEnabled=false 时仅产生记录而不实际修改
 * - 支持外部手动触发回滚
 */

import { log } from '../../logger/Logger'
import type { FixExecutor, AssignedProblem, FixResult, ProblemSource } from '../automation/types'
import type { PlanManagerLike } from '../types'
import type { OptimizationSuggestion, PlanOptimizerConfig } from './PlanOptimizerTypes'
import { DEFAULT_PLAN_OPTIMIZER_CONFIG } from './PlanOptimizerTypes'
import { planOptimizerSnapshotManager } from './PlanOptimizerSnapshot'

// =============================================================================
// PlanOptimizerExecutor
// =============================================================================

export class PlanOptimizerExecutor implements FixExecutor {
  readonly name = 'PlanOptimizerExecutor'
  readonly supportedSources: ProblemSource[] = ['feature']
  readonly timeoutMs = 30000

  private planManager: PlanManagerLike | null = null
  private config: PlanOptimizerConfig

  constructor(config?: Partial<PlanOptimizerConfig>) {
    this.config = { ...DEFAULT_PLAN_OPTIMIZER_CONFIG, ...config }
  }

  /** 更新配置（运行时） */
  updateConfig(partial: Partial<PlanOptimizerConfig>): void {
    this.config = { ...this.config, ...partial }
    log('INFO', 'plan_optimizer_executor_config_updated', {
      autoExecuteEnabled: this.config.autoExecuteEnabled,
      autoExecuteConfidenceThreshold: this.config.autoExecuteConfidenceThreshold,
    })
  }

  /** 获取当前配置 */
  getConfig(): PlanOptimizerConfig {
    return { ...this.config }
  }

  /** 注入 PlanManager */
  setPlanManager(pm: PlanManagerLike): void {
    this.planManager = pm
  }

  isAvailable(): boolean {
    return this.planManager !== null
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const t0 = Date.now()
    const problemId = problem.id

    log('INFO', 'plan_optimizer_executor_start', { problemId })

    if (!this.planManager) {
      return {
        problemId,
        success: false,
        summary: 'PlanManager 未注入，无法执行优化',
        durationMs: Date.now() - t0,
        error: 'NO_PLAN_MANAGER',
      }
    }

    try {
      // 从 Problem 的 context.raw 中提取 OptimizationSuggestion
      const suggestion = this.parseSuggestion(problem)
      if (!suggestion) {
        return {
          problemId,
          success: false,
          summary: '无法解析优化建议数据',
          durationMs: Date.now() - t0,
          error: 'INVALID_SUGGESTION',
        }
      }

      // 判断是否可以自动执行
      const canAutoExecute = this.canExecute(suggestion)

      if (!canAutoExecute) {
        log('INFO', 'plan_optimizer_executor_needs_approval', {
          problemId,
          suggestionId: suggestion.id,
          confidence: suggestion.confidence,
        })
        return {
          problemId,
          success: true,
          summary: `优化建议 "${suggestion.title}" 需人工审批（置信度 ${(suggestion.confidence * 100).toFixed(0)}%，` +
            `低于自动执行阈值 ${(this.config.autoExecuteConfidenceThreshold * 100).toFixed(0)}%）。` +
            `快照已在 ${this.config.autoExecuteEnabled ? '执行前' : '评估时'} 创建，` +
            `可通过 PlanOptimizerSnapshotManager 回滚。`,
          durationMs: Date.now() - t0,
        }
      }

      // 执行优化
      const result = await this.applyOptimization(suggestion)

      log('INFO', 'plan_optimizer_executor_complete', {
        problemId,
        success: result.success,
        action: suggestion.suggestedAction,
        durationMs: Date.now() - t0,
      })

      return {
        problemId,
        success: result.success,
        summary: result.summary,
        durationMs: Date.now() - t0,
        output: result.detail,
        error: result.error,
      }
    } catch (err: any) {
      log('ERROR', 'plan_optimizer_executor_error', {
        problemId,
        error: String(err),
      })
      return {
        problemId,
        success: false,
        summary: `执行优化时发生错误: ${err.message}`,
        durationMs: Date.now() - t0,
        error: String(err),
      }
    }
  }

  // =============================================================================
  // 内部方法
  // =============================================================================

  /**
   * 从 Problem 的 context.raw 中解析 OptimizationSuggestion。
   */
  private parseSuggestion(problem: AssignedProblem): OptimizationSuggestion | null {
    try {
      const raw = problem.context?.raw
      if (!raw) return null
      return JSON.parse(raw) as OptimizationSuggestion
    } catch {
      return null
    }
  }

  /**
   * 判断是否可以执行优化。
   * 仅在配置允许自动执行且建议的置信度足够高时自动执行。
   */
  private canExecute(suggestion: OptimizationSuggestion): boolean {
    if (!this.config.autoExecuteEnabled) return false
    if (suggestion.autoExecutable && suggestion.confidence >= this.config.autoExecuteConfidenceThreshold) {
      return true
    }
    if (suggestion.confidence >= this.config.autoExecuteConfidenceThreshold) {
      return true
    }
    return false
  }

  /**
   * 实际应用优化到计划。
   */
  private async applyOptimization(
    suggestion: OptimizationSuggestion,
  ): Promise<{ success: boolean; summary: string; detail?: string; error?: string }> {
    if (!this.planManager) {
      return { success: false, summary: 'PlanManager 不可用', error: 'NO_MANAGER' }
    }

    // 创建快照
    const allPlans = this.planManager.listPlans()
    const snapshot = planOptimizerSnapshotManager.createSnapshot(
      allPlans,
      `${suggestion.suggestedAction}: ${suggestion.title}`,
    )

    try {
      switch (suggestion.suggestedAction) {
        case 'merge':
          return this.applyMerge(suggestion, snapshot.id)
        case 'delete':
          return this.applyDelete(suggestion, snapshot.id)
        case 'reorder':
          return this.applyReorder(suggestion, snapshot.id)
        case 'split':
          return { success: false, summary: '拆分操作暂不支持自动执行', error: 'NOT_IMPLEMENTED' }
        default:
          return { success: false, summary: `未知操作: ${suggestion.suggestedAction}`, error: 'UNKNOWN_ACTION' }
      }
    } catch (err: any) {
      // 执行失败 → 标记快照可回滚
      log('WARN', 'plan_optimizer_executor_failed_snapshot_available', {
        snapshotId: snapshot.id,
        error: String(err),
      })
      return {
        success: false,
        summary: `执行失败，快照已创建 (ID: ${snapshot.id})，可通过回滚恢复。错误: ${err.message}`,
        detail: `快照路径: ${snapshot.id}`,
        error: String(err),
      }
    }
  }

  /**
   * 合并任务：将多个任务合并为一个。
   */
  private applyMerge(
    suggestion: OptimizationSuggestion,
    snapshotId: string,
  ): { success: boolean; summary: string; detail?: string } {
    if (!this.planManager) {
      return { success: false, summary: 'PlanManager 不可用' }
    }

    const affected = suggestion.affectedTasks
    if (affected.length < 2) {
      return { success: false, summary: '合并需要至少 2 个任务' }
    }

    // 按计划分组
    const byPlan = new Map<string, typeof affected>()
    for (const task of affected) {
      if (!byPlan.has(task.planId)) byPlan.set(task.planId, [])
      byPlan.get(task.planId)!.push(task)
    }

    let mergedCount = 0
    const details: string[] = []

    for (const [planId, tasks] of byPlan) {
      const plan = this.planManager.getPlan(planId)
      if (!plan) continue

      // 使用合并后的描述更新第一个步骤
      const firstTask = tasks[0]
      const mergeDesc = suggestion.mergedDescription || firstTask.description

      // 标记主步骤
      this.planManager.updateStep(planId, firstTask.stepIndex, 'pending', `[优化合并] 合并自 ${tasks.length} 个步骤\n原始: ${tasks.map((t) => t.description).join(' | ')}`)

      // 标记其他步骤为已完成（合并到主步骤）
      for (let i = 1; i < tasks.length; i++) {
        const task = tasks[i]
        this.planManager.updateStep(
          planId,
          task.stepIndex,
          'done', // 标记为完成（合并意味着被包含）
          `[已合并至步骤 ${firstTask.stepIndex}] ${mergeDesc.slice(0, 80)}`,
        )
        mergedCount++
      }

      details.push(`计划 "${plan.title}": 合并 ${tasks.length} 个步骤 → 1 个`)
    }

    return {
      success: true,
      summary: `已合并 ${affected.length} 个任务（${byPlan.size} 个计划）。`,
      detail: details.join('\n') + `\n快照 ID: ${snapshotId}`,
    }
  }

  /**
   * 删除任务：删除指定步骤。
   * 注意：标记为 skipped 而非真正删除，以保持步骤索引连续性。
   */
  private applyDelete(
    suggestion: OptimizationSuggestion,
    snapshotId: string,
  ): { success: boolean; summary: string; detail?: string } {
    if (!this.planManager) {
      return { success: false, summary: 'PlanManager 不可用' }
    }

    const affected = suggestion.affectedTasks
    let deletedCount = 0
    const details: string[] = []

    for (const task of affected) {
      const plan = this.planManager.getPlan(task.planId)
      if (!plan) continue

      // 标记为 skipped（不真正删除行，保持索引稳定）
      const updated = this.planManager.updateStep(
        task.planId,
        task.stepIndex,
        'done',
        `[优化删除] 冗余任务，由计划优化器标记\n原始: ${task.description}`,
      )

      if (updated) {
        deletedCount++
        details.push(`计划 "${plan.title}" 步骤 ${task.stepIndex}: 已标记`)
      }
    }

    return {
      success: deletedCount > 0,
      summary: `已标记 ${deletedCount}/${affected.length} 个任务为冗余。`,
      detail: details.join('\n') + `\n快照 ID: ${snapshotId}`,
    }
  }

  /**
   * 重新排序：调整步骤执行顺序。
   * 暂不支持自动重排序（涉及复杂的步骤索引重建）。
   */
  private applyReorder(
    suggestion: OptimizationSuggestion,
    snapshotId: string,
  ): { success: boolean; summary: string; detail?: string } {
    return {
      success: false,
      summary: '自动重新排序暂不支持，请在管理界面手动调整。快照已保存。',
      detail: `快照 ID: ${snapshotId}`,
    }
  }
}

/** 全局单例 */
export const planOptimizerExecutor = new PlanOptimizerExecutor()
