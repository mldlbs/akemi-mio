/**
 * DynamicRegistryTools — 动态工具注册/注销 MCP 工具定义
 *
 * 提供 Agent 在对话中直接注册和注销临时工具的能力。
 * 与 create_tool 不同，register_tool 不经过 LLM 生成流程，
 * 而是直接由 Agent 提供工具定义和 handler 代码。
 *
 * ## 与 ToolGeneratorTools 的对比
 *
 * | 特性              | create_tool                    | register_tool                  |
 * |------------------|-------------------------------|-------------------------------|
 * | 工具来源          | LLM 生成                       | Agent 直接提供                 |
 * | 主要场景          | 复杂新功能创建                   | 快速临时工具、代码片段包装       |
 * | 代码生成          | LLM 自动生成                    | Agent 提供 handler 体           |
 * | 编译验证          | tsc 编译验证                    | 无（沙箱执行，无编译期）         |
 * | 安全机制          | 生成后 tsc 验证                 | 沙箱 + 权限检查                 |
 * | 生命周期          | 持久（重启后需重新注册）           | 对话级（自动清理）              |
 * | 提供者前缀        | @dynamic/                      | @session/                      |
 *
 * ## 典型使用场景
 *
 * 1. Agent 发现需要调用一个 API 但没有对应的 MCP 工具
 * 2. Agent 通过 register_tool 注册临时工具，提供 handler 代码
 * 3. 使用后自动清理（或通过 unregister_tool 手动清理）
 *
 * 由于这些工具本身是内置的，它们需要通过 getAllTools() 注册。
 * 注意使用动态 import 避免循环依赖。
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import type { MCPToolResult } from '../../mcp/types'

// =============================================================================
// register_tool — 注册一个动态工具
// =============================================================================

export const registerTool = buildTool({
  name: 'register_tool',
  description: '在对话中注册一个临时工具。Agent 发现现有工具无法满足需求时，可直接提供工具定义和 handler 代码进行注册。注册的工具仅在当前对话有效，对话结束后自动清理。支持分级权限控制：none(纯计算)、readonly(只读)、files(文件读写)、network(网络请求)。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '工具名（snake_case，如 format_json、query_weather）。不能与内置工具同名。',
      },
      description: {
        type: 'string',
        description: '工具功能描述。清晰说明工具的作用和使用场景。',
      },
      input_schema: {
        type: 'object',
        description: '输入参数 JSON Schema。格式：{"type":"object","properties":{"param1":{"type":"string","description":"..."}},"required":["param1"]}',
        properties: {
          type: { type: 'string' },
          properties: { type: 'object' },
          required: { type: 'array', items: { type: 'string' } },
        },
        required: ['type', 'properties'],
      },
      handler_body: {
        type: 'string',
        description: '纯 JavaScript async 函数体。参数通过 args 对象传入（如 args.param1），必须返回 MCPToolResult 格式：{content:[{type:"text",text:"结果"}]} 或调用 formatResult()/formatError()。可使用: JSON, Math, Date, String, Array, console, setTimeout, fetch（仅 network 级别），await import() 加载 Node.js 内置模块。不可使用: require, process, __dirname, child_process, eval, new Function。示例：const data = args.input; return { content: [{ type: "text", text: JSON.stringify(data) }], isError: false }',
      },
      permission: {
        type: 'string',
        enum: ['none', 'readonly', 'files', 'network'],
        description: '权限级别：none(纯计算)、readonly(只读，默认)、files(文件读写)、network(网络请求+fetch)。选择够用的最低级别以提高安全性。',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '可选标签列表，用于分类和查询。如 ["temp", "api", "format"]',
      },
    },
    required: ['name', 'description', 'input_schema', 'handler_body'],
  },
  handler: async (args: {
    name: string
    description: string
    input_schema: {
      type: 'object'
      properties: Record<string, { type: string; description: string }>
      required: string[]
    }
    handler_body: string
    permission?: string
    tags?: string[]
  }) => {
    try {
      // 动态导入避免循环依赖
      const [
        { dynamicToolLifecycle },
        { dynamicToolPermission, parsePermissionLevel, PermissionLevel },
        { checkHandlerSafety },
      ] = await Promise.all([
        import('../dynamic/DynamicToolLifecycle'),
        import('../dynamic/DynamicToolPermission'),
        import('../dynamic/DynamicToolSandbox'),
      ])

      const toolName = args.name.trim()

      // 校验工具名格式
      if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
        return formatToolError('工具名必须是小写字母开头的 snake_case（如 format_json、query_weather）')
      }

      if (toolName.length > 64) {
        return formatToolError('工具名最多 64 个字符')
      }

      // 校验描述
      if (args.description.length < 5) {
        return formatToolError('工具描述至少 5 个字符')
      }

      // 校验 input_schema
      const schema = args.input_schema
      if (!schema.properties || typeof schema.properties !== 'object') {
        return formatToolError('input_schema 缺少 properties 字段')
      }

      // 解析权限级别
      const permissionLevel = parsePermissionLevel(args.permission || 'readonly')

      // 权限检查
      const config = { level: permissionLevel }
      // 使用固定会话 ID（当前对话的标识）
      const sessionId = `session_${Date.now()}`
      const permCheck = dynamicToolPermission.checkRegistration(config, sessionId)
      if (!permCheck.allowed) {
        return formatToolError(`权限检查未通过：${permCheck.reason}`)
      }

      // handler 代码安全检查
      const violations = checkHandlerSafety(args.handler_body, {
        allowNetwork: permissionLevel >= PermissionLevel.NETWORK,
        allowFileSystem: permissionLevel >= PermissionLevel.FILES,
      })
      if (violations.length > 0) {
        const details = violations.map((v) => v.description).join(', ')
        return formatToolError(`代码安全检查未通过：检测到危险 API (${details})。如需使用这些 API，请调整 permission 级别或提供安全实现。`)
      }

      // API 使用权限检查
      const apiCheck = dynamicToolPermission.checkHandlerApis(args.handler_body, config)
      if (!apiCheck.allowed) {
        return formatToolError(`API 权限检查未通过：${apiCheck.reason}`)
      }

      // 构建 handler
      const handlerCode = args.handler_body
      const handler = async (callArgs: Record<string, any>): Promise<MCPToolResult> => {
        try {
          // 使用沙箱执行 handler
          const { executeInSandbox } = await import('../dynamic/DynamicToolSandbox')
          const result = await executeInSandbox(
            handlerCode,
            { args: callArgs },
            {
              timeoutMs: 30_000,
              allowNetwork: permissionLevel >= PermissionLevel.NETWORK,
              allowFileSystem: permissionLevel >= PermissionLevel.FILES,
            },
          )

          if (!result.success) {
            return formatToolError(`执行失败: ${result.error}`)
          }

          // 如果 handler 返回了 MCPToolResult 格式，直接使用
          try {
            if (result.value) {
              const parsed = JSON.parse(result.value)
              if (parsed && typeof parsed === 'object' && 'content' in parsed && 'isError' in parsed) {
                return parsed as MCPToolResult
              }
            }
          } catch {
            // 不是 JSON，当做普通文本
          }

          return formatToolResult(result.value || '')
        } catch (err: any) {
          return formatToolError(`工具 "${toolName}" 执行异常: ${err.message}`)
        }
      }

      // 注册到生命周期管理器（使用动态 sessionId）
      dynamicToolLifecycle.registerTool(
        sessionId,
        toolName,
        args.description,
        {
          type: 'object',
          properties: schema.properties,
          required: schema.required || [],
        },
        handler,
        args.tags || [],
      )

      // 构建返回信息
      const schemaProps = Object.entries(schema.properties)
        .map(([key, val]) => {
          const required = (schema.required || []).includes(key) ? ' (必填)' : ''
          return `  - ${key} (${val.type}): ${val.description}${required}`
        })
        .join('\n')

      const lines = [
        `✅ 动态工具 "${toolName}" 注册成功！`,
        ``,
        `📋 描述：${args.description}`,
        `🔒 权限级别：${args.permission || 'readonly'}`,
        `🆔 会话 ID：${sessionId}`,
        ``,
        `📝 输入参数：`,
        schemaProps || '  (无参数)',
        ``,
        `💡 提示：此工具在当前对话中可用，对话结束后自动清理。`,
        `   如需提前注销，可调用 unregister_tool(name="${toolName}")。`,
      ]

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`工具注册失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// unregister_tool — 注销一个动态工具
// =============================================================================

export const unregisterTool = buildTool({
  name: 'unregister_tool',
  description: '注销之前通过 register_tool 注册的动态工具。注销后工具立即可用。如果需要在注册后更改实现，请先注销再重新注册。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '要注销的工具名（必须是之前通过 register_tool 注册的动态工具）',
      },
    },
    required: ['name'],
  },
  handler: async (args: { name: string }) => {
    try {
      const { dynamicToolLifecycle } = await import('../dynamic/DynamicToolLifecycle')

      const toolName = args.name.trim()

      // 检查是否为动态工具
      if (!dynamicToolLifecycle.isDynamicTool(toolName)) {
        return formatToolError(`"${toolName}" 不是动态注册的工具，或已被注销。使用 list_registered_tools 查看可用的动态工具。`)
      }

      // 使用 removeToolByName 强制注销（不检查会话归属）
      const removed = dynamicToolLifecycle.removeToolByName(toolName)

      if (!removed) {
        return formatToolError(`注销失败：工具 "${toolName}" 不存在或提供者不可用。使用 list_registered_tools 查看当前动态工具。`)
      }

      return formatToolResult(`✅ 动态工具 "${toolName}" 已成功注销，不再可用。`)
    } catch (err: any) {
      return formatToolError(`注销失败: ${err.message}`)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// list_registered_tools — 列出所有注册的动态工具
// =============================================================================

export const listRegisteredTools = buildTool({
  name: 'list_registered_tools',
  description: '列出当前对话中所有通过 register_tool 注册的动态工具及其状态。不包含内置工具或其他 MCP 服务器提供的工具。',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const { dynamicToolLifecycle } = await import('../dynamic/DynamicToolLifecycle')

      const tools = dynamicToolLifecycle.getAllTools()

      if (tools.length === 0) {
        return formatToolResult('暂无动态注册的工具。如需创建临时工具，可调用 register_tool 提供定义和 handler。')
      }

      const lines = [
        `📦 已注册 ${tools.length} 个动态工具：`,
        ``,
      ]

      for (const t of tools) {
        const age = Math.round((Date.now() - t.registeredAt) / 1000)
        const ageStr = age < 60 ? `${age}s` : `${Math.floor(age / 60)}m${age % 60}s`
        lines.push(`  🔧 ${t.name}`)
        lines.push(`     描述：${t.description}`)
        lines.push(`     存活时间：${ageStr}`)
        lines.push(`     标签：${t.tags.length > 0 ? t.tags.join(', ') : '无'}`)
        lines.push(``)
      }

      lines.push('💡 使用 unregister_tool(name="tool_name") 可手动注销不再需要的工具。')

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`列出动态工具失败: ${err.message}`)
    }
  },
  isReadOnly: true,
})
