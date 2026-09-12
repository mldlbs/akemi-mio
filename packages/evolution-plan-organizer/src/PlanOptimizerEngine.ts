/**
 * PlanOptimizerEngine — 计划优化分析引擎
 *
 * 核心职责：
 * 1. 读取所有活跃计划，构建结构化任务描述矩阵
 * 2. 使用 LLM 检测跨计划的任务重叠/冲突/冗余
 * 3. 返回 OptimizationSuggestion[]
 *
 * 设计约束：
 * - 不与自动化管道耦合（纯逻辑）
 * - 仅通过 PlanManagerLike 读取计划，不直接修改
 * - LLM 调用通过可注入的 analyzeFn 隔离（方便测试）
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { DevPlan } from '@akemi-mio/evolution/types'
import type { OptimizationAnalysis, OptimizationSuggestion, PlanTaskDescriptor, OptimizationCategory } from './PlanOptimizerTypes'

// =============================================================================
// LLM 分析函数类型
// =============================================================================

export type PlanAnalysisFn = (
  prompt: string,
  options?: { system?: string; temperature?: number; timeoutMs?: number },
) => Promise<{ data?: any; error?: string }>

// =============================================================================
// 配置
// =============================================================================

const MAX_SUGGESTIONS = 5
const LLM_TIMEOUT_MS = 60000

// =============================================================================
// PlanOptimizerEngine
// =============================================================================

export class PlanOptimizerEngine {
  private analyzeFn: PlanAnalysisFn | null = null

  /**
   * 注入 LLM 分析函数（通常为 LlmService.chatJson）。
   * 允许在测试时注入 mock。
   */
  setAnalyzeFn(fn: PlanAnalysisFn): void {
    this.analyzeFn = fn
  }

  /**
   * 分析所有计划，返回优化建议。
   *
   * @param plans 所有计划列表
   * @returns 优化分析结果
   */
  async analyze(plans: DevPlan[]): Promise<OptimizationAnalysis> {
    const analyzedAt = Date.now()
    const analyzedPlanIds = plans.map((p) => p.id)

    // 没有活跃计划 → 无需分析
    if (plans.length === 0) {
      return {
        analyzedAt,
        analyzedPlanIds: [],
        suggestions: [],
        summary: '当前没有计划需要分析。',
        hasOpportunity: false,
      }
    }

    // 只有一个计划 → 运行内部一致性检查（但仍可能发现重复步骤）
    if (plans.length === 1 && plans[0].steps.length <= 1) {
      return {
        analyzedAt,
        analyzedPlanIds,
        suggestions: [],
        summary: `当前只有 1 个计划（${plans[0].title}），无需跨计划优化。`,
        hasOpportunity: false,
      }
    }

    // 构建结构化任务描述矩阵
    const matrix = this.buildTaskMatrix(plans)

    // 使用规则引擎进行初步检测（快速路径）
    const ruleBasedSuggestions = this.ruleBasedDetection(matrix)
    log('INFO', 'plan_optimizer_rule_based', {
      suggestions: ruleBasedSuggestions.length,
    })

    // 如果需要更深入的分析，使用 LLM
    let llmSuggestions: OptimizationSuggestion[] = []
    if (this.analyzeFn && ruleBasedSuggestions.length < 3) {
      try {
        llmSuggestions = await this.llmBasedAnalysis(plans, matrix)
        log('INFO', 'plan_optimizer_llm_analysis', {
          suggestions: llmSuggestions.length,
        })
      } catch (err: any) {
        log('WARN', 'plan_optimizer_llm_error', { error: String(err) })
      }
    }

    // 合并 & 去重
    const merged = this.mergeAndDeduplicate([...ruleBasedSuggestions, ...llmSuggestions])

    // 裁剪到上限
    const suggestions = merged.slice(0, MAX_SUGGESTIONS)

    const summary = this.buildSummary(suggestions, plans.length)
    const hasOpportunity = suggestions.length > 0

    log('INFO', 'plan_optimizer_analysis_complete', {
      plansAnalyzed: plans.length,
      suggestionsFound: suggestions.length,
      hasOpportunity,
    })

    return {
      analyzedAt,
      analyzedPlanIds,
      suggestions,
      summary,
      hasOpportunity,
    }
  }

  // =============================================================================
  // 规则引擎检测（快速路径）
  // =============================================================================

  /**
   * 构建任务描述矩阵：结构化表示每个计划的每个步骤。
   */
  private buildTaskMatrix(plans: DevPlan[]): PlanTaskDescriptor[] {
    const matrix: PlanTaskDescriptor[] = []

    for (const plan of plans) {
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i]
        matrix.push({
          planId: plan.id,
          planTitle: plan.title,
          stepIndex: i,
          stepId: step.id,
          description: step.description,
          status: step.status,
          existingResult: step.result,
        })
      }
    }

    return matrix
  }

  /**
   * 基于规则的快速检测。
   * - 检测相同步骤描述在不同计划中的重复
   * - 检测同计划内的重复步骤
   */
  private ruleBasedDetection(matrix: PlanTaskDescriptor[]): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = []

    // 基于规范化描述的聚类
    const descriptionGroups = new Map<string, PlanTaskDescriptor[]>()

    for (const task of matrix) {
      const normalized = this.normalizeDescription(task.description)
      if (!normalized) continue
      const key = `${normalized}:${task.status}`
      if (!descriptionGroups.has(key)) {
        descriptionGroups.set(key, [])
      }
      descriptionGroups.get(key)!.push(task)
    }

    // 检测跨计划重复
    for (const [, group] of descriptionGroups) {
      if (group.length < 2) continue

      // 检查是否来自不同计划
      const uniquePlans = new Set(group.map((t) => t.planId))
      if (uniquePlans.size < 2) continue

      const confidence = Math.min(0.7 + group.length * 0.05, 0.9)

      suggestions.push({
        id: `duplicate_${Date.now()}_${suggestions.length}`,
        category: 'duplicate_task',
        title: `跨计划重复任务：${group[0].description.slice(0, 40)}`,
        description: `检测到 ${group.length} 个相似任务分布在 ${uniquePlans.size} 个计划中。建议合并为一个计划中的单一任务。`,
        affectedTasks: [...group],
        mergeTarget: {
          planId: group[0].planId,
          stepIndex: group[0].stepIndex,
        },
        mergedDescription: group[0].description,
        suggestedAction: 'merge',
        confidence,
        autoExecutable: confidence >= 0.85,
      })
    }

    // 检测同计划内重复步骤
    const planStepMap = new Map<string, PlanTaskDescriptor[]>()
    for (const task of matrix) {
      const key = task.planId
      if (!planStepMap.has(key)) planStepMap.set(key, [])
      planStepMap.get(key)!.push(task)
    }

    for (const [, tasks] of planStepMap) {
      const seen = new Map<string, PlanTaskDescriptor[]>()
      for (const task of tasks) {
        const normalized = this.normalizeDescription(task.description)
        if (!normalized) continue
        if (!seen.has(normalized)) seen.set(normalized, [])
        seen.get(normalized)!.push(task)
      }

      for (const [, group] of seen) {
        if (group.length < 2) continue
        const planId = group[0].planId

        // 检查是否已有跨计划建议覆盖了这些任务
        const alreadyCovered = suggestions.some((s) => s.affectedTasks.some((t) => t.planId === planId && t.stepId === group[0].stepId))
        if (alreadyCovered) continue

        suggestions.push({
          id: `internal_dup_${Date.now()}_${suggestions.length}`,
          category: 'redundant_task',
          title: `计划内重复步骤：${group[0].planTitle}`,
          description: `计划 "${group[0].planTitle}" 中有 ${group.length} 个步骤描述相似。建议删除多余的重复步骤。`,
          affectedTasks: group,
          mergeTarget: {
            planId: group[0].planId,
            stepIndex: group[0].stepIndex,
          },
          mergedDescription: group[0].description,
          suggestedAction: 'merge',
          confidence: 0.8,
          autoExecutable: false, // 删除步骤需要人工确认
        })
      }
    }

    return suggestions
  }

  /**
   * 规范化步骤描述用于比较。
   * 去除标点、空格、转小写。
   */
  private normalizeDescription(desc: string): string {
    return desc
      .toLowerCase()
      .replace(/[\s\p{P}]+/gu, ' ')
      .trim()
      .slice(0, 100)
  }

  // =============================================================================
  // LLM 深度分析
  // =============================================================================

  /**
   * 使用 LLM 进行深入的跨计划分析。
   * 检测规则引擎无法发现的模式：
   * - 语义相似但措辞不同的任务
   * - 隐式依赖链
   * - 资源冲突
   */
  private async llmBasedAnalysis(plans: DevPlan[], matrix: PlanTaskDescriptor[]): Promise<OptimizationSuggestion[]> {
    if (!this.analyzeFn) return []

    const planSummaries = plans
      .map(
        (p) =>
          `计划: "${p.title}" (ID: ${p.id}, 状态: ${p.status}, 优先级: ${p.priority ?? 0})
  步骤:
${p.steps.map((s, i) => `    ${i}. [${s.status}] ${s.description}${s.result ? ` → ${s.result.slice(0, 60)}` : ''}`).join('\n')}`,
      )
      .join('\n\n')

    const prompt = [
      '你是一个计划优化分析专家。请分析以下多个开发计划，检测：',
      '',
      '1. **语义重复任务**：不同计划中措辞不同但目标相同的任务',
      '2. **冲突任务**：可能修改相同文件或产生冲突结果的任务',
      '3. **隐式依赖链**：一个计划的输出是另一个计划的输入',
      '4. **资源竞争**：需要同一资源（如 LLM 调用、文件系统操作）的任务',
      '',
      '请以 JSON 格式返回分析结果：',
      '```json',
      '{',
      '  "suggestions": [',
      '    {',
      '      "category": "duplicate_task" | "conflicting_task" | "dependency_chain" | "resource_contention",',
      '      "title": "简短标题",',
      '      "description": "详细说明优化理由和方案",',
      '      "affectedTaskKeys": ["planId:stepIndex", ...],  // 关联任务的 planId:stepIndex',
      '      "suggestedAction": "merge" | "delete" | "reorder",',
      '      "confidence": 0.0-1.0,  // 你对此建议的把握程度',
      '      "autoExecutable": true/false  // 是否可以自动执行',
      '    }',
      '  ],',
      '  "summary": "整体分析概述"',
      '}',
      '```',
      '',
      '---',
      '',
      planSummaries,
    ].join('\n')

    const result = await this.analyzeFn(prompt, {
      system: '你是一个严谨的计划优化分析专家。请仔细分析计划间的重叠和冲突，仅在有明确的优化价值时提出建议。返回严格的 JSON 格式。',
      temperature: 0.2,
      timeoutMs: LLM_TIMEOUT_MS,
    })

    if (result.error || !result.data) {
      log('WARN', 'plan_optimizer_llm_analysis_failed', {
        error: result.error || 'empty response',
      })
      return []
    }

    return this.parseLlmSuggestions(result.data, matrix)
  }

  /**
   * 解析 LLM 返回的优化建议，转换为 OptimizationSuggestion。
   */
  private parseLlmSuggestions(raw: any, matrix: PlanTaskDescriptor[]): OptimizationSuggestion[] {
    try {
      if (!raw.suggestions || !Array.isArray(raw.suggestions)) return []

      // 构建查找映射
      const taskMap = new Map<string, PlanTaskDescriptor>()
      for (const task of matrix) {
        taskMap.set(`${task.planId}:${task.stepIndex}`, task)
      }

      const validCategories = new Set<OptimizationCategory>([
        'duplicate_task',
        'conflicting_task',
        'redundant_task',
        'dependency_chain',
        'resource_contention',
      ])

      const suggestions: OptimizationSuggestion[] = []

      for (const rawSuggestion of raw.suggestions) {
        if (suggestions.length >= MAX_SUGGESTIONS) break

        const category = rawSuggestion.category as OptimizationCategory
        if (!validCategories.has(category)) continue

        const affectedTasks: PlanTaskDescriptor[] = []
        if (Array.isArray(rawSuggestion.affectedTaskKeys)) {
          for (const key of rawSuggestion.affectedTaskKeys) {
            const task = taskMap.get(key)
            if (task) affectedTasks.push(task)
          }
        }

        if (affectedTasks.length < 2) continue

        const confidence = Math.min(Math.max(rawSuggestion.confidence ?? 0.5, 0), 1)
        const autoExecutable = rawSuggestion.autoExecutable === true && confidence >= 0.85

        suggestions.push({
          id: `llm_opt_${Date.now()}_${suggestions.length}`,
          category,
          title: String(rawSuggestion.title ?? '优化建议').slice(0, 100),
          description: String(rawSuggestion.description ?? '').slice(0, 500),
          affectedTasks,
          suggestedAction: rawSuggestion.suggestedAction ?? 'merge',
          confidence,
          autoExecutable,
        })
      }

      return suggestions
    } catch (err) {
      log('WARN', 'plan_optimizer_parse_llm_error', { error: String(err) })
      return []
    }
  }

  // =============================================================================
  // 合并 & 去重
  // =============================================================================

  private mergeAndDeduplicate(suggestions: OptimizationSuggestion[]): OptimizationSuggestion[] {
    const seen = new Set<string>()
    const result: OptimizationSuggestion[] = []

    for (const s of suggestions) {
      // 去重 key：受影响的 planId:stepIndex 组合
      const affectedKey = s.affectedTasks
        .map((t) => `${t.planId}:${t.stepIndex}`)
        .sort()
        .join(',')

      if (seen.has(affectedKey)) continue
      seen.add(affectedKey)
      result.push(s)
    }

    // 按置信度降序排列
    result.sort((a, b) => b.confidence - a.confidence)
    return result
  }

  // =============================================================================
  // 摘要构建
  // =============================================================================

  private buildSummary(suggestions: OptimizationSuggestion[], planCount: number): string {
    if (suggestions.length === 0) {
      if (planCount <= 1) {
        return '当前仅有一个活跃计划，无需跨计划优化。'
      }
      return `分析了 ${planCount} 个计划，未发现需要优化的任务重叠或冲突。`
    }

    const byCategory = new Map<string, number>()
    for (const s of suggestions) {
      byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + 1)
    }

    const categoryLabels: Record<string, string> = {
      duplicate_task: '重复任务',
      conflicting_task: '冲突任务',
      redundant_task: '冗余任务',
      dependency_chain: '依赖链',
      resource_contention: '资源竞争',
    }

    const breakdown = [...byCategory.entries()].map(([cat, count]) => `${categoryLabels[cat] ?? cat}: ${count}个`).join('；')

    return (
      `分析了 ${planCount} 个计划，发现 ${suggestions.length} 个优化机会（${breakdown}）。` +
      `其中 ${suggestions.filter((s) => s.autoExecutable).length} 个可自动执行。`
    )
  }
}

/** 全局单例 */
export const planOptimizerEngine = new PlanOptimizerEngine()
