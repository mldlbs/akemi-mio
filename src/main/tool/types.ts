import { MCPToolDefinition, MCPToolResult, MCPToolSchema } from '../mcp/types'
import type { CapabilityAction } from '../capability/types'
import { applyDefaults } from '../core/patterns'

// ===== Tool 核心接口 =====

export interface Tool<I = Record<string, any>, O = MCPToolResult> {
  name: string
  description: string
  inputJSONSchema: {
    type: 'object'
    properties: Record<string, any>
    required: string[]
  }
  handler: (args: I) => Promise<O>
  /** MCP serverName 标识，默认 '@builtin/core' */
  serverName?: string
  /** 只读工具（无需写入权限检查） */
  isReadOnly?: boolean
  /** 是否启用 */
  isEnabled?: boolean
  /** Phase 4: 工具所需的能力（用于 CapabilityEngine 授权检查） */
  requiredCapability?: CapabilityAction
}

// ===== ToolDef：可选字段由 buildTool() 补全 =====

export type ToolDef<I = Record<string, any>, O = MCPToolResult> = {
  name: string
  description: string
  inputJSONSchema: Tool['inputJSONSchema']
  handler: (args: I) => Promise<O>
  serverName?: string
  isReadOnly?: boolean
  isEnabled?: boolean
}

// ===== buildTool() 工厂 =====

const TOOL_DEFAULTS = {
  serverName: '@builtin/core' as const,
  isReadOnly: false,
  isEnabled: true,
}

/**
 * 从 ToolDef 构建完整 Tool 对象。
 * 使用 core/patterns 的 applyDefaults 补全默认值。
 */
export function buildTool<I = Record<string, any>, O = MCPToolResult>(def: ToolDef<I, O>): Tool<I, O> {
  return applyDefaults(def as Tool<I, O>, TOOL_DEFAULTS)
}

// ===== 向后兼容转换 =====

export function toMCPToolDefinition(tool: Tool): MCPToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputJSONSchema.properties,
    required: tool.inputJSONSchema.required,
    serverName: tool.serverName ?? '@builtin/core',
  }
}

export function toMCPToolSchema(tool: Tool): MCPToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputJSONSchema,
  }
}

export function formatToolResult(text: string): MCPToolResult {
  return { content: [{ type: 'text', text }], isError: false }
}

export function formatToolError(text: string): MCPToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true }
}
