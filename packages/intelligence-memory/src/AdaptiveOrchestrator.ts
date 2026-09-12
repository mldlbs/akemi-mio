/**
 * AdaptiveOrchestrator — 记忆驱动的自适应编排器
 *
 * ## 职责
 * Agent 在任务规划时查询 Memory 中的用户长期行为模式，
 * 自动生成个性化任务步骤和工具选择。
 *
 * ## 流程
 * 1. Agent 收到指令 → 查询 AdaptiveOrchestrator.getSuggestions()
 * 2. SequencePatternMiner 语义匹配检索历史模式 → 按置信度排序
 * 3. 生成建议步骤返回给 Agent
 * 4. 用户确认 → Orchestrator 记录确认
 * 5. 执行 → Orchestrator 更新模式（成功/失败）
 *
 * ## 集成点
 * - MemoryService 构造时创建
 * - 通过 getFormattedContext() 注入 system prompt
 * - 通过 MCP 工具暴露给 Agent
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { SequencePatternMiner, type SequencePattern, type PatternMatch, type MiningOptions } from './SequencePatternMiner'
import type { InteractionRecord } from './types'
import type { Procedure } from '@akemi-mio/intelligence-shared/types'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 编排建议 */
export interface OrchestrationSuggestion {
  /** 模式匹配结果 */
  match: PatternMatch
  /** 建议生成时间 */
  generatedAt: number
  /** 是否已被用户确认 */
  confirmed: boolean
  /** 确认时间 */
  confirmedAt?: number
  /** 是否已执行 */
  executed: boolean
  /** 执行时间 */
  executedAt?: number
  /** 执行结果（成功/失败） */
  executionSuccess?: boolean
}

/** 编排器选项 */
export interface OrchestratorOptions {
  /** 注入上下文的最大建议数 */
  maxContextSuggestions?: number
  /** 是否启用自动建议 */
  enabled?: boolean
  /** 最小置信度才注入上下文 */
  minContextConfidence?: number
}

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

const DEFAULT_MAX_CONTEXT = 3
const DEFAULT_MIN_CONFIDENCE = 0.2
const SUGGESTION_TTL_MS = 30 * 60 * 1000 // 30 分钟过期

// ══════════════════════════════════════════
//  AdaptiveOrchestrator
// ══════════════════════════════════════════

export class AdaptiveOrchestrator {
  readonly miner: SequencePatternMiner
  private options: Required<OrchestratorOptions>
  /** 活跃建议列表（待确认的） */
  private pendingSuggestions: Map<string, OrchestrationSuggestion> = new Map()
  /** 最近确认的模式 ID 列表（用于历史追踪） */
  private confirmedHistory: Array<{ patternId: string; timestamp: number; success: boolean }> = []

  constructor(
    deps: {
      getInteractions: () => InteractionRecord[]
      getProcedures: () => Procedure[]
      matchTemplates?: (query: string, topK: number) => Array<{ name: string; description: string; steps: string[]; score: number }>
    },
    options?: OrchestratorOptions,
  ) {
    this.miner = new SequencePatternMiner(deps)
    this.options = {
      maxContextSuggestions: options?.maxContextSuggestions ?? DEFAULT_MAX_CONTEXT,
      enabled: options?.enabled ?? true,
      minContextConfidence: options?.minContextConfidence ?? DEFAULT_MIN_CONFIDENCE,
    }
  }

  // ══════════════════════════════════════════
  //  核心 API
  // ══════════════════════════════════════════

  /**
   * 获取对用户输入的模式建议。
   * Agent 收到指令后调用此方法，获取基于历史行为模式的个性化步骤建议。
   *
   * @param userInput 用户指令文本
   * @param options 可选的匹配选项
   * @returns 按置信度排序的建议列表
   */
  getSuggestions(userInput: string, options?: MiningOptions): OrchestrationSuggestion[] {
    if (!this.options.enabled || !userInput) return []

    const matches = this.miner.matchPatterns(userInput, options)
    if (matches.length === 0) return []

    const suggestions: OrchestrationSuggestion[] = matches.map((match) => ({
      match,
      generatedAt: Date.now(),
      confirmed: false,
      executed: false,
    }))

    // 缓存为待确认建议
    for (const s of suggestions) {
      this.pendingSuggestions.set(s.match.pattern.id, s)
    }

    log('INFO', 'adaptive_orchestrator.suggestions', {
      inputLength: userInput.length,
      suggestionsCount: suggestions.length,
      topMatch: suggestions[0]?.match.pattern.name,
    })

    return suggestions
  }

  /**
   * 用户确认一个模式建议。
   * 确认后编排器会生成具体的执行步骤。
   */
  confirmSuggestion(patternId: string): boolean {
    const suggestion = this.pendingSuggestions.get(patternId)
    if (!suggestion) return false

    suggestion.confirmed = true
    suggestion.confirmedAt = Date.now()

    log('INFO', 'adaptive_orchestrator.confirmed', {
      pattern: suggestion.match.pattern.name,
      score: suggestion.match.score,
    })

    return true
  }

