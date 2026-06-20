import { buildTool, formatToolResult, formatToolError } from '../types'
import { getPlanManager } from '../deps'

export const createDevPlanTool = buildTool({
  name: 'create_dev_plan',
  description: '创建开发计划，记录要实现的步骤',
  inputJSONSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '计划标题' },
      description: { type: 'string', description: '计划描述' },
      steps: { type: 'array', items: { type: 'string' }, description: '步骤列表' } as any,
    },
    required: ['title', 'description', 'steps'],
  },
  handler: async (args: any) => {
    try {
      const pm = getPlanManager()
      if (!pm) return formatToolError('计划管理器尚未就绪')
      const plan = pm.createPlan(args.title, args.description, args.steps)
      const result = JSON.stringify(
        {
          id: plan.id,
          title: plan.title,
          steps: plan.steps.map((s: any, i: number) => `${i}: ${s.description}`),
        },
        null,
        2,
      )
      return formatToolResult(result)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const updatePlanProgressTool = buildTool({
  name: 'update_plan_progress',
  description: '更新开发计划中某一步的状态',
  inputJSONSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: '计划 ID' },
      step_index: { type: 'number', description: '步骤序号（从 0 开始）' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'done', 'failed'],
        description: '新状态',
      } as any,
      result: { type: 'string', description: '可选的执行结果备注' },
    },
    required: ['plan_id', 'step_index', 'status'],
  },
  handler: async (args: any) => {
    try {
      const pm = getPlanManager()
      if (!pm) return formatToolError('计划管理器尚未就绪')
      let ok = pm.updateStep(args.plan_id, args.step_index, args.status, args.result)
      if (!ok && args.plan_id) {
        const allPlans = pm.listPlans()
        const match = allPlans.find((p: any) => p.title === args.plan_id)
        if (match) {
          ok = pm.updateStep(match.id, args.step_index, args.status, args.result)
        }
      }
      if (!ok) return formatToolError('更新失败：计划或步骤不存在')
      return formatToolResult('已更新')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const listPlansTool = buildTool({
  name: 'list_plans',
  description: '列出所有开发计划',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const pm = getPlanManager()
      if (!pm) return formatToolError('计划管理器尚未就绪')
      const plans = pm.listPlans()
      if (plans.length === 0) return formatToolResult('暂无开发计划')

      const activePlan = plans.find((p: any) => p.status === 'active')
      let text = activePlan ? '' : '【当前没有活跃计划】\n\n'

      for (const p of plans) {
        const done = p.steps.filter((s: any) => s.status === 'done').length
        const total = p.steps.length
        const isActive = p.status === 'active'
        const isCompleted = p.status === 'completed'
        const statusLabel = isActive ? '进行中' : isCompleted ? '已完成' : '已放弃'
        text += `[${statusLabel}] ${p.title} (${done}/${total})\n`
        text += `  ID: ${p.id}\n`
        if (isActive) {
          for (let i = 0; i < p.steps.length; i++) {
            const s = p.steps[i]
            if (s.status !== 'done') text += `  ${i}: [${s.status === 'in_progress' ? '→' : ' '}] ${s.description}\n`
          }
          text += '\n⚠️ 请按照上述活跃计划的待办步骤执行，不要去管已完成的计划\n'
        }
      }
      return formatToolResult(text.trim())
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const completePlanTool = buildTool({
  name: 'complete_plan',
  description: '标记开发计划为已完成',
  inputJSONSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: '计划 ID' },
      reflection: { type: 'string', description: '完成反思/总结' },
    },
    required: ['plan_id'],
  },
  handler: async (args: any) => {
    try {
      const pm = getPlanManager()
      if (!pm) return formatToolError('计划管理器尚未就绪')
      let ok = pm.completePlan(args.plan_id, args.reflection)
      if (!ok && args.plan_id) {
        const allPlans = pm.listPlans()
        const match = allPlans.find((p: any) => p.title === args.plan_id)
        if (match) ok = pm.completePlan(match.id, args.reflection)
      }
      if (!ok) return formatToolError('计划不存在')
      return formatToolResult('计划已标记为完成')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

export const abandonPlanTool = buildTool({
  name: 'abandon_plan',
  description: '放弃当前开发计划。当用户需求变更、不再需要当前计划时调用',
  inputJSONSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: '要放弃的计划 ID' },
      reason: { type: 'string', description: '放弃原因' },
    },
    required: ['plan_id'],
  },
  handler: async (args: any) => {
    try {
      const pm = getPlanManager()
      if (!pm) return formatToolError('计划管理器尚未就绪')
      let ok = pm.abandonPlan(args.plan_id, args.reason)
      if (!ok && args.plan_id) {
        const allPlans = pm.listPlans()
        const match = allPlans.find((p: any) => p.title === args.plan_id)
        if (match) ok = pm.abandonPlan(match.id, args.reason)
      }
      if (!ok) return formatToolError('计划不存在')
      return formatToolResult('计划已放弃')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})
