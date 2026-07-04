import { buildTool, formatToolResult, formatToolError } from '../types'
import { getHealthManager } from '../deps'
import { getHealthLevel } from '../../governance/SessionGovernorTypes'

export const getSystemHealthTool = buildTool({
  name: 'get_system_health',
  description: '查看各子系统健康状态概览',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const hm = getHealthManager()
      if (!hm) return formatToolError('健康管理器暂不可用')
      const snapshot = hm.getSnapshot()
      const lines = ['【系统健康状态】']
      lines.push(`综合评分: ${snapshot.composite.score} (${snapshot.composite.level}) 趋势: ${snapshot.composite.trend}`)
      lines.push(`  会话: ${snapshot.session.score} (${snapshot.session.level})`)
      lines.push(`  能力: ${snapshot.capability.score} (${snapshot.capability.level})`)
      lines.push(`  任务: ${snapshot.task.score} (${snapshot.task.level})`)
      lines.push(`  模型: ${snapshot.model.score} (${getHealthLevel(snapshot.model.score)}) | 失败: ${snapshot.model.failureCount}`)
      if (snapshot.recommendedActions?.length) {
        lines.push('')
        lines.push('建议操作:')
        for (const a of snapshot.recommendedActions) lines.push(`  - ${a}`)
      }
      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
