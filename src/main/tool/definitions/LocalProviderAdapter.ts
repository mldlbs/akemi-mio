import { getAllTools, toMCPToolDefinition } from '../index'
import type { MCPToolDefinition, MCPToolResult } from '../../mcp/types'

/**
 * 保持向后兼容的适配器 — 将新 Tool 系统转换为 LocalProvider 的旧接口。
 * ServerManager 无需修改即可继续使用。
 *
 * 支持运行时工具处理器热替换（hot-reload）：
 * - setToolHandlerOverride() 可在不重启进程的情况下替换单个工具的处理逻辑
 * - clearToolOverrides() 恢复所有工具到原始实现
 * - 用于 Evolution 自动优化后的实时生效
 */
export class LocalProviderAdapter {
  readonly name = '@builtin/core'

  /** 运行时工具处理器覆盖表 */
  private toolHandlerOverrides = new Map<string, (args: Record<string, any>) => Promise<MCPToolResult>>()

  getToolDefinitions(): MCPToolDefinition[] {
    return getAllTools().map(toMCPToolDefinition)
  }

  async callTool(name: string, args: Record<string, any>): Promise<MCPToolResult> {
    // 优先检查运行时覆盖
    const override = this.toolHandlerOverrides.get(name)
    if (override) {
      return override(args)
    }

    const tools = getAllTools()
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`未知工具: ${name}`)
    return tool.handler(args)
  }

  /**
   * 设置指定工具的运行时处理器覆盖。
   * 调用后，该工具的所有后续调用都将使用新处理器。
   * 仅影响当前进程，不修改源文件。
   */
  setToolHandlerOverride(name: string, handler: (args: Record<string, any>) => Promise<MCPToolResult>): void {
    this.toolHandlerOverrides.set(name, handler)
  }

  /** 移除指定工具的运行时覆盖，恢复原始实现 */
  removeToolHandlerOverride(name: string): void {
    this.toolHandlerOverrides.delete(name)
  }

  /** 清除所有运行时覆盖，全部恢复原始实现 */
  clearToolOverrides(): void {
    this.toolHandlerOverrides.clear()
  }

  /** 检查是否有指定工具的运行时覆盖 */
  hasOverride(name: string): boolean {
    return this.toolHandlerOverrides.has(name)
  }

  /** 获取当前所有覆盖的工具名列表 */
  getOverriddenTools(): string[] {
    return Array.from(this.toolHandlerOverrides.keys())
  }
}
