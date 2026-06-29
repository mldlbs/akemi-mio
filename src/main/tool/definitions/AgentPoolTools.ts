import { buildTool, formatToolResult, formatToolError } from '../types'
import { getSubAgentPool } from '../deps'

export const spawnAgentTool = buildTool({
  name: 'spawn_agent',
  description: '派发一个后台子代理执行独立任务，立即返回 agent ID',
  inputJSONSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: '子代理的任务目标' },
      maxTurns: { type: 'number', description: '最大轮次，默认 15' },
      timeoutMs: { type: 'number', description: 'LLM 超时毫秒，默认 120000' },
    },
    required: ['goal'],
  },
  handler: async (args: { goal: string; maxTurns?: number; timeoutMs?: number }) => {
    try {
      const pool = getSubAgentPool()
      if (!pool) return formatToolError('子代理池暂不可用')
      const id = pool.spawn(args.goal, undefined, {
        maxTurns: args.maxTurns ?? 15,
        llmTimeoutMs: args.timeoutMs ?? 120000,
      })
      return formatToolResult(`子代理已派发\nID: ${id}\n目标: ${args.goal.slice(0, 100)}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const listAgentsTool = buildTool({
  name: 'list_agents',
  description: '列出所有已完成的子代理结果',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const pool = getSubAgentPool()
      if (!pool) return formatToolError('子代理池暂不可用')
      const results = pool.collectCompleted()
      if (!results.length) return formatToolResult('暂无已完成子代理')

      const lines = results.map(
        (r: any) =>
          `[${r.status}] ${r.id}: ${r.goal.slice(0, 60)} | 摘要: ${(r.summary || '').slice(0, 80)}${r.error ? ` | 错误: ${r.error.slice(0, 60)}` : ''}`,
      )
      return formatToolResult(`【子代理结果】\n${lines.join('\n')}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const interruptAgentTool = buildTool({
  name: 'interrupt_agent',
  description: '中断一个正在运行的子代理',
  inputJSONSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '要中断的子代理 ID' },
    },
    required: ['id'],
  },
  handler: async (args: { id: string }) => {
    try {
      const pool = getSubAgentPool()
      if (!pool) return formatToolError('子代理池暂不可用')
      pool.interrupt(args.id)
      return formatToolResult(`子代理 ${args.id} 已中断`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
