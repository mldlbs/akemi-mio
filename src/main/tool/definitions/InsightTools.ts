import { buildTool, formatToolResult, formatToolError } from '../types'
import { getInsightService } from '../deps'

export const triggerInsightAnalysisTool = buildTool({
  name: 'trigger_insight_analysis',
  description: '手动触发一次模式分析与洞察生成',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const is = getInsightService()
      if (!is) return formatToolError('洞察服务暂不可用')
      await is.forceAnalysis()
      return formatToolResult('洞察分析已完成')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const listInsightsTool = buildTool({
  name: 'list_insights',
  description: '查看已发现的洞察列表',
  inputJSONSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '返回条数，默认 20' },
    },
    required: [],
  },
  handler: async (args: { limit?: number }) => {
    try {
      const is = getInsightService()
      if (!is) return formatToolError('洞察服务暂不可用')
      const report = is.getReturnReport()
      const lines: string[] = ['【洞察列表】']
      if (report?.insights?.length) {
        for (const ins of report.insights.slice(0, args.limit ?? 20)) {
          lines.push(`  - ${ins.title}: ${ins.description?.slice(0, 100) || ''}`)
        }
      } else {
        lines.push('暂无洞察')
      }
      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
