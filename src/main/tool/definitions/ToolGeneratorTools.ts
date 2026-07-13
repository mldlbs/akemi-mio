/**
 * ToolGeneratorTools — 自进化工具生成工具定义
 *
 * Agent 在对话中发现现有工具无法满足用户需求时，
 * 调用 create_tool 让系统自动生成并注册新工具。
 *
 * 配套的 list_dynamic_tools 用于查看所有已生成的动态工具。
 *
 * 注意：使用动态 import() 避免与 tool-generator 形成循环依赖
 * (getAllTools → ToolGeneratorTools → tool-generator → mcp/LocalProvider → getAllTools)
 */

import { buildTool, formatToolResult, formatToolError } from '../types'

// =============================================================================
// create_tool — 创建新工具
// =============================================================================

export const createTool = buildTool({
  name: 'create_tool',
  description: '根据自然语言需求描述，自动生成并注册一个新的 MCP 工具。Agent 在发现现有工具无法满足用户需求时调用此工具。支持自动生成代码、tsc 编译验证、运行时注册。完成后可通过工具名立即调用。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      need: {
        type: 'string',
        description: '需要新工具满足什么需求的自然语言描述，越具体越好。例如："获取指定 GitHub 仓库的 star 数量"',
      },
      preferred_name: {
        type: 'string',
        description: '期望的工具名（snake_case），可选。例如：get_github_stars',
      },
      safety_mode: {
        type: 'string',
        enum: ['auto', 'review'],
        description: '安全模式：auto=自动注册（默认），review=仅生成代码不注册',
      },
    },
    required: ['need'],
  },
  handler: async (args: { need: string; preferred_name?: string; safety_mode?: 'auto' | 'review' }) => {
    try {
      // 使用动态 import 避免循环依赖
      const { toolGeneratorService } = await import('../tool-generator')

      if (!toolGeneratorService.canAccept()) {
        return formatToolError('生成队列已满（最多 3 个并发生成），请稍后再试')
      }

      const result = await toolGeneratorService.generateTool({
        need: args.need,
        preferredName: args.preferred_name,
        safetyMode: args.safety_mode || 'auto',
      })

      if (!result.success) {
        return formatToolError(`工具创建失败: ${result.error || '未知错误'}`)
      }

      const tool = result.tool!
      const lines = [
        `✅ 新工具 "${tool.name}" 创建成功！`,
        ``,
        `📋 描述：${tool.description}`,
        `📁 源文件：${tool.sourcePath}`,
        `🔧 tsc 验证：${tool.tscPassed ? '通过' : '未验证'}`,
        ``,
        `📝 输入参数 Schema：`,
      ]

      // 列出参数
      const props = tool.inputJSONSchema.properties
      const req = tool.inputJSONSchema.required
      for (const [key, val] of Object.entries(props)) {
        const requiredMark = req.includes(key) ? ' (必填)' : ''
        lines.push(`  - ${key}: ${val.description}${requiredMark}`)
      }

      if (result.log && result.log.length > 0) {
        lines.push(``, `📖 生成日志：`)
        for (const entry of result.log) {
          lines.push(`  ${entry}`)
        }
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`工具创建异常: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// list_dynamic_tools — 列出已生成的动态工具
// =============================================================================

export const listDynamicTools = buildTool({
  name: 'list_dynamic_tools',
  description: '列出所有通过 create_tool 自动生成的动态工具及其状态',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const { toolGeneratorService } = await import('../tool-generator')
      const tools = toolGeneratorService.listGeneratedTools()

      if (tools.length === 0) {
        return formatToolResult('暂无动态生成的工具。如有需要，可调用 create_tool 创建新工具。')
      }

      const lines = [
        `📦 已生成 ${tools.length} 个动态工具：`,
        ``,
      ]

      for (const t of tools) {
        lines.push(`  🔧 ${t.name}`)
        lines.push(`     描述：${t.description}`)
        lines.push(`     注册时间：${new Date(t.createdAt).toLocaleString('zh-CN')}`)
        lines.push(`     源文件：${t.sourcePath}`)
        lines.push(`     tsc：${t.tscPassed ? '✅ 通过' : '❌ 未通过'}`)
        lines.push(``)
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`列出动态工具失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})
