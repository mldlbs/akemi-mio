import { buildTool, formatToolResult, formatToolError } from '../types'
import { workflowStore } from '../../workflow/WorkflowStoreV2'
import { getWorkflowScheduler } from '../../workflow/WorkflowScheduler'
import { validateWorkflow } from '../../workflow/WorkflowValidator'
import type { WorkflowDef, WorkflowStepDef } from '../../workflow/types'

export const analyzeTaskTool = buildTool({
  name: 'analyze_task',
  description:
    '【推荐入口】分析一个开发任务的复杂度，自动匹配合适的开发 pipeline。每次接到新任务时先用这个工具。系统会自动选择简单/中等/大型对应的工作流',
  inputJSONSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '任务描述，如实描述需求即可' },
    },
    required: ['task'],
  },
  handler: async (args: { task: string }) => {
    try {
      const { tier, reason } = analyzeComplexity(args.task || '')
      const defs = workflowStore.listDefinitions()
      const matched = defs.filter((d: any) => d.tags?.includes(tier) || d.name?.toLowerCase().includes(tier))
      const fallbackId =
        tier === 'simple' ? 'preset_dev_pipeline_simple' : tier === 'medium' ? 'preset_dev_pipeline_medium' : 'preset_dev_pipeline_large'
      const wfList = matched.length
        ? matched.map((d: any) => `  - ${d.name} (${d.id})`).join('\n')
        : `  - ${tier === 'simple' ? '简单' : tier === 'medium' ? '中等' : '大型'}开发管线 (${fallbackId})`
      const wfHint = `\n\n推荐启动: start_workflow workflowId="${fallbackId}"`
      return formatToolResult(
        `复杂度分析: ${tier}（${reason}）\n推荐工作流:\n${wfList}${wfHint}\n\n或用 create_workflow 创建自定义工作流。`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const listWorkflowsTool = buildTool({
  name: 'list_workflows',
  description: '列出所有可用的工作流定义，包括启用/停用状态。不传 showDisabled 则只显示已启用的。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      showDisabled: {
        type: 'boolean',
        description: '是否同时显示已停用的工作流，默认 false',
      },
    },
    required: [],
  },
  handler: async (args: { showDisabled?: boolean }) => {
    try {
      let defs = workflowStore.listDefinitions()
      if (!args.showDisabled) defs = defs.filter((d) => d.enabled !== false)
      if (defs.length === 0) return formatToolResult('暂无工作流定义。')
      return formatToolResult(
        defs
          .map((d) => {
            const status = d.enabled === false ? '[已停用]' : '[启用]'
            return `• ${status} ${d.name} (${d.id}) — ${d.steps.length} 步`
          })
          .join('\n'),
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const createWorkflowTool = buildTool({
  name: 'create_workflow',
  description: '创建一个新的工作流定义。工作流由多个步骤组成，步骤之间可以有依赖关系（DAG）。创建后默认启用。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '工作流名称' },
      description: { type: 'string', description: '工作流描述' },
      steps: {
        type: 'array',
        description: '工作流步骤列表',
        items: (() => ({
          type: 'object',
          properties: {
            id: { type: 'string', description: '步骤唯一标识，如 s1, s2' },
            name: { type: 'string', description: '步骤名称' },
            description: { type: 'string', description: '步骤描述' },
            handler: {
              type: 'string',
              enum: [
                'subagent',
                'tool',
                'api',
                'prompt',
                'plan',
                'condition',
                'foreach',
                'transform',
                'gate',
                'aggregate',
                'subflow',
                'wait',
                'script',
                'event',
              ],
              description:
                '执行方式: subagent=子agent, tool=工具调用, api=API请求, prompt=注入prompt, plan=创建计划, condition=条件分支, foreach=循环, transform=变换, gate=审批门, aggregate=聚合, subflow=子流程, wait=等待, script=脚本, event=事件',
            },
            config: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: '当 handler=subagent/prompt 时的 prompt 内容' },
                tool: { type: 'string', description: '当 handler=tool 时的工具名' },
                apiUrl: { type: 'string', description: '当 handler=api 时的 API URL' },
                apiMethod: { type: 'string', description: '当 handler=api 时的 HTTP 方法' },
                planPrompt: { type: 'string', description: '当 handler=plan 时的计划 prompt' },
                allowedTools: { type: 'array', items: { type: 'string' }, description: '可用的工具列表' },
                maxTurns: { type: 'number', description: '最大交互轮数' },
                outputFile: { type: 'string', description: '输出文件路径' },
                // New handlers
                condition: {
                  type: 'object',
                  properties: {
                    source: { type: 'string', description: '条件判断来源（如 {{steps.s1.result.score}}）' },
                    cases: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          if: { type: 'string', description: '条件表达式，如 "> 7"' },
                          goto: { type: 'string', description: '满足条件时跳转到此步骤 ID' },
                        },
                        required: ['if', 'goto'],
                      },
                    },
                    defaultGoto: { type: 'string', description: '无匹配时跳转到的步骤 ID（可选）' },
                  },
                  description: 'handler=condition 时的条件分支配置',
                },
                foreach: {
                  type: 'object',
                  properties: {
                    items: { type: 'string', description: '要遍历的数组（如 {{steps.s1.result.items}}）' },
                    workflowId: { type: 'string', description: '对每项执行的工作流 ID' },
                    concurrency: { type: 'number', description: '并发数，默认 1' },
                  },
                  description: 'handler=foreach 时的循环配置',
                },
                gate: {
                  type: 'object',
                  properties: {
                    message: { type: 'string', description: '审批消息' },
                    preview: { type: 'string', description: '预览内容（支持模板引用）' },
                    options: { type: 'array', items: { type: 'string' }, description: '审批选项: approve, reject, modify' },
                  },
                  description: 'handler=gate 时的审批门配置',
                },
                transform: {
                  type: 'object',
                  properties: {
                    input: { type: 'string', description: '输入来源（如 {{steps.s1.result}}）' },
                    mapping: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                      description: '输出映射，key=新字段, value=模板表达式',
                    },
                  },
                  description: 'handler=transform 时的数据变换配置',
                },
                aggregate: {
                  type: 'object',
                  properties: {
                    sources: { type: 'array', items: { type: 'string' }, description: '要聚合的步骤 ID 列表' },
                    strategy: { type: 'string', enum: ['merge', 'concat', 'pick-first', 'custom'], description: '聚合策略' },
                  },
                  description: 'handler=aggregate 时的聚合配置',
                },
                subflow: {
                  type: 'object',
                  properties: {
                    workflowId: { type: 'string', description: '子工作流 ID' },
                    input: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                      description: '传递给子工作流的输入',
                    },
                  },
                  description: 'handler=subflow 时的子流程配置',
                },
                wait: {
                  type: 'object',
                  properties: {
                    durationMs: { type: 'number', description: '等待时长（毫秒）' },
                    waitForStep: { type: 'string', description: '等待某步骤完成' },
                  },
                  description: 'handler=wait 时的等待配置',
                },
                script: {
                  type: 'object',
                  properties: {
                    code: { type: 'string', description: 'JS 函数体代码' },
                  },
                  description: 'handler=script 时的脚本配置',
                },
                event: {
                  type: 'object',
                  properties: {
                    eventName: { type: 'string', description: '要发送的事件名称' },
                    payload: { type: 'string', description: '事件载荷（可选，支持模板引用）' },
                  },
                  description: 'handler=event 时的事件配置',
                },
              },
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: '依赖的上一步 ID 列表。空数组表示无依赖，可与其他无依赖步骤并行执行',
            },
            retryCount: { type: 'number', description: '失败重试次数，默认 0' },
            retryDelayMs: { type: 'number', description: '重试间隔（毫秒），默认 5000' },
            runOn: { type: 'string', enum: ['success', 'failure'], description: '运行条件: success=仅前序成功时, failure=仅前序失败时' },
          },
          required: ['id', 'name', 'description', 'handler', 'dependsOn'],
        }))() as any,
      },
      tags: {
        type: 'array',
        items: (() => ({ type: 'string' }))() as any,
        description: '可选标签，如 simple/medium/large',
      },
      trigger: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['manual', 'cron', 'event'], description: '触发类型' },
          cron: { type: 'string', description: 'cron 表达式（type=cron 时必填）' },
          event: { type: 'string', description: '事件名（type=event 时必填）' },
          defaultInput: { type: 'string', description: '触发时的默认输入' },
        },
        required: ['type'],
        description: '调度触发器配置',
      },
      maxConcurrency: { type: 'number', description: '最大并发步骤数，默认 5' },
    },
    required: ['name', 'description', 'steps'],
  },
  handler: async (args: { name: string; description: string; steps: any[]; tags?: string[]; trigger?: any; maxConcurrency?: number }) => {
    try {
      const def: WorkflowDef = {
        id: `wf_${Date.now()}`,
        name: args.name,
        description: args.description,
        steps: args.steps as WorkflowStepDef[],
        tags: args.tags || [],
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        trigger: args.trigger,
        maxConcurrency: args.maxConcurrency,
      }

      // 校验工作流质量
      const validation = validateWorkflow(def)
      if (!validation.valid) {
        const errSummary = validation.issues
          .filter((i) => i.severity === 'error')
          .map((i) => `  ⛔ [${i.stepId || '全局'}] ${i.message}`)
          .join('\n')
        const warnSummary = validation.issues
          .filter((i) => i.severity === 'warning')
          .map((i) => `  ⚠️ [${i.stepId || '全局'}] ${i.message}`)
          .join('\n')
        return formatToolResult(
          `工作流「${def.name}」存在质量问题，创建失败：\n${errSummary}${warnSummary ? '\n\n警告（不影响创建）：\n' + warnSummary : ''}`,
        )
      }

      workflowStore.saveDefinition(def)
      return formatToolResult(`工作流「${def.name}」已创建 (ID: ${def.id})，共 ${def.steps.length} 个步骤。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const autoScheduleWorkflowTool = buildTool({
  name: 'auto_schedule_workflow',
  description:
    '【自主调度入口】AI 创建、执行并等待工作流完成。失败时自动修复重试（最多 2 次）。适用于：多步骤任务需要并行/串行编排、需要审批门(gate)介入、需要条件分支(condition)、需要数据变换(transform)、需要循环处理(foreach)。传 steps 数组定义步骤。创建后等待执行完成并返回结果。如果最终失败请用 update_workflow 修复步骤后用 rerun_workflow 重跑。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '工作流名称，反映任务目标' },
      description: { type: 'string', description: '工作流描述，说明整体目标' },
      steps: {
        type: 'array',
        description: '工作流步骤定义',
        items: (() => ({
          type: 'object',
          properties: {
            id: { type: 'string', description: '步骤 ID，如 s1, s2, step_analyze' },
            name: { type: 'string', description: '步骤名称' },
            description: { type: 'string', description: '步骤描述' },
            handler: {
              type: 'string',
              enum: [
                'subagent',
                'tool',
                'api',
                'prompt',
                'plan',
                'condition',
                'foreach',
                'transform',
                'gate',
                'aggregate',
                'subflow',
                'wait',
                'script',
                'event',
              ],
              description:
                '执行方式: subagent=AI子任务, tool=工具, gate=需要你审批, condition=条件判断, foreach=循环, transform=数据变换, aggregate=聚合, wait=等待, script=脚本',
            },
            config: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'subagent/prompt 的 prompt 内容。subagent 会以此为目标独立执行' },
                tool: { type: 'string', description: 'handler=tool 时的工具名' },
                apiUrl: { type: 'string' },
                apiMethod: { type: 'string' },
                planPrompt: { type: 'string' },
                allowedTools: { type: 'array', items: { type: 'string' }, description: 'subagent 可用的工具列表' },
                maxTurns: { type: 'number', description: 'subagent 最大交互轮数' },
                condition: {
                  type: 'object',
                  properties: {
                    source: { type: 'string', description: '条件判断来源，如 {{steps.s1.result.score}}' },
                    cases: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          if: { type: 'string', description: '条件表达式，如 "> 7" 或 "== \\"approve\\""' },
                          goto: { type: 'string', description: '满足条件时跳转到此步骤' },
                        },
                        required: ['if', 'goto'],
                      },
                    },
                    defaultGoto: { type: 'string', description: '无匹配时跳转目标' },
                  },
                  description: '条件分支——根据某步骤的输出值决定后续流向',
                },
                foreach: {
                  type: 'object',
                  properties: {
                    items: { type: 'string', description: '要遍历的数组变量，如 {{steps.s1.result.items}}' },
                    workflowId: { type: 'string', description: '对每项执行的工作流 ID' },
                    concurrency: { type: 'number', description: '并发数，默认 1' },
                  },
                  description: '循环——对数组每项执行子工作流',
                },
                gate: {
                  type: 'object',
                  properties: {
                    message: { type: 'string', description: '审批时向用户展示的消息' },
                    preview: { type: 'string', description: '预览内容，如 {{steps.s1.result}}' },
                    options: { type: 'array', items: { type: 'string' }, description: '审批选项: approve, reject, modify' },
                  },
                  description: '审批门——暂停工作流等待用户确认/修改后再继续',
                },
                transform: {
                  type: 'object',
                  properties: {
                    input: { type: 'string', description: '输入来源，如 {{steps.s1.result}}' },
                    mapping: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                      description: '映射规则: {outputKey: "{{expression}}"}',
                    },
                  },
                  description: '数据变换——将上一步输出映射为新的结构',
                },
                aggregate: {
                  type: 'object',
                  properties: {
                    sources: { type: 'array', items: { type: 'string' }, description: '要聚合的步骤 ID 列表' },
                    strategy: { type: 'string', enum: ['merge', 'concat', 'pick-first', 'custom'], description: '聚合策略' },
                  },
                  description: '聚合——将多个步骤的输出合并为一个',
                },
                subflow: {
                  type: 'object',
                  properties: {
                    workflowId: { type: 'string', description: '子工作流 ID' },
                    input: { type: 'object', additionalProperties: { type: 'string' }, description: '输入参数' },
                  },
                  description: '子流程——内嵌执行另一个工作流',
                },
                wait: {
                  type: 'object',
                  properties: {
                    durationMs: { type: 'number', description: '等待毫秒数' },
                    waitForStep: { type: 'string', description: '等待某步骤完成后继续' },
                  },
                  description: '等待——暂停指定时长',
                },
                script: {
                  type: 'object',
                  properties: {
                    code: { type: 'string', description: 'JS 函数体: (ctx, steps) => any' },
                  },
                  description: '脚本——执行自定义 JS 逻辑',
                },
                event: {
                  type: 'object',
                  properties: {
                    eventName: { type: 'string', description: '事件名' },
                    payload: { type: 'string', description: '事件数据模板' },
                  },
                  description: '事件——发送系统事件',
                },
              },
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: "依赖的上一步 ID 列表。空数组=无依赖（可并行）。['s1']=等 s1 完成",
            },
            retryCount: { type: 'number', description: '失败重试次数，默认 0' },
            retryDelayMs: { type: 'number', description: '重试间隔(ms)，默认 5000' },
            runOn: { type: 'string', enum: ['success', 'failure'], description: '运行条件，默认 success' },
          },
          required: ['id', 'name', 'description', 'handler', 'dependsOn'],
        }))() as any,
      },
      trigger: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['manual', 'cron', 'event'], description: '触发类型' },
          cron: { type: 'string', description: 'cron 表达式（type=cron 时必填），如 "0 8 * * *"=每天8点' },
          event: { type: 'string', description: '事件名（type=event 时必填）' },
          defaultInput: { type: 'string', description: '触发时的默认输入' },
        },
        description: '调度触发器设置。不传则手动触发。设 cron 可让工作流定时自动执行',
      },
      maxConcurrency: { type: 'number', description: '最大并发步骤数，默认 5' },
      userInput: { type: 'string', description: '可选，传递给工作流的初始输入' },
      startImmediately: { type: 'boolean', description: '是否立即启动，默认 true' },
    },
    required: ['name', 'description', 'steps'],
  },
  handler: async (args: {
    name: string
    description: string
    steps: any[]
    trigger?: any
    maxConcurrency?: number
    userInput?: string
    startImmediately?: boolean
  }) => {
    try {
      const def: WorkflowDef = {
        id: `wf_${Date.now()}`,
        name: args.name,
        description: args.description,
        steps: args.steps as WorkflowStepDef[],
        tags: ['auto'],
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        trigger: args.trigger,
        maxConcurrency: args.maxConcurrency,
      }

      // 校验工作流质量
      const validation = validateWorkflow(def)
      if (!validation.valid) {
        const errSummary = validation.issues
          .filter((i) => i.severity === 'error')
          .map((i) => `  ⛔ [${i.stepId || '全局'}] ${i.message}`)
          .join('\n')
        const warnSummary = validation.issues
          .filter((i) => i.severity === 'warning')
          .map((i) => `  ⚠️ [${i.stepId || '全局'}] ${i.message}`)
          .join('\n')
        return formatToolResult(
          `工作流「${def.name}」存在质量问题，创建失败：\n${errSummary}${warnSummary ? '\n\n警告（可忽略）：\n' + warnSummary : ''}`,
        )
      }

      workflowStore.saveDefinition(def)

      const startNow = args.startImmediately !== false
      if (!startNow) {
        return formatToolResult(`工作流「${def.name}」已创建 (ID: ${def.id})，${def.steps.length} 个步骤。等待手动启动。`)
      }

      const scheduler = getWorkflowScheduler()
      const run = await scheduler.runAndWait(def, args.userInput)

      // 检查结果
      const doneSteps = run.steps.filter((s) => s.status === 'done').length
      const failedSteps = run.steps.filter((s) => s.status === 'failed').length
      const stepLines = run.steps
        .map((s) => {
          const icon = s.status === 'done' ? '✅' : s.status === 'failed' ? '⛔' : s.status === 'running' ? '⏳' : '⬜'
          const err = s.error ? `: ${s.error.slice(0, 100)}` : ''
          return `  ${icon} [${s.status}] ${s.stepId}${err}`
        })
        .join('\n')

      if (run.status === 'done') {
        return formatToolResult(`✅ 工作流「${def.name}」执行成功（${doneSteps}/${run.steps.length} 步）\n${stepLines}`)
      }

      // 失败或暂停—返回详细结果供 AI 自动修复
      const failedDetails = run.steps
        .filter((s) => s.status === 'failed')
        .map((s) => `  step="${s.stepId}" error="${s.error || '未知错误'}"`)
        .join('\n')

      const gateInfo = run.pendingGate ? `\n⏸️ 等待审批: ${run.pendingGate.message}` : ''

      // 自动迭代：失败时尝试修复重跑（最多 2 次）
      let iteration = 0
      const MAX_ITER = 2
      let currentRun = run
      let currentDef = def

      while (currentRun.status === 'failed' && iteration < MAX_ITER) {
        iteration++
        // 简单修复策略：增加重试次数和超时
        const fixedSteps = currentDef.steps.map((s) => {
          if (run.steps.find((rs) => rs.stepId === s.id && rs.status === 'failed')) {
            return {
              ...s,
              retryCount: Math.max(s.retryCount ?? 0, 2),
              retryDelayMs: Math.max(s.retryDelayMs ?? 5000, 10000),
            }
          }
          return s
        })
        currentDef = { ...currentDef, steps: fixedSteps as WorkflowStepDef[], updatedAt: Date.now() }
        workflowStore.saveDefinition(currentDef)

        currentRun = await scheduler.runAndWait(currentDef, args.userInput)

        const iterDone = currentRun.steps.filter((s) => s.status === 'done').length
        const iterFailed = currentRun.steps.filter((s) => s.status === 'failed').length

        if (currentRun.status === 'done') {
          return formatToolResult(
            `✅ 工作流「${def.name}」自动修复后执行成功（第 ${iteration} 次重试）\n` +
              `步骤: ${iterDone}/${currentRun.steps.length}\n` +
              currentRun.steps.map((s) => `  ${s.status === 'done' ? '✅' : '⛔'} [${s.status}] ${s.stepId}`).join('\n'),
          )
        }
      }

      // 最终失败—返回供外面 AI 继续修
      return formatToolResult(
        `⛔ 工作流「${def.name}」执行失败（${failedSteps}/${run.steps.length} 步失败）` +
          `${run.pendingGate ? '（暂停于审批门）' : ''}\n${stepLines}\n\n` +
          `失败详情:\n${failedDetails}${gateInfo}\n\n` +
          `请用 update_workflow 修复失败的步骤后用 rerun_workflow 重跑。`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const startWorkflowTool = buildTool({
  name: 'start_workflow',
  description: '启动一个已定义的工作流。根据步骤的 dependsOn 自动解析执行顺序，无依赖的步骤并行运行。只能启动已启用的工作流。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: '工作流定义 ID（从 list_workflows 获取）' },
      userInput: { type: 'string', description: '（可选）用户输入的主题/需求，工作流中的 {INPUT} 占位符会被替换为此值' },
    },
    required: ['workflowId'],
  },
  handler: async (args: { workflowId: string; userInput?: string }) => {
    try {
      const def = workflowStore.getDefinition(args.workflowId)
      if (!def) return formatToolResult(`工作流 ${args.workflowId} 不存在`)
      if (def.enabled === false) return formatToolResult(`工作流「${def.name}」已停用，无法启动。请先用 enable_workflow 启用。`)

      // 启动前校验（防止 SQLite 中有脏数据）
      const validation = validateWorkflow(def)
      if (!validation.valid) {
        const errSummary = validation.issues
          .filter((i) => i.severity === 'error')
          .map((i) => `  ⛔ [${i.stepId || '全局'}] ${i.message}`)
          .join('\n')
        return formatToolResult(`工作流「${def.name}」存在质量问题，无法启动：\n${errSummary}`)
      }

      const scheduler = getWorkflowScheduler()
      const run = scheduler.startRun(def, args.userInput)
      return formatToolResult(
        `工作流「${def.name}」已启动 (RunID: ${run.runId})，共 ${def.steps.length} 个步骤。${args.userInput ? ` 输入: "${args.userInput}"` : ''}`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const getWorkflowStatusTool = buildTool({
  name: 'get_workflow_status',
  description: '查看工作流运行状态。不传 runId 时返回所有活跃运行。传 detailed=true 可看每步输出/错误。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: '运行 ID' },
      detailed: { type: 'boolean', description: '显示详细步骤信息' },
    },
    required: [],
  },
  handler: async (args: { runId?: string; detailed?: boolean }) => {
    try {
      if (args.runId) {
        const run = workflowStore.getRun(args.runId)
        if (!run) return formatToolResult(`运行 ${args.runId} 不存在。`)

        if (args.detailed) {
          let summary = `📋 ${run.workflowName}\n状态: ${run.status} | 运行ID: ${run.runId}\n`
          for (const s of run.steps) {
            const retryInfo = s.retryCount && s.retryCount > 0 ? ` 重试:${s.retryCount}x` : ''
            summary += `\n[${s.status}] ${s.stepId}${retryInfo}`
            if (s.error) summary += `\n  ⛔ ${s.error.slice(0, 300)}`
            if (s.agentResult) {
              const preview = s.agentResult.length > 150 ? s.agentResult.slice(0, 150) + '...' : s.agentResult
              summary += `\n  📤 ${preview}`
            }
          }
          return formatToolResult(summary)
        }

        const stepSummary = run.steps
          .map((s) => {
            const mark = s.status === 'done' ? '✅' : s.status === 'failed' ? '⛔' : s.status === 'running' ? '⏳' : '⬜'
            return `  ${mark} [${s.status}] ${s.stepId}`
          })
          .join('\n')
        return formatToolResult(`工作流「${run.workflowName}」状态: ${run.status}\n步骤:\n${stepSummary}`)
      }
      const allRuns = workflowStore.listRuns(10)
      const active = allRuns.filter((r) => r.status === 'running')
      if (active.length === 0) return formatToolResult('当前无活跃工作流运行。')
      return formatToolResult(
        active
          .map((r) => `• ${r.workflowName} (${r.runId}) — ${r.steps.filter((s) => s.status === 'done').length}/${r.steps.length} 步完成`)
          .join('\n'),
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// ── New workflow management tools ──

export const updateWorkflowTool = buildTool({
  name: 'update_workflow',
  description: '更新已有工作流定义的属性（名称、描述、步骤、标签等）。只需传需要修改的字段。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: '要更新的工作流定义 ID' },
      name: { type: 'string', description: '新的名称' },
      description: { type: 'string', description: '新的描述' },
      steps: {
        type: 'array',
        description: '新的步骤列表（全量替换）',
        items: (() => ({
          type: 'object',
          properties: {
            id: { type: 'string', description: '步骤唯一标识' },
            name: { type: 'string', description: '步骤名称' },
            description: { type: 'string', description: '步骤描述' },
            handler: {
              type: 'string',
              enum: [
                'subagent',
                'tool',
                'api',
                'prompt',
                'plan',
                'condition',
                'foreach',
                'transform',
                'gate',
                'aggregate',
                'subflow',
                'wait',
                'script',
                'event',
              ],
            },
            config: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                tool: { type: 'string' },
                apiUrl: { type: 'string' },
                apiMethod: { type: 'string' },
                planPrompt: { type: 'string' },
                condition: {
                  type: 'object',
                  properties: {
                    source: { type: 'string' },
                    cases: { type: 'array', items: { type: 'object', properties: { if: { type: 'string' }, goto: { type: 'string' } } } },
                    defaultGoto: { type: 'string' },
                  },
                },
                foreach: {
                  type: 'object',
                  properties: { items: { type: 'string' }, workflowId: { type: 'string' }, concurrency: { type: 'number' } },
                },
                gate: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    preview: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                  },
                },
                transform: {
                  type: 'object',
                  properties: { input: { type: 'string' }, mapping: { type: 'object', additionalProperties: { type: 'string' } } },
                },
                aggregate: {
                  type: 'object',
                  properties: {
                    sources: { type: 'array', items: { type: 'string' } },
                    strategy: { type: 'string', enum: ['merge', 'concat', 'pick-first', 'custom'] },
                  },
                },
                subflow: {
                  type: 'object',
                  properties: { workflowId: { type: 'string' }, input: { type: 'object', additionalProperties: { type: 'string' } } },
                },
                wait: { type: 'object', properties: { durationMs: { type: 'number' }, waitForStep: { type: 'string' } } },
                script: { type: 'object', properties: { code: { type: 'string' } } },
                event: { type: 'object', properties: { eventName: { type: 'string' }, payload: { type: 'string' } } },
              },
            },
            dependsOn: { type: 'array', items: { type: 'string' } },
            retryCount: { type: 'number' },
            retryDelayMs: { type: 'number' },
            runOn: { type: 'string', enum: ['success', 'failure'] },
          },
          required: ['id', 'name', 'description', 'handler', 'dependsOn'],
        }))() as any,
      },
      tags: {
        type: 'array',
        items: (() => ({ type: 'string' }))() as any,
        description: '新的标签列表（全量替换）',
      },
      trigger: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['manual', 'cron', 'event'] },
          cron: { type: 'string' },
          event: { type: 'string' },
          defaultInput: { type: 'string' },
        },
      },
      maxConcurrency: { type: 'number' },
    },
    required: ['workflowId'],
  },
  handler: async (args: {
    workflowId: string
    name?: string
    description?: string
    steps?: any[]
    tags?: string[]
    trigger?: any
    maxConcurrency?: number
  }) => {
    try {
      const existing = workflowStore.getDefinition(args.workflowId)
      if (!existing) return formatToolResult(`工作流 ${args.workflowId} 不存在。`)
      const updated = {
        ...existing,
        name: args.name ?? existing.name,
        description: args.description ?? existing.description,
        steps: args.steps ?? existing.steps,
        tags: args.tags ?? (existing as any).tags,
        trigger: args.trigger ?? (existing as any).trigger,
        maxConcurrency: args.maxConcurrency ?? (existing as any).maxConcurrency,
        updatedAt: Date.now(),
      }
      workflowStore.saveDefinition(updated)
      return formatToolResult(`工作流「${updated.name}」已更新。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const deleteWorkflowTool = buildTool({
  name: 'delete_workflow',
  description: '删除一个工作流定义。此操作不可恢复。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: '要删除的工作流定义 ID' },
    },
    required: ['workflowId'],
  },
  handler: async (args: { workflowId: string }) => {
    try {
      const existing = workflowStore.getDefinition(args.workflowId)
      if (!existing) return formatToolResult(`工作流 ${args.workflowId} 不存在。`)
      workflowStore.deleteDefinition(args.workflowId)
      return formatToolResult(`工作流「${existing.name}」已删除。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const enableWorkflowTool = buildTool({
  name: 'enable_workflow',
  description: '启用一个已停用的工作流，使其可以再次启动。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: '工作流定义 ID' },
    },
    required: ['workflowId'],
  },
  handler: async (args: { workflowId: string }) => {
    try {
      const existing = workflowStore.getDefinition(args.workflowId)
      if (!existing) return formatToolResult(`工作流 ${args.workflowId} 不存在。`)
      if (existing.enabled !== false) return formatToolResult(`工作流「${existing.name}」已经是启用状态。`)
      workflowStore.saveDefinition({ ...existing, enabled: true, updatedAt: Date.now() })
      return formatToolResult(`工作流「${existing.name}」已启用。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const disableWorkflowTool = buildTool({
  name: 'disable_workflow',
  description: '停用一个工作流。停用后无法 start_workflow 启动它，但已有运行中的实例不受影响。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: '工作流定义 ID' },
    },
    required: ['workflowId'],
  },
  handler: async (args: { workflowId: string }) => {
    try {
      const existing = workflowStore.getDefinition(args.workflowId)
      if (!existing) return formatToolResult(`工作流 ${args.workflowId} 不存在。`)
      if (existing.enabled === false) return formatToolResult(`工作流「${existing.name}」已经是停用状态。`)
      workflowStore.saveDefinition({ ...existing, enabled: false, updatedAt: Date.now() })
      return formatToolResult(`工作流「${existing.name}」已停用。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const cancelWorkflowRunTool = buildTool({
  name: 'cancel_workflow_run',
  description: '取消一个正在运行的工作流实例。相当于强制中止。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: '运行 ID（从 get_workflow_status 获取）' },
    },
    required: ['runId'],
  },
  handler: async (args: { runId: string }) => {
    try {
      const scheduler = getWorkflowScheduler()
      const ok = scheduler.stopRun(args.runId)
      if (!ok) return formatToolResult(`运行 ${args.runId} 不存在或已结束。`)
      return formatToolResult(`运行 ${args.runId} 已取消。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const approveWorkflowGateTool = buildTool({
  name: 'approve_workflow_gate',
  description: '审批工作流中的审批门（gate）步骤。当工作流因 gate 暂停时，使用此工具 approve 通过或 reject 驳回。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: '运行 ID（从 get_workflow_status 获取）' },
      stepId: { type: 'string', description: '审批门步骤 ID' },
      decision: { type: 'string', enum: ['approve', 'reject'], description: 'approve=通过, reject=驳回' },
      comment: { type: 'string', description: '可选审批意见' },
    },
    required: ['runId', 'stepId', 'decision'],
  },
  handler: async (args: { runId: string; stepId: string; decision: string; comment?: string }) => {
    try {
      const scheduler = getWorkflowScheduler()
      const ok = scheduler.approveGate(args.runId, args.stepId, args.decision, args.comment)
      if (!ok) return formatToolError(`审批失败：运行 ${args.runId} 的 gate（${args.stepId}）不存在或已处理`)
      return formatToolResult(`✅ 审批门「${args.stepId}」已 ${args.decision === 'approve' ? '通过' : '驳回'}，工作流继续执行。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const rerunWorkflowTool = buildTool({
  name: 'rerun_workflow',
  description: '从历史运行记录重新运行工作流。会基于上次的定义和输入创建全新的运行。常用于失败后修复定义再重跑。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: '要重跑的历史运行 ID' },
      userInput: { type: 'string', description: '可选，覆盖上次的输入' },
    },
    required: ['runId'],
  },
  handler: async (args: { runId: string; userInput?: string }) => {
    try {
      const scheduler = getWorkflowScheduler()
      const run = scheduler.rerunRun(args.runId, args.userInput)
      if (!run) return formatToolResult(`运行 ${args.runId} 不存在或对应的定义已被删除。`)
      return formatToolResult(
        `工作流「${run.workflowName}」已重新启动 (新 RunID: ${run.runId})。\n` +
          `用 get_workflow_status runId="${run.runId}" detailed=true 查看执行状态`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const listWorkflowRunsTool = buildTool({
  name: 'list_workflow_runs',
  description: '查看工作流运行历史记录，按时间倒序排列。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '返回条数，默认 10，最大 50' },
      status: {
        type: 'string',
        enum: ['running', 'done', 'failed', 'pending'],
        description: '可选，按状态筛选',
      },
    },
    required: [],
  },
  handler: async (args: { limit?: number; status?: string }) => {
    try {
      let runs = workflowStore.listRuns(Math.min(args.limit || 10, 50))
      if (args.status) runs = runs.filter((r) => r.status === args.status)
      if (runs.length === 0) return formatToolResult('暂无工作流运行记录。')
      return formatToolResult(
        runs
          .map((r) => {
            const done = r.steps.filter((s) => s.status === 'done').length
            const failed = r.steps.filter((s) => s.status === 'failed').length
            return `• [${r.status}] ${r.workflowName} (${r.runId}) — ${done}/${r.steps.length} 步完成${failed ? `, ${failed} 步失败` : ''}`
          })
          .join('\n'),
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// ── Helper: complexity analysis (moved from WorkflowEngine) ──

type TaskTier = 'simple' | 'medium' | 'large'

const SIMPLE_PATTERNS = [
  /改(n?[文文案样式]|样式|文案|bug|Bug|bugzilla)/i,
  /增[加]?[个字一]?字段/i,
  /修[改复]?[一个]?bug/i,
  /改[变]?颜色/i,
  /修[改变更]?样式/i,
]

const LARGE_PATTERNS = [/新系统/i, /架构[升升级改造]/i, /技术栈[迁迁徙更变]/i, /从.*迁移到/i, /重写/i, /全新[模块系统]/i, /系统设计/i]

function analyzeComplexity(taskDescription: string): { tier: TaskTier; reason: string } {
  for (const p of LARGE_PATTERNS) {
    if (p.test(taskDescription)) return { tier: 'large', reason: '检测到架构级变更关键词' }
  }
  for (const p of SIMPLE_PATTERNS) {
    if (p.test(taskDescription)) return { tier: 'simple', reason: '检测到简单修改关键词' }
  }
  const len = taskDescription.length
  if (len > 80) return { tier: 'medium', reason: '描述较长，需要规划' }
  if (len > 30) return { tier: 'medium', reason: '中等复杂度任务' }
  return { tier: 'simple', reason: '简短指令，直接执行' }
}