  /**
   * 记录模式执行后的反馈。
   * 更新模式的成功/失败计数，用于后续的置信度调整。
   */
  recordExecutionFeedback(patternId: string, success: boolean): boolean {
    const suggestion = this.pendingSuggestions.get(patternId)
    if (!suggestion) return false

    suggestion.executed = true
    suggestion.executedAt = Date.now()
    suggestion.executionSuccess = success

    // 更新模式数据
    this.miner.recordFeedback(patternId, success)

    // 记录到历史
    this.confirmedHistory.push({
      patternId,
      timestamp: Date.now(),
      success,
    })
    // 限制历史大小
    if (this.confirmedHistory.length > 100) {
      this.confirmedHistory = this.confirmedHistory.slice(-100)
    }

    // 清理已使用建议
    this.pendingSuggestions.delete(patternId)

    log('INFO', 'adaptive_orchestrator.execution_feedback', {
      pattern: suggestion.match.pattern.name,
      success,
    })

    return true
  }

  /**
   * 拒绝一个建议（不执行）。
   */
  dismissSuggestion(patternId: string): boolean {
    const existed = this.pendingSuggestions.has(patternId)
    this.pendingSuggestions.delete(patternId)
    if (existed) {
      log('INFO', 'adaptive_orchestrator.dismissed', { patternId })
    }
    return existed
  }

  // ══════════════════════════════════════════
  //  上下文注入
  // ══════════════════════════════════════════

  /**
   * 获取格式化的模式建议上下文，用于注入 system prompt。
   * 返回最近匹配的、高置信度模式，供 Agent 在规划时参考。
   *
   * Agent 可以根据这些建议自动调整任务步骤，
   * 无需每次都需要用户显式确认。
   */
  getFormattedContext(): string {
    if (!this.options.enabled) return ''
    if (this.miner.getPatternCount() === 0) return ''

    // 取高置信度的通用模式（不依赖特定用户输入）
    const topPatterns = this.miner
      .getAllPatterns()
      .filter((p) => p.confidence >= (this.options.minContextConfidence ?? 0.2))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.options.maxContextSuggestions)

    if (topPatterns.length === 0) return ''

    const parts: string[] = ['---', '【记忆驱动的自适应编排】基于用户历史行为模式，以下为可参考的操作流程：']

    for (const p of topPatterns) {
      const sourceLabel = this.getSourceLabel(p.source)
      parts.push(`- ${p.name} (${sourceLabel}, 置信度:${(p.confidence * 100).toFixed(0)}%)`)
      if (p.steps.length > 0) {
        parts.push(`  建议步骤: ${p.steps.map((s, i) => `${i + 1}.${s}`).join(' → ')}`)
      }
      if (p.triggerKeywords.length > 0) {
        parts.push(`  适用场景: ${p.triggerKeywords.slice(0, 3).join('、')}`)
      }
      // 显示成功率
      const total = p.successCount + p.failCount
      if (total > 0) {
        const rate = ((p.successCount / total) * 100).toFixed(0)
        parts.push(`  历史表现: 成功${p.successCount}次/失败${p.failCount}次 (${rate}%)`)
      }
    }

    parts.push('在规划任务步骤时，可参考以上模式。如果用户指令匹配上述场景，优先采用已验证的步骤。')
    parts.push('---')

    return parts.join('\n')
  }

  /**
   * 获取等待用户确认的建议列表（用于 UI 展示或工具调用返回）。
   */
  getPendingSuggestions(): OrchestrationSuggestion[] {
    // 清理过期的建议
    const now = Date.now()
    for (const [id, s] of this.pendingSuggestions) {
      if (now - s.generatedAt > SUGGESTION_TTL_MS) {
        this.pendingSuggestions.delete(id)
      }
    }
    return Array.from(this.pendingSuggestions.values())
  }

  /**
   * 触发一次模式挖掘（重新分析所有数据源）。
   */
  triggerMining(): void {
    this.miner.mine()
    log('INFO', 'adaptive_orchestrator.mining_triggered', {
      patternCount: this.miner.getPatternCount(),
    })
  }

  // ══════════════════════════════════════════
  //  配置
  // ══════════════════════════════════════════

  setEnabled(enabled: boolean): void {
    this.options.enabled = enabled
  }

  isEnabled(): boolean {
    return this.options.enabled
  }

  getStats(): { patternCount: number; pendingCount: number; confirmedCount: number } {
    return {
      patternCount: this.miner.getPatternCount(),
      pendingCount: this.pendingSuggestions.size,
      confirmedCount: this.confirmedHistory.length,
    }
  }

  // ══════════════════════════════════════════
  //  私有方法
  // ══════════════════════════════════════════

  private getSourceLabel(source: string): string {
    switch (source) {
      case 'procedure':
        return '显式保存的流程'
      case 'task_template':
        return '自动挖掘的模板'
      case 'mined_topic_sequence':
        return '话题转移模式'
      default:
        return source
    }
  }
}
