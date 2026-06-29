import { buildTool, formatToolResult, formatToolError } from '../types'
import { getPersonaStateManager } from '../deps'

export const getPersonaStateTool = buildTool({
  name: 'get_persona_state',
  description: '查看当前人格层级（core:基础/hybrid:混合/writer:写作）、活动状态和附加模块',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const ps = getPersonaStateManager()
      if (!ps) return formatToolError('人格状态管理器暂不可用')
      const level = ps.getCurrentLevel()
      const active = ps.isActive()
      const modules = ps.getExtraModules()
      const labels: Record<string, string> = { core: '基础模式', hybrid: '混合模式', writer: '写作模式' }
      const lines = [`当前人格层级: ${level} (${labels[level] || level})`, `写作活跃状态: ${active ? '是' : '否'}`]
      if (modules.length) {
        lines.push(`附加模块: ${modules.join(', ')}`)
      }
      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
