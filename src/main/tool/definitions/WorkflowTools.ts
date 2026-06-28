import { buildTool, formatToolResult, formatToolError } from '../types'
import { workflowStore } from '../../workflow/WorkflowStore'
import { getWorkflowScheduler } from '../../workflow/WorkflowScheduler'

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
      // fallback: 按 pipeline ID 推荐
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
  description: '列出所有可用的工作流定义',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const defs = workflowStore.listDefinitions()
      if (defs.length === 0) return formatToolResult('暂无工作流定义。')
      return formatToolResult(defs.map((d) => `• ${d.name} (${d.id}) — ${d.steps.length} 步`).join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const createWorkflowTool = buildTool({
  name: 'create_workflow',
  description:
    '创建一个新的工作流定义。工作流由多个步骤组成，步骤之间可以有依赖关系（DAG），支持子 agent、工具调用、API 调用、prompt 注入和 plan 五种 handler 类型。',
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
              enum: ['subagent', 'tool', 'api', 'prompt', 'plan'],
              description: '执行方式: subagent=子agent, tool=工具, api=API, prompt=注入prompt, plan=创建开发计划',
            },
            config: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: '当 handler=subagent/prompt 时的 prompt 内容' },
                tool: { type: 'string', description: '当 handler=tool 时的工具名' },
                apiUrl: { type: 'string', description: '当 handler=api 时的 API URL' },
                apiMethod: { type: 'string', description: '当 handler=api 时的 HTTP 方法' },
                planPrompt: { type: 'string', description: '当 handler=plan 时的计划 prompt' },
              },
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: '依赖的上一步 ID 列表。空数组表示无依赖，可与其他无依赖步骤并行执行',
            },
          },
          required: ['id', 'name', 'description', 'handler', 'dependsOn'],
        }))() as any,
      },
      tags: {
        type: 'array',
        items: (() => ({ type: 'string' }))() as any,
        description: '可选标签，如 simple/medium/large',
      },
    },
    required: ['name', 'description', 'steps'],
  },
  handler: async (args: { name: string; description: string; steps: any[]; tags?: string[] }) => {
    try {
      const def = {
        id: `wf_${Date.now()}`,
        name: args.name,
        description: args.description,
        steps: args.steps,
        tags: args.tags || [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      workflowStore.saveDefinition(def)
      return formatToolResult(`工作流「${def.name}」已创建 (ID: ${def.id})，共 ${def.steps.length} 个步骤。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const startWorkflowTool = buildTool({
  name: 'start_workflow',
  description: '启动一个已定义的工作流。根据步骤的 dependsOn 自动解析执行顺序，无依赖的步骤并行运行。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: '工作流定义 ID（从 list_workflows 获取）' },
    },
    required: ['workflowId'],
  },
  handler: async (args: { workflowId: string }) => {
    try {
      const def = workflowStore.getDefinition(args.workflowId)
      if (!def) return formatToolError(`工作流 ${args.workflowId} 不存在`)
      const scheduler = getWorkflowScheduler()
      const run = scheduler.startRun(def)
      return formatToolResult(`工作流「${def.name}」已启动 (RunID: ${run.runId})，共 ${def.steps.length} 个步骤。`)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
})

export const getWorkflowStatusTool = buildTool({
  name: 'get_workflow_status',
  description: '查看工作流运行状态。不传 runId 时返回所有活跃运行。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: '可选，运行 ID' },
    },
    required: [],
  },
  handler: async (args: { runId?: string }) => {
    try {
      if (args.runId) {
        const run = workflowStore.getRun(args.runId)
        if (!run) return formatToolError(`运行 ${args.runId} 不存在`)
        const stepSummary = run.steps.map((s) => `  [${s.status}] ${s.stepId}`).join('\n')
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
