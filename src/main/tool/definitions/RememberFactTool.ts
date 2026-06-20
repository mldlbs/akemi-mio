import { buildTool, formatToolResult, formatToolError } from '../types'
import { getMemoryService } from '../deps'

export const rememberFactTool = buildTool({
  name: 'remember_fact',
  description: '记住关于用户或项目的重要信息。当用户透露了个人偏好、重要决定、关键需求时应主动调用',
  inputJSONSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: '要记住的事实内容，如"用户偏好使用SQLite进行持久化"或"用户决定暂缓插件系统开发"',
      },
      confidence: { type: 'number', description: '确信度 0-1，默认 0.7' },
    },
    required: ['content'],
  },
  handler: async (args: { content: string; confidence?: number }) => {
    try {
      const ms = getMemoryService()
      if (!ms) return formatToolError('记忆服务暂不可用')
      const content = String(args.content)
      const confidence = typeof args.confidence === 'number' ? args.confidence : 0.7
      ms.addFact(content, confidence)
      return formatToolResult(`已记住: ${content.slice(0, 100)}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
