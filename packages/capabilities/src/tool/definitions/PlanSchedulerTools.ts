/**
 * PlanSchedulerTools — 智能并行任务协调器的对话干预工具
 *
 * 提供 Agent/LLM 可直接调用的工具，用于：
 * - 查看所有活跃调度的状态
 * - 暂停/恢复计划执行
 * - 跳过/重试指定任务
 * - 确认待确认任务
 * - 清除已完成的调度记录
 *
 * 对话示例：
 * - "查看进度" → plan_scheduler_status
 * - "暂停计划" → plan_scheduler_pause planId="xxx"
 * - "跳过这个任务" → plan_scheduler_skip_task planId="xxx" taskId="xxx"
 * - "重试" → plan_scheduler_retry_task planId="xxx" taskId="xxx"
 *
 * 内部通过 PlanSchedulerCoordinator 操作 PlanTaskEngine 的状态机。
 * 对外暴露的操作都经过 PlanTaskEngine 的 VALID_STATE_TRANSITIONS 校验。
 */

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { getPlanSchedulerCoordinator } from '@akemi-mio/capabilities/tool/deps'

// ════════════════════════════════════════════════════════════════
//  查看调度状态
// ════════════════════════════════════════════════════════════════

export const planSchedulerStatusTool = buildTool({
  name: 'plan_scheduler_status',
  description: '查看所有活跃调度的执行状态、进度百分比、任务统计。无参数时返回所有计划的概览。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        description: '可选：指定计划 ID，返回该计划的详细任务列表',
      },
    },
    required: [],
  },
  handler: async (args: { planId?: string }) => {
    try {
      const coordinator = getPlanSchedulerCoordinator()
      if (!coordinator) {
        return formatToolError('计划调度协调器暂不可用（未初始化）')
      }

      if (args.planId) {
        // 详细模式：返回单个计划的任务列表
        const detail = coordinator.getPlanDetail(args.planId)
        if (detail.error) {
          return formatToolError(detail.error)
        }

        const status = detail.status
        const lines: string[] = []

        if (status) {
          lines.push(`📋 ${status.planTitle}`)
          lines.push(`状态: ${statusLabel(status.status)}`)
          lines.push(`进度: ${status.completed}/${status.total} (${status.progressPct}%)`)
          lines.push(`失败: ${status.failed}, 跳过: ${status.skipped}, 取消: ${status.cancelled}, 剩余: ${status.remaining}`)

          if (detail.tasks.length > 0) {
            lines.push('')
            lines.push('任务列表:')
            for (const task of detail.tasks) {
              const stateIcon = taskStateIcon(task.state)
              lines.push(`  ${stateIcon} [${task.stepIndex}] ${task.description}`)
              lines.push(`     ID: ${task.id} | 状态: ${task.state}${task.lastError ? ` | 错误: ${task.lastError}` : ''}`)
            }
          }
        } else {
          lines.push('计划状态信息不可用')
        }

        return formatToolResult(lines.join('\n'))
      }

      // 概览模式：返回所有计划的状态
      const statuses = coordinator.getAllStatuses()

      if (statuses.length === 0) {
        return formatToolResult('当前没有活跃的调度计划')
      }

      const lines: string[] = ['📊 智能调度状态概览', '━━━━━━━━━━━━━━━━━']

      for (const s of statuses) {
        lines.push(
          `[${statusLabel(s.status)}] ${s.planTitle}` +
            `  ${s.completed}/${s.total} (${s.progressPct}%)` +
            `  ✗${s.failed}  ⊘${s.skipped}  ●${s.remaining}`,
        )
      }

      lines.push('')
      lines.push(`共 ${statuses.length} 个活跃计划`)
      lines.push('使用 planId 参数查看详细任务列表')

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`查询调度状态失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// ════════════════════════════════════════════════════════════════
//  暂停计划
// ════════════════════════════════════════════════════════════════

export const planSchedulerPauseTool = buildTool({
  name: 'plan_scheduler_pause',
  description: '暂停指定计划的执行。暂停前会自动创建快照，后续可通过 plan_scheduler_resume 恢复。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        description: '要暂停的计划 ID',
      },
    },
    required: ['planId'],
  },
  handler: async (args: { planId: string }) => {
    try {
      const coordinator = getPlanSchedulerCoordinator()
      if (!coordinator) {
        return formatToolError('计划调度协调器暂不可用')
      }

      const result = coordinator.pausePlan(args.planId)
      if (!result.success) {
        return formatToolError(result.error ?? '暂停失败')
      }

      return formatToolResult(`✅ 计划 ${args.planId} 已暂停，已创建恢复快照`)
    } catch (err: any) {
      return formatToolError(`暂停计划失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// ════════════════════════════════════════════════════════════════
//  恢复计划
// ════════════════════════════════════════════════════════════════

export const planSchedulerResumeTool = buildTool({
  name: 'plan_scheduler_resume',
  description: '恢复之前暂停的计划执行。会从最近的快照重建任务状态并继续执行。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        description: '要恢复的计划 ID',
      },
    },
    required: ['planId'],
  },
  handler: async (args: { planId: string }) => {
    try {
      const coordinator = getPlanSchedulerCoordinator()
      if (!coordinator) {
        return formatToolError('计划调度协调器暂不可用')
      }

      const result = await coordinator.resumePlan(args.planId)
      if (!result.success) {
        return formatToolError(result.error ?? '恢复失败')
      }

      return formatToolResult(`✅ 计划 ${args.planId} 已恢复执行`)
    } catch (err: any) {
      return formatToolError(`恢复计划失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// ════════════════════════════════════════════════════════════════
//  跳过任务
// ════════════════════════════════════════════════════════════════

export const planSchedulerSkipTaskTool = buildTool({
  name: 'plan_scheduler_skip_task',
  description: '跳过指定计划中的某个任务。任务将被标记为跳过，引擎自动推进到下一个就绪任务。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        description: '计划 ID',
      },
      taskId: {
        type: 'string',
        description: '要跳过的任务 ID（可从 plan_scheduler_status 获取）',
      },
    },
    required: ['planId', 'taskId'],
  },
  handler: async (args: { planId: string; taskId: string }) => {
    try {
      const coordinator = getPlanSchedulerCoordinator()
      if (!coordinator) {
        return formatToolError('计划调度协调器暂不可用')
      }

      const result = coordinator.skipTask(args.planId, args.taskId)
      if (!result.success) {
        return formatToolError(result.error ?? '跳过任务失败')
      }

      return formatToolResult(`✅ 任务 ${args.taskId} 已跳过`)
    } catch (err: any) {
      return formatToolError(`跳过任务失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// ════════════════════════════════════════════════════════════════
//  重试任务
// ════════════════════════════════════════════════════════════════

export const planSchedulerRetryTaskTool = buildTool({
  name: 'plan_scheduler_retry_task',
  description: '重试指定计划中已失败的任务。将任务从 failed 状态重置，引擎会重新尝试执行。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        description: '计划 ID',
      },
      taskId: {
        type: 'string',
        description: '要重试的任务 ID（必须处于 failed 状态）',
      },
    },
    required: ['planId', 'taskId'],
  },
  handler: async (args: { planId: string; taskId: string }) => {
    try {
      const coordinator = getPlanSchedulerCoordinator()
      if (!coordinator) {
        return formatToolError('计划调度协调器暂不可用')
      }

      const result = coordinator.retryTask(args.planId, args.taskId)
      if (!result.success) {
        return formatToolError(result.error ?? '重试任务失败')
      }

      return formatToolResult(`✅ 任务 ${args.taskId} 已重置，准备重新执行`)
    } catch (err: any) {
      return formatToolError(`重试任务失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// ════════════════════════════════════════════════════════════════
//  确认任务
// ════════════════════════════════════════════════════════════════

export const planSchedulerConfirmTaskTool = buildTool({
  name: 'plan_scheduler_confirm_task',
  description: '确认指定计划中等待确认的任务。将 needs_confirm 状态的任务转为执行状态。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        description: '计划 ID',
      },
      taskId: {
        type: 'string',
        description: '要确认的任务 ID（必须处于 needs_confirm 状态）',
      },
    },
    required: ['planId', 'taskId'],
  },
  handler: async (args: { planId: string; taskId: string }) => {
    try {
      const coordinator = getPlanSchedulerCoordinator()
      if (!coordinator) {
        return formatToolError('计划调度协调器暂不可用')
      }

      const result = coordinator.confirmTask(args.planId, args.taskId)
      if (!result.success) {
        return formatToolError(result.error ?? '确认任务失败')
      }

      return formatToolResult(`✅ 任务 ${args.taskId} 已确认，继续执行`)
    } catch (err: any) {
      return formatToolError(`确认任务失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// ════════════════════════════════════════════════════════════════
//  辅助：状态标签映射
// ════════════════════════════════════════════════════════════════

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    running: '▶ 运行中',
    paused: '⏸ 已暂停',
    completed: '✅ 已完成',
    failed: '❌ 失败',
    idle: '⏹ 空闲',
  }
  return labels[status] ?? status
}

function taskStateIcon(state: string): string {
  const icons: Record<string, string> = {
    pending: '⏳',
    analyzing: '🔍',
    tool_selected: '🔧',
    executing: '⚡',
    completed: '✅',
    failed: '❌',
    degraded: '⚠️',
    needs_confirm: '❓',
    skipped: '⊘',
    cancelled: '🚫',
  }
  return icons[state] ?? '•'
}

