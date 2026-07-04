import { buildTool, formatToolResult, formatToolError } from '../types'
import { getEvolutionService } from '../deps'

export const getEvolutionStatusTool = buildTool({
  name: 'get_evolution_status',
  description: '查看进化调度器当前状态、安全模式、最后运行时间、失败计数和恢复冷却',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const es = getEvolutionService()
      if (!es) return formatToolError('进化服务暂不可用')
      const state = es.getSchedulerState()
      const safety = es.getSafetyMode()
      const lastRun = es.getLastRun()
      const consecutiveFails = es.getConsecutiveFailures()
      const execFails = es.getExecuteFailures()
      const cooldown = es.getRecoveryCooldown()

      const lines = [
        `调度器状态: ${state}`,
        `安全模式: ${safety}`,
        `最后运行: ${lastRun ? new Date(lastRun).toLocaleString('zh-CN') : '从未'}`,
        `连续失败: ${consecutiveFails}`,
        `执行失败: ${execFails}`,
        `恢复冷却: ${cooldown.active ? `剩余 ${Math.round(cooldown.remainingMs / 1000)}s` : '无'}`,
      ]
      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const triggerEvolutionTool = buildTool({
  name: 'trigger_evolution',
  description: '手动触发进化循环（分析→策略→执行→审查）',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const es = getEvolutionService()
      if (!es) return formatToolError('进化服务暂不可用')
      await es.triggerNow()
      return formatToolResult('进化循环已触发')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const setEvolutionSafetyModeTool = buildTool({
  name: 'set_evolution_safety_mode',
  description: '切换进化安全模式：review(审查模式，需人工确认) 或 auto(自动执行)',
  inputJSONSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['review', 'auto'],
        description: '安全模式',
      },
    },
    required: ['mode'],
  },
  handler: async (args: { mode: 'review' | 'auto' }) => {
    try {
      const es = getEvolutionService()
      if (!es) return formatToolError('进化服务暂不可用')
      es.setSafetyMode(args.mode)
      return formatToolResult(`进化安全模式已切换为: ${args.mode}`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
