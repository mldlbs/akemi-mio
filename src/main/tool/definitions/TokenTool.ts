import { buildTool, formatToolResult, formatToolError } from '../types'
import { getCognitiveService } from '../deps'

export const getTokenStatusTool = buildTool({
  name: 'get_token_status',
  description: '查看代币经济状态：余额、财富等级、收支统计、近期交易',
  inputJSONSchema: {
    type: 'object',
    properties: {
      recentCount: { type: 'number', description: '近期交易条数，默认 5' },
    },
    required: [],
  },
  handler: async (args: { recentCount?: number }) => {
    try {
      const cs = getCognitiveService()
      if (!cs) return formatToolError('认知服务暂不可用')
      const { tokenAccount } = cs
      const balance = tokenAccount.getBalance()
      const wealth = tokenAccount.getWealthLevel()
      const stats = tokenAccount.getLifetimeStats()
      const summary = tokenAccount.getRecentSummary(args.recentCount ?? 5)
      const lines = [
        `余额: ${balance}`,
        `财富等级: ${wealth}`,
        `生平收入: ${stats.earned}`,
        `生平支出: ${stats.spent}`,
        '',
        '近期交易:',
        summary,
      ]
      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
