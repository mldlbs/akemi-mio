import { buildTool, formatToolResult, formatToolError } from '../types'
import { PROJECT_ROOT } from '../utils/workspace'
import {
  analyzeComplexity,
  getPipelineModule,
  matchStandaloneSkills,
  checkColdStart,
  getColdStartPrompt,
  getIncrementalPrompt,
  listWorkflows,
} from '../../workflow/WorkflowEngine'

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
      const pipelineModule = getPipelineModule(tier)
      const standalone = matchStandaloneSkills(args.task || '')
      const standaloneModule = standalone.length > 0 ? '\n\n' + standalone.map((s) => s.promptModule).join('\n\n') : ''
      const { isColdStart, existing } = checkColdStart(PROJECT_ROOT)
      let coldStartNote = ''
      if (isColdStart) {
        coldStartNote = '\n\n' + getColdStartPrompt()
      } else if (existing.length > 0) {
        coldStartNote = '\n\n' + getIncrementalPrompt('', existing)
      }
      const allModules = `${pipelineModule}${standaloneModule}${coldStartNote}`
      return formatToolResult(
        `__WORKFLOW_ACTIVATED__:${tier}\n` +
          `复杂度分析: ${tier}（${reason}）${standalone.length > 0 ? '\n自动匹配：' + standalone.map((s) => s.name).join(', ') : ''}\n` +
          `${allModules}`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

export const listWorkflowsTool = buildTool({
  name: 'list_workflows',
  description: '列出所有可用的工程化工作流',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      return formatToolResult(listWorkflows())
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})
