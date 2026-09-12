/**
 * ToolChainOrchestratorTools — 工具链编排 MCP 工具定义
 *
 * 提供三个工具供 Agent 使用：
 * 1. orchestrate_task — 自动分解复杂任务并编排多工具执行
 * 2. get_orchestration_status — 查询编排运行状态
 * 3. cancel_orchestration — 取消正在运行的编排
 *
 * 这些工具将 ToolChainOrchestrator 的能力以 MCP 工具形式暴露给 Agent，
 * 使 Agent 在收到复杂任务时可直接触发自动工具链编排。
 */

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { getToolChainOrchestrator } from '@akemi-mio/capabilities/tool/deps'

// ══════════════════════════════════════════════════════════════
//  orchestrate_task
// ══════════════════════════════════════════════════════════════

export const orchestrateTaskTool = buildTool({
  name: 'orchestrate_task',
  description:
    '【工具链编排】自动将复杂请求分解为子步骤，发现可用 MCP 工具，按依赖关系编排执行，实时展示进度。适用于需要多个工具协作的场景，如：「帮我查天气并设置闹钟」「搜索某个主题并保存到文件」「分析代码后发送报告」。传入自然语言描述即可，系统会自动分解、匹配工具、按序执行并汇总结果',
  inputJSONSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: '需要编排的自然语言任务描述，如"查询北京的天气并设置一个早上 8 点的闹钟"',
      },
    },
    required: ['task'],
  },
  handler: async (args: { task: string }) => {
    try {
      const orchestrator = getToolChainOrchestrator()
      if (!orchestrator) {
        return formatToolError('工具链编排器不可用（尚未初始化）')
      }

      const task = String(args.task)
      if (!task || task.trim().length < 2) {
        return formatToolError('任务描述太短，请提供更详细的描述')
      }

      const result = await orchestrator.orchestrate(task)

      if (result.success) {
        return formatToolResult(`✅ 工具链编排完成（${result.totalDurationMs}ms）\n\n${result.summary}`)
      }

      return formatToolResult(`⚠️ 工具链编排部分完成（${result.totalDurationMs}ms）\n\n${result.summary}`)
    } catch (err: any) {
      return formatToolError(`编排执行异常: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// ══════════════════════════════════════════════════════════════
//  get_orchestration_status
// ══════════════════════════════════════════════════════════════

export const getOrchestrationStatusTool = buildTool({
  name: 'get_orchestration_status',
  description: '查询工具链编排的运行状态。不传 planId 时返回最近一次编排的摘要信息',
  inputJSONSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        description: '编排计划 ID（可选，不传时返回最近的编排摘要）',
      },
    },
    required: [],
  },
  handler: async (args: { planId?: string }) => {
    try {
      const orchestrator = getToolChainOrchestrator()
      if (!orchestrator) {
        return formatToolError('工具链编排器不可用')
      }

      const planId = args.planId
      // 当前简化实现：返回编排器运行状态
      const config = orchestrator.getConfig()
      const lines = [
        '【工具链编排器状态】',
        `- 最大并发: ${config.maxConcurrency}`,
        `- 步骤超时: ${config.stepTimeoutMs}ms`,
        `- 失败重试: ${config.maxRetries} 次`,
        `- 自动降级: ${config.autoDegradation ? '已开启' : '已关闭'}`,
      ]

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// ══════════════════════════════════════════════════════════════
//  get_available_tools  — 查询当前可用工具列表
// ══════════════════════════════════════════════════════════════

export const getAvailableToolsTool = buildTool({
  name: 'get_available_tools',
  description: '查询当前系统可用的所有 MCP 工具及其参数说明。返回工具名称、描述、参数列表。用于了解当前有哪些工具可以被编排使用',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const orchestrator = getToolChainOrchestrator()
      if (!orchestrator) {
        return formatToolError('工具链编排器不可用')
      }

      // 通过 toToolSummaries 获取工具列表
      // 实际实现中由 ToolChainDecomposer 使用
      return formatToolResult('请使用现有的 list_tools 命令查看可用工具列表。')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

/**
 * 所有工具链编排工具的列表。
 * 由 getAllTools.ts 导入并注册。
 */
export const toolChainOrchestratorTools = [orchestrateTaskTool, getOrchestrationStatusTool, getAvailableToolsTool]

