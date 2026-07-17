/**
 * TelegramGatewayTools — 消息网关的 Agent 可调用 MCP 工具
 *
 * 提供以下工具：
 * - execute_data_source: 运行已注册的数据源工具（如 radar_scan），支持格式协商
 * - list_data_sources: 列出所有注册的数据源工具及其能力
 * - message_gateway_status: 查看网关运行状态
 *
 * 这些工具通过 getAllTools() 注册到 MCP 工具链。
 * 依赖全局 messageGateway 单例。
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { messageGateway } from '../../telegram/MessageGateway'
import { OUTPUT_FORMAT_LABELS, dataSourceResultToMCP } from '../../telegram/DataSourceTool'
import type { OutputFormat } from '../../telegram/DataSourceTool'

// =============================================================================
// execute_data_source — 执行数据源工具
// =============================================================================

export const executeDataSourceTool = buildTool({
  name: 'execute_data_source',
  description:
    '运行消息网关中已注册的数据源工具（如 radar_scan）。' +
    '支持按需采集网络情报、分析数据、触发外部服务。' +
    '可以通过 format 参数控制输出格式：text（文本）、json（JSON 数据）、auto（自动选择）。' +
    '适用于需要实时数据采集和外部信息查询的场景。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '数据源工具名。使用 list_data_sources 查看所有可用工具列表。',
      },
      params: {
        type: 'object',
        description: '工具参数，具体字段取决于工具定义。例如 radar_scan 支持 sources、keywords、limit 等参数。',
      },
      format: {
        type: 'string',
        enum: ['text', 'json', 'auto'],
        description: '输出格式。text（人类可读文本）、json（结构化数据）、auto（自动选择最佳格式）',
      },
    },
    required: ['name'],
  },
  handler: async (args: { name: string; params?: Record<string, any>; format?: string }) => {
    try {
      const toolName = args.name.trim()
      const format = (args.format ?? 'auto') as OutputFormat

      if (!messageGateway.initialized) {
        return formatToolError('消息网关未初始化')
      }

      if (!messageGateway.registry.has(toolName)) {
        const available = messageGateway.registry.list().map((t) => t.name).join(', ') || '（无）'
        return formatToolError(`数据源工具 "${toolName}" 未注册。可用工具: ${available}`)
      }

      const result = await messageGateway.executeTool(toolName, args.params ?? {}, format)

      // 如果有图片附件，使用 dataSourceResultToMCP 保留附件
      const hasImage = result.attachments?.some((a) => a.type === 'image')
      if (hasImage) {
        const mcpResult = dataSourceResultToMCP(result)
        return mcpResult
      }

      return formatToolResult(result.text)
    } catch (err: any) {
      return formatToolError(`执行数据源工具失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// list_data_sources — 列出数据源工具
// =============================================================================

export const listDataSourcesTool = buildTool({
  name: 'list_data_sources',
  description: '列出消息网关中所有已注册的数据源工具及其能力描述。用于发现可用工具和了解其支持的参数及输出格式。',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      if (!messageGateway.initialized) {
        return formatToolResult('⚠️ 消息网关未初始化')
      }

      const tools = messageGateway.registry.list()

      if (tools.length === 0) {
        return formatToolResult('📡 消息网关已初始化，但暂无注册的数据源工具。')
      }

      const lines: string[] = [
        `📡 消息网关 — 已注册 ${tools.length} 个数据源工具`,
        ``,
      ]

      for (const tool of tools) {
        const status = tool.isEnabled === false ? ' (已禁用)' : ''
        lines.push(`  🔧 ${tool.name}${status}`)
        lines.push(`     描述: ${tool.description}`)
        lines.push(`     输出格式: ${tool.supportedFormats.map((f) => OUTPUT_FORMAT_LABELS[f] || f).join(', ')}`)
        lines.push(`     默认格式: ${OUTPUT_FORMAT_LABELS[tool.defaultFormat] || tool.defaultFormat}`)

        // 列出参数
        const props = tool.inputJSONSchema.properties
        const propNames = Object.keys(props)
        if (propNames.length > 0) {
          const required = new Set(tool.inputJSONSchema.required || [])
          lines.push(`     参数: `)
          for (const key of propNames) {
            const p = props[key]
            const req = required.has(key) ? ' *必填' : ''
            // 截断长描述
            const desc = (p.description || '').slice(0, 60)
            lines.push(`       • ${key} (${p.type || 'any'})${req}: ${desc}`)
          }
        }
        lines.push(``)
      }

      lines.push('💡 使用 execute_data_source(name="tool_name", params={...}) 调用数据源工具。')

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`列出数据源失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// message_gateway_status — 查看网关状态
// =============================================================================

export const messageGatewayStatusTool = buildTool({
  name: 'message_gateway_status',
  description: '查看消息网关的运行状态，包括初始化状态、注册工具数、当前活跃和等待中的执行数。用于监控和排查网关问题。',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const status = messageGateway.getStatus()
      const lines: string[] = [
        `📊 消息网关状态`,
        ``,
        `  初始化: ${status.initialized ? '✅ 已初始化' : '❌ 未初始化'}`,
        `  注册工具: ${status.registeredTools}`,
        `  活跃执行: ${status.activeExecutions}`,
        `  等待执行: ${status.pendingExecutions}`,
        ``,
        `  工具列表:`,
      ]

      if (status.tools.length === 0) {
        lines.push(`    （无）`)
      } else {
        for (const t of status.tools) {
          lines.push(`    • ${t.name} — ${t.formats}${t.enabled ? '' : ' [禁用]'}`)
        }
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`获取网关状态失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// 导出
// =============================================================================

export const telegramGatewayTools = [
  executeDataSourceTool,
  listDataSourcesTool,
  messageGatewayStatusTool,
] as const
