import { buildTool, formatToolResult, formatToolError } from '../types'
import { getCognitiveService } from '../deps'

export const listStrategiesTool = buildTool({
  name: 'list_strategies',
  description: '查看活跃策略，可按上下文关键词匹配',
  inputJSONSchema: {
    type: 'object',
    properties: {
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '上下文关键词，用于匹配最相关的策略',
      },
    },
    required: [],
  },
  handler: async (args: { keywords?: string[] }) => {
    try {
      const cs = getCognitiveService()
      if (!cs) return formatToolError('认知服务暂不可用')
      const keywords = args.keywords || []
      const context = cs.strategies.getFormattedContext(keywords)
      return formatToolResult(context || '暂无活跃策略')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const createStrategyTool = buildTool({
  name: 'create_strategy',
  description: '创建一条新策略',
  inputJSONSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '策略标题' },
      description: { type: 'string', description: '策略描述' },
      context: { type: 'string', description: '适用场景/上下文描述' },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: '执行步骤列表',
      },
      priority: { type: 'number', description: '优先级，默认 5' },
    },
    required: ['title', 'description', 'steps'],
  },
  handler: async (args: { title: string; description: string; context?: string; steps: string[]; priority?: number }) => {
    try {
      const cs = getCognitiveService()
      if (!cs) return formatToolError('认知服务暂不可用')
      const strategy = cs.strategies.create({
        title: args.title,
        description: args.description,
        context: args.context || '',
        steps: args.steps,
        priority: args.priority ?? 5,
      })
      return formatToolResult(`策略已创建: ${strategy.title}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
