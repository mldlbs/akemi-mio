/**
 * AdaptiveOrchestrationTools — 记忆驱动自适应编排的 MCP 工具
 *
 * 提供三个工具供 Agent 使用：
 * 1. query_pattern_suggestions — 查询模式建议
 * 2. confirm_pattern_suggestion — 确认采纳一个模式建议
 * 3. dismiss_pattern_suggestion — 拒绝一个模式建议
 * 4. get_pattern_stats — 获取模式统计信息
 */

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { getAdaptiveOrchestrator } from '@akemi-mio/capabilities/tool/deps'

function getOrchestrator(): any {
  return getAdaptiveOrchestrator()
}

// ══════════════════════════════════════════════════════════════
//  query_pattern_suggestions
// ══════════════════════════════════════════════════════════════

export const queryPatternSuggestionsTool = buildTool({
  name: 'query_pattern_suggestions',
  description: '基于用户输入查询记忆中的历史操作模式，返回个性化任务步骤建议。在收到用户新指令后调用，可获取基于历史行为模式的最佳实践步骤',
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '用户指令或当前场景描述，用于语义匹配历史模式' },
      topK: { type: 'number', description: '返回建议数量（默认 3，最大 10）' },
    },
    required: ['query'],
  },
  handler: async (args: { query: string; topK?: number }) => {
    try {
      const orchestrator = getOrchestrator()
      if (!orchestrator) return formatToolError('自适应编排器暂不可用')

      const query = String(args.query)
      const topK = Math.min(Math.max(1, args.topK ?? 3), 10)

      const suggestions = orchestrator.getSuggestions(query, { topK })

      if (!suggestions || suggestions.length === 0) {
        return formatToolResult('当前没有匹配的历史操作模式。这可能是首次执行此类操作，建议在执行后使用 remember_procedure 保存流程。')
      }

      const lines: string[] = []
      lines.push(`基于历史行为模式，找到 ${suggestions.length} 条相关建议：`)
      lines.push('')

      for (const s of suggestions) {
        const p = s.match.pattern
        const confidenceLabel = p.confidence >= 0.7 ? '高' : p.confidence >= 0.4 ? '中' : '低'
        const sourceLabel =
          (
            {
              procedure: '显式保存',
              task_template: '自动挖掘',
              mined_topic_sequence: '话题模式',
            } as Record<string, string>
          )[p.source] || p.source

        lines.push(`【${p.name}】（${sourceLabel}，置信度:${(p.confidence * 100).toFixed(0)}% - ${confidenceLabel}）`)
        lines.push(`  描述：${p.description}`)
        if (p.steps.length > 0) {
          lines.push(`  建议步骤：`)
          p.steps.forEach((step: string, i: number) => lines.push(`    ${i + 1}. ${step}`))
        }
        if (p.triggerKeywords.length > 0) {
          lines.push(`  适用场景：${p.triggerKeywords.join('、')}`)
        }
        const total = p.successCount + p.failCount
        if (total > 0) {
          lines.push(`  历史：成功${p.successCount}次 / 失败${p.failCount}次 (成功率${((p.successCount / total) * 100).toFixed(0)}%)`)
        }
        lines.push(`  匹配度: ${(s.match.score * 100).toFixed(0)}%, 建议ID: ${p.id}`)
        lines.push('')
      }

      lines.push('提示：使用 confirm_pattern_suggestion <ID> 确认采纳某个建议，使用 dismiss_pattern_suggestion <ID> 拒绝。')
      lines.push('如果确认执行，后续可使用 record_execution_feedback 记录执行结果以优化未来建议。')

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// ══════════════════════════════════════════════════════════════
//  confirm_pattern_suggestion
// ══════════════════════════════════════════════════════════════

export const confirmPatternSuggestionTool = buildTool({
  name: 'confirm_pattern_suggestion',
  description: '确认采纳一个模式建议。调用后编排器会记录确认，并根据建议步骤指导后续执行',
  inputJSONSchema: {
    type: 'object',
    properties: {
      patternId: { type: 'string', description: '从 query_pattern_suggestions 返回的模式 ID' },
    },
    required: ['patternId'],
  },
  handler: async (args: { patternId: string }) => {
    try {
      const orchestrator = getOrchestrator()
      if (!orchestrator) return formatToolError('自适应编排器暂不可用')

      const patternId = String(args.patternId)
      const ok = orchestrator.confirmSuggestion(patternId)

      if (!ok) {
        return formatToolError(`未找到模式建议「${patternId}」，可能已过期或被其他请求处理`)
      }

      return formatToolResult(`已确认采纳模式建议「${patternId}」。将基于该模式指导后续执行步骤。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// ══════════════════════════════════════════════════════════════
//  dismiss_pattern_suggestion
// ══════════════════════════════════════════════════════════════

export const dismissPatternSuggestionTool = buildTool({
  name: 'dismiss_pattern_suggestion',
  description: '拒绝一个模式建议。如果当前建议不符合用户意图或场景不匹配，调用此工具拒绝建议',
  inputJSONSchema: {
    type: 'object',
    properties: {
      patternId: { type: 'string', description: '从 query_pattern_suggestions 返回的模式 ID' },
    },
    required: ['patternId'],
  },
  handler: async (args: { patternId: string }) => {
    try {
      const orchestrator = getOrchestrator()
      if (!orchestrator) return formatToolError('自适应编排器暂不可用')

      const patternId = String(args.patternId)
      orchestrator.dismissSuggestion(patternId)

      return formatToolResult(`已拒绝模式建议「${patternId}」。本次将不使用该模式。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// ══════════════════════════════════════════════════════════════
//  record_execution_feedback
// ══════════════════════════════════════════════════════════════

export const recordExecutionFeedbackTool = buildTool({
  name: 'record_execution_feedback',
  description: '记录模式执行的反馈结果（成功/失败），用于优化未来建议的置信度。在确认并执行完模式步骤后调用',
  inputJSONSchema: {
    type: 'object',
    properties: {
      patternId: { type: 'string', description: '已确认执行的模式 ID' },
      success: { type: 'boolean', description: '执行是否成功' },
    },
    required: ['patternId', 'success'],
  },
  handler: async (args: { patternId: string; success: boolean }) => {
    try {
      const orchestrator = getOrchestrator()
      if (!orchestrator) return formatToolError('自适应编排器暂不可用')

      const patternId = String(args.patternId)
      const success = Boolean(args.success)
      const ok = orchestrator.recordExecutionFeedback(patternId, success)

      if (!ok) {
        return formatToolError(`未找到模式「${patternId}」或该模式尚未被确认`)
      }

      const resultText = success ? '成功' : '失败'
      return formatToolResult(`已记录模式「${patternId}」的执行结果：${resultText}。这将用于优化未来的模式建议置信度。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// ══════════════════════════════════════════════════════════════
//  get_pattern_stats
// ══════════════════════════════════════════════════════════════

export const getPatternStatsTool = buildTool({
  name: 'get_pattern_stats',
  description: '获取记忆驱动自适应编排的统计信息，包括模式总数、待确认建议数、已确认执行次数等',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const orchestrator = getOrchestrator()
      if (!orchestrator) return formatToolError('自适应编排器暂不可用')

      const stats = orchestrator.getStats()
      const lines = [
        '【记忆驱动自适应编排 - 统计】',
        `- 已挖掘模式总数: ${stats.patternCount}`,
        `- 待确认建议数: ${stats.pendingCount}`,
        `- 已确认执行历史: ${stats.confirmedCount} 次`,
        `- 编排器状态: ${orchestrator.isEnabled() ? '已启用' : '已禁用'}`,
      ]
      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

/**
 * 所有自适应编排工具的列表。
 * 由 getAllTools.ts 导入并注册。
 */
export const adaptiveOrchestrationTools = [
  queryPatternSuggestionsTool,
  confirmPatternSuggestionTool,
  dismissPatternSuggestionTool,
  recordExecutionFeedbackTool,
  getPatternStatsTool,
]

