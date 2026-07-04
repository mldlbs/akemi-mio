import { buildTool, formatToolResult, formatToolError } from '../types'
import { getCognitiveService } from '../deps'

export const getIdentityTool = buildTool({
  name: 'get_identity',
  description: '查看核心身份声明、进化特质和成长指标',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const cs = getCognitiveService()
      if (!cs) return formatToolError('认知服务暂不可用')
      const snapshot = cs.identity.getSnapshot()
      const lines: string[] = []

      if (snapshot.core) {
        lines.push('【核心身份】')
        lines.push(snapshot.core.name ? `名称: ${snapshot.core.name}` : '')
        lines.push(snapshot.core.role ? `角色: ${snapshot.core.role}` : '')
        lines.push(snapshot.core.personality ? `性格: ${snapshot.core.personality}` : '')
        lines.push('')
      }

      if (snapshot.traits?.length) {
        lines.push('【进化特质】')
        for (const t of snapshot.traits) {
          lines.push(`  ${t.name}: ${t.value} (${t.trend || '无趋势'})`)
        }
        lines.push('')
      }

      if (snapshot.metrics) {
        lines.push('【成长指标】')
        lines.push(`  会话数: ${snapshot.metrics.sessionsCompleted ?? 0}`)
        lines.push(`  工具调用: ${snapshot.metrics.toolsUsed ?? 0}`)
        lines.push(`  目标偏移: ${snapshot.metrics.goalsDrifted ?? 0}`)
      }

      return formatToolResult(lines.join('\n') || '暂无身份信息')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
