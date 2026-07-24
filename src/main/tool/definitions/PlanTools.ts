import { buildTool, formatToolResult, formatToolError } from '../types'
import { getPlanManager } from '../deps'
import { eventBus } from '../../core/EventBus'
import { log } from '../../logger/Logger'

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

      // 语音友好：空 plan_id 时使用当前活跃计划
      const targetId = args.plan_id || pm.getActivePlan()?.id
      if (!targetId) return formatToolError('没有活跃计划可完成')

      let ok = pm.completePlan(targetId, args.reflection)
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

      // 语音友好：空 plan_id 时使用当前活跃计划
      const targetId = args.plan_id || pm.getActivePlan()?.id
      if (!targetId) return formatToolError('没有活跃计划可放弃')

      let ok = pm.abandonPlan(targetId, args.reason)
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

/**
 * 语音命令友好版：更新计划步骤状态
 * 支持按步骤描述模糊匹配，无需知道步骤索引
 */
export const voiceUpdatePlanStepTool = buildTool({
  name: 'voice_update_plan_step',
  description: '[语音] 更新计划步骤状态 — 通过步骤描述或索引更新，适合语音操作',
  inputJSONSchema: {
    type: 'object',
    properties: {
      planTitle: { type: 'string', description: '计划标题（可选，默认使用当前活跃计划）' },
      stepDescription: { type: 'string', description: '步骤描述片段（用于模糊匹配）' },
      stepIndex: { type: 'number', description: '步骤序号（从 0 开始，与描述二选一）' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'done', 'failed'],
        description: '新状态（默认 done）',
      } as any,
      result: { type: 'string', description: '可选的执行结果备注' },
    },
    required: [],
  },
  handler: async (args: any) => {
    try {
      const pm = getPlanManager()
      if (!pm) return formatToolError('计划管理器尚未就绪')

      // 1. 确定目标计划
      let plan: any = null
      if (args.planTitle) {
        const allPlans = pm.listPlans()
        plan = allPlans.find((p: any) =>
          p.title.toLowerCase().includes(args.planTitle.toLowerCase()),
        )
        if (!plan) plan = allPlans.find((p: any) =>
          args.planTitle.toLowerCase().includes(p.title.toLowerCase()),
        )
      } else {
        plan = pm.getActivePlan()
      }
      if (!plan) return formatToolError('未找到匹配的计划')

      // 2. 确定目标步骤
      let stepIdx = -1
      if (args.stepIndex !== undefined && args.stepIndex !== '') {
        stepIdx = Number(args.stepIndex)
      } else if (args.stepDescription) {
        const desc = args.stepDescription.toLowerCase()
        // 精确匹配优先
        stepIdx = plan.steps.findIndex((s: any) =>
          s.description.toLowerCase().includes(desc),
        )
        // 二次模糊：每个词单独匹配
        if (stepIdx === -1) {
          const words = desc.split(/[\s,，、]+/).filter(Boolean)
          stepIdx = plan.steps.findIndex((s: any) =>
            words.every((w: string) => s.description.toLowerCase().includes(w)),
          )
        }
      } else {
        // 默认找第一个未完成的步骤
        stepIdx = plan.steps.findIndex((s: any) =>
          s.status !== 'done' && s.status !== 'failed',
        )
      }

      if (stepIdx < 0 || stepIdx >= plan.steps.length) {
        return formatToolError(`未找到匹配的步骤（步骤数: ${plan.steps.length}）`)
      }

      const newStatus = args.status || 'done'
      const ok = pm.updateStep(plan.id, stepIdx, newStatus, args.result)
      if (!ok) return formatToolError('更新失败')

      const stepLabel = plan.steps[stepIdx].description
      log('INFO', 'voice_plan_step_updated', {
        plan_id: plan.id,
        step_index: stepIdx,
        status: newStatus,
      })

      return formatToolResult(
        `✅ 已标记计划「${plan.title}」步骤「${stepLabel}」为 ${statusLabel(newStatus)}`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

function statusLabel(s: string): string {
  const map: Record<string, string> = {
    pending: '待办',
    in_progress: '进行中',
    done: '已完成',
    failed: '失败',
  }
  return map[s] || s
}

/**
 * 语音命令友好版：切换工作焦点到指定计划
 * 返回计划详情，并通过事件总线通知渲染器切换焦点
 */
export const voiceSwitchPlanFocusTool = buildTool({
  name: 'voice_switch_plan_focus',
  description: '[语音] 切换工作焦点到指定计划 — 通过计划名称切换工作区上下文',
  inputJSONSchema: {
    type: 'object',
    properties: {
      planTitle: { type: 'string', description: '计划标题（模糊匹配）' },
    },
    required: ['planTitle'],
  },
  handler: async (args: any) => {
    try {
      const pm = getPlanManager()
      if (!pm) return formatToolError('计划管理器尚未就绪')

      const allPlans = pm.listPlans()
      // 模糊匹配：输入是计划标题的子串或反
      const plan = allPlans.find((p: any) =>
        p.title.toLowerCase().includes(args.planTitle.toLowerCase()),
      ) || allPlans.find((p: any) =>
        args.planTitle.toLowerCase().includes(p.title.toLowerCase()),
      )

      if (!plan) {
        return formatToolError(
          `未找到匹配的计划「${args.planTitle}」。当前计划:\n` +
          allPlans.map((p: any) => `  [${p.status}] ${p.title}`).join('\n'),
        )
      }

      const doneSteps = plan.steps.filter((s: any) => s.status === 'done').length
      const totalSteps = plan.steps.length

      // 通过事件总线通知焦点切换
      eventBus.emit('agent.plan.focus_switched', {
        planId: plan.id,
        planTitle: plan.title,
        status: plan.status,
        stepCount: totalSteps,
        doneCount: doneSteps,
      })

      // 构建返回信息
      let result = `🔍 计划「${plan.title}」\n`
      result += `状态: ${plan.status === 'active' ? '进行中' : plan.status === 'completed' ? '已完成' : plan.status === 'frozen' ? '已冻结' : '已放弃'}\n`
      result += `进度: ${doneSteps}/${totalSteps}\n\n`
      for (let i = 0; i < plan.steps.length; i++) {
        const s = plan.steps[i]
        const mark = s.status === 'done' ? '✅' : s.status === 'in_progress' ? '🔄' : s.status === 'failed' ? '❌' : '⬜'
        result += `${mark} ${i}. ${s.description}\n`
      }

      log('INFO', 'voice_plan_focus_switched', {
        plan_id: plan.id,
        plan_title: plan.title,
        status: plan.status,
      })

      return formatToolResult(result)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
