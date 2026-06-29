import { buildTool, formatToolResult, formatToolError } from '../types'
import { getLocalModelService } from '../deps'

export const runLocalModelTool = buildTool({
  name: 'run_local_model',
  description: '对本地小模型（Qwen2.5-0.5B）进行推理，适合简单文本生成任务',
  inputJSONSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '输入提示文本' },
      maxTokens: { type: 'number', description: '最大生成 token 数，默认 128' },
      temperature: { type: 'number', description: '采样温度 0-1，默认 0.7' },
    },
    required: ['prompt'],
  },
  handler: async (args: { prompt: string; maxTokens?: number; temperature?: number }) => {
    try {
      const lm = getLocalModelService()
      if (!lm) return formatToolError('本地模型服务暂不可用')
      const result = await lm.generate(args.prompt, {
        maxTokens: args.maxTokens ?? 128,
        temperature: args.temperature ?? 0.7,
      })
      return formatToolResult(result)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
