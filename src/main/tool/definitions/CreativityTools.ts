import { buildTool, formatToolResult, formatToolError } from '../types'
import { getCreativityService } from '../deps'

export const triggerCreativityTool = buildTool({
  name: 'trigger_creativity',
  description: '手动触发创意生成循环，产生新的创意假设',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const cs = getCreativityService()
      if (!cs) return formatToolError('创意服务暂不可用')
      const ideas = await cs.forceCycle()
      return formatToolResult(`创意循环完成，产生了 ${ideas.length} 个新创意`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const triggerDreamCycleTool = buildTool({
  name: 'trigger_dream_cycle',
  description: '触发梦境模式创意循环（低负载概念重组），产生更多发散性创意',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const cs = getCreativityService()
      if (!cs) return formatToolError('创意服务暂不可用')
      const ideas = await cs.forceDreamCycle()
      return formatToolResult(`梦境循环完成，产生了 ${ideas.length} 个新创意`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const listIdeasTool = buildTool({
  name: 'list_ideas',
  description: '查看创意存储库中的假设和实验列表',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const cs = getCreativityService()
      if (!cs) return formatToolError('创意服务暂不可用')
      const store = cs.getStore()
      const lines: string[] = ['【创意存储】']

      const hypotheses = store.getHypotheses?.() ?? []
      if (hypotheses.length) {
        lines.push(`\n假设 (${hypotheses.length}):`)
        for (const h of hypotheses.slice(0, 20)) {
          lines.push(`  - ${h.title}: ${h.idea?.slice(0, 80) || ''}`)
        }
      } else {
        lines.push('\n暂无假设')
      }

      const experiments = store.getActiveExperiments?.() ?? []
      if (experiments.length) {
        lines.push(`\n实验 (${experiments.length}):`)
        for (const e of experiments.slice(0, 20)) {
          const hypStatus = hypotheses.find((h) => h.id === e.hypothesisId)?.status
          lines.push(`  - ${e.title}: ${hypStatus || '未知'}`)
        }
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
