import { buildTool, formatToolResult, formatToolError } from '../types'
import { getProceduralMemory } from '../deps'

export const rememberProcedureTool = buildTool({
  name: 'remember_procedure',
  description: '保存一个可复用的操作流程，包含触发词和步骤列表。在完成一个多步操作后调用，方便未来复用',
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '流程名称，如"修复TypeScript编译错误"或"创建新MCP服务器"' },
      description: { type: 'string', description: '流程的简要描述，说明何时使用此流程' },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: '步骤列表，每步一个字符串，如["grep错误信息","read_file定位问题文件","edit_file修复"]',
      },
      triggerKeywords: {
        type: 'array',
        items: { type: 'string' },
        description: '触发词列表，当用户输入或场景包含这些词时自动提示此流程',
      },
    },
    required: ['name', 'description', 'steps', 'triggerKeywords'],
  },
  handler: async (args: { name: string; description: string; steps: string[]; triggerKeywords: string[] }) => {
    try {
      const pm = getProceduralMemory()
      if (!pm) return formatToolError('流程记忆服务暂不可用')
      const name = String(args.name)
      const description = String(args.description)
      const steps = Array.isArray(args.steps) ? args.steps.map(String) : []
      const triggerKeywords = Array.isArray(args.triggerKeywords) ? args.triggerKeywords.map(String) : []
      pm.save({ name, description, steps, triggerKeywords })
      return formatToolResult(`已保存流程「${name}」（${steps.length} 步，${triggerKeywords.length} 个触发词）`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const listProceduresTool = buildTool({
  name: 'list_procedures',
  description: '列出所有已保存的可复用操作流程及其调用统计',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const pm = getProceduralMemory()
      if (!pm) return formatToolError('流程记忆服务暂不可用')
      const all = pm.listAll()
      if (all.length === 0) return formatToolResult('当前没有保存的流程')
      const lines = all.map(
        (p) => `- ${p.name}: ${p.description.slice(0, 60)} (成功${p.successCount}/失败${p.failCount}, ${p.steps.length}步)`,
      )
      return formatToolResult(`已保存的流程（共 ${all.length} 个）：\n${lines.join('\n')}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
