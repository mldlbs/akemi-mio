/**
 * ToolDefaultAdjuster — 工具默认参数调整器
 *
 * 根据 BehaviorPreferenceStore 中学习到的用户偏好，
 * 为工具调用生成参数默认值的推荐提示片段，
 * 以及任务流推荐。
 *
 * ## 核心功能
 * 1. 为已知工具生成默认参数 Hints（注入 system prompt）
 * 2. 基于工具使用频率推荐常用工作流
 * 3. 根据纠正统计标记用户偏好趋势
 *
 * ## 与 BehaviorRuleEngine 的关系
 * - BehaviorRuleEngine: 根据 BehaviorProfile 的决策输出（详略度、工具自动触发等）
 * - ToolDefaultAdjuster: 根据 BehaviorPreferenceStore 的统计输出（参数默认值、工作流推荐）
 * - 两者互补，合并后注入 system prompt
 *
 * @module behavior
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { behaviorPreferenceStore } from './BehaviorPreferenceStore'
import type { PreferenceSnapshot } from './BehaviorPreferenceStore'

// ══════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════

/** 单条工具参数默认推荐 */
export interface ToolDefaultHint {
  /** 工具名 */
  toolName: string
  /** 参数名 */
  paramName: string
  /** 推荐值 */
  value: unknown
  /** 置信度 (0-1) */
  confidence: number
  /** 学习来源（'correction' | 'frequency' | 'explicit'） */
  source: 'correction' | 'frequency' | 'explicit'
}

/** 工作流推荐 */
export interface WorkflowRecommendation {
  /** 工作流名称 */
  name: string
  /** 推荐理由 */
  reason: string
  /** 匹配度 (0-1) */
  matchScore: number
}

/** 调整结果 */
export interface AdjustmentResult {
  /** 工具参数默认提示 */
  toolDefaultHints: ToolDefaultHint[]
  /** 工作流推荐 */
  workflowRecommendations: WorkflowRecommendation[]
  /** 格式化后的 system prompt 片段 */
  formattedPrompt: string
  /** 是否包含有效数据 */
  hasData: boolean
}

// ══════════════════════════════════════════
// ToolDefaultAdjuster
// ══════════════════════════════════════════

export class ToolDefaultAdjuster {
  /**
   * 从 BehaviorPreferenceStore 的快照生成调整结果。
   *
   * @returns AdjustmentResult 包含工具默认参数提示和工作流推荐
   */
  adjust(): AdjustmentResult {
    const snapshot = behaviorPreferenceStore.getSnapshot()
    const hints = this.buildToolDefaultHints(snapshot)
    const workflows = this.buildWorkflowRecommendations(snapshot)
    const formattedPrompt = this.buildFormattedPrompt(hints, workflows, snapshot)

    return {
      toolDefaultHints: hints,
      workflowRecommendations: workflows,
      formattedPrompt,
      hasData: hints.length > 0 || workflows.length > 0,
    }
  }

  /**
   * 从偏好快照构建工具默认参数提示列表。
   */
  private buildToolDefaultHints(snapshot: PreferenceSnapshot): ToolDefaultHint[] {
    const hints: ToolDefaultHint[] = []

    for (const [key, value] of Object.entries(snapshot.toolDefaults)) {
      const colonIdx = key.indexOf(':')
      if (colonIdx <= 0 || colonIdx >= key.length - 1) continue

      const toolName = key.slice(0, colonIdx)
      const paramName = key.slice(colonIdx + 1)

      // 从纠正统计中查找对应的来源信息
      const correctionKey = `correction:${key}`
      const correctionCount = snapshot.correctionStats[correctionKey] || 0

      // 置信度由纠正次数和是否为纠正来源决定
      const source = correctionCount > 0 ? 'correction' : 'frequency'

      // 纠正 1 次 → 0.3, 2 次 → 0.5, 3+ 次 → 0.7
      const confidence = source === 'correction' ? Math.min(0.7, 0.2 + correctionCount * 0.15) : 0.4

      hints.push({
        toolName,
        paramName,
        value,
        confidence: Math.round(confidence * 100) / 100,
        source,
      })
    }

    return hints
  }

  /**
   * 构建工作流推荐列表。
   * 基于工具使用频率和偏好检测常见任务模式。
   */
  private buildWorkflowRecommendations(snapshot: PreferenceSnapshot): WorkflowRecommendation[] {
    const recommendations: WorkflowRecommendation[] = []
    // 初始实现：基于纠正统计推断
    // 当某个领域被频繁纠正时，可能意味着用户需要更好的工作流来减少纠正

    // 按工具名分组统计纠正次数
    const toolCorrectionCounts = new Map<string, number>()
    for (const [key, count] of Object.entries(snapshot.correctionStats)) {
      // key 格式: "correction:{toolName}:{paramName}"
      const match = key.match(/^correction:(.+?):/)
      if (match) {
        const toolName = match[1]
        toolCorrectionCounts.set(toolName, (toolCorrectionCounts.get(toolName) || 0) + count)
      }
    }

    // 如果某个工具被纠正次数 >= 3，推荐该工具的快捷工作流
    for (const [toolName, count] of toolCorrectionCounts) {
      if (count >= 3) {
        recommendations.push({
          name: `${toolName}_optimized`,
          reason: `${toolName} 工具曾被纠正 ${count} 次，建议优化其默认参数或提供快捷操作`,
          matchScore: Math.min(0.9, 0.3 + count * 0.1),
        })
      }
    }

    return recommendations
  }

  /**
   * 构建可注入 system prompt 的格式化片段。
   */
  private buildFormattedPrompt(hints: ToolDefaultHint[], workflows: WorkflowRecommendation[], snapshot: PreferenceSnapshot): string {
    const parts: string[] = []

    // 工具默认参数
    if (hints.length > 0) {
      const highConfidence = hints.filter((h) => h.confidence >= 0.5)
      if (highConfidence.length > 0) {
        parts.push('---')
        parts.push('【工具参数默认值】用户习惯使用的工具参数（基于历史交互学习）：')
        for (const hint of highConfidence.slice(0, 8)) {
          parts.push(`- ${hint.toolName}.${hint.paramName} = ${hint.value}`)
        }
      }
    }

    // 用户偏好语言对（特定场景）
    const langPair =
      snapshot.toolDefaults['translate_text:target_language'] ||
      snapshot.toolDefaults['translate:target_language'] ||
      snapshot.toolDefaults['style:language_pair']
    if (langPair) {
      if (parts.length === 0) parts.push('---')
      parts.push(`【语言偏好】用户倾向的语言: ${langPair}`)
    }

    // 工作流推荐（仅在置信度高时注入）
    const highConfidenceWorkflows = workflows.filter((w) => w.matchScore >= 0.6)
    if (highConfidenceWorkflows.length > 0) {
      if (parts.length > 0) {
        // 如果已有上面的标题，不需要额外标题
      }
      for (const wf of highConfidenceWorkflows.slice(0, 3)) {
        parts.push(`【提示】${wf.reason}`)
      }
    }

    if (parts.length === 0) return ''
    return parts.join('\n')
  }
}

// ══════════════════════════════════════════
// 全局单例
// ══════════════════════════════════════════

/** 全局 ToolDefaultAdjuster 单例 */
export const toolDefaultAdjuster = new ToolDefaultAdjuster()
