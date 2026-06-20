import { getAllTools, toMCPToolDefinition } from '../index'
import type { MCPToolDefinition, MCPToolResult } from '../../mcp/types'

/**
 * 保持向后兼容的适配器 — 将新 Tool 系统转换为 LocalProvider 的旧接口。
 * ServerManager 无需修改即可继续使用。
 */
export class LocalProviderAdapter {
  readonly name = '@builtin/core'

  getToolDefinitions(): MCPToolDefinition[] {
    return getAllTools().map(toMCPToolDefinition)
  }

  async callTool(name: string, args: Record<string, any>): Promise<MCPToolResult> {
    const tools = getAllTools()
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`未知工具: ${name}`)
    return tool.handler(args)
  }
}
