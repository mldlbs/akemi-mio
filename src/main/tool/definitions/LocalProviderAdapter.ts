import { toolProviderRegistry } from '../registry'
import { getAllTools } from '../getAllTools'
import type { MCPToolDefinition, MCPToolResult } from '../../mcp/types'
import { adaptToToolProvider } from '../IToolProvider'
import { log } from '../../logger/Logger'

/**
 * 保持向后兼容的适配器 — 将新 Tool 系统转换为 LocalProvider 的旧接口。
 * ServerManager 无需修改即可继续使用。
 *
 * 支持运行时工具处理器热替换（hot-reload）：
 * - setToolHandlerOverride() 可在不重启进程的情况下替换单个工具的处理逻辑
 * - clearToolOverrides() 恢复所有工具到原始实现
 * - 用于 Evolution 自动优化后的实时生效
 *
 * ## Memory 模式迁移：ToolProviderRegistry
 *
 * 原先通过 getAllTools() 静态数组获取工具定义，缺少动态注册能力。
 * 现在集成 ToolProviderRegistry（对应 Memory UnifiedMemoryQuery）：
 * - 构造时自动注册内置工具集
 * - 支持运行时通过 registerToolProvider() 注册新的工具提供者
 * - 支持运行时通过 unregisterToolProvider() 注销
 * - 生命周期 hooks（onRegister/onUnregister/dispose）
 */
export class LocalProviderAdapter {
  readonly name = '@builtin/core'

  /** 运行时工具处理器覆盖表 */
  private toolHandlerOverrides = new Map<string, (args: Record<string, any>) => Promise<MCPToolResult>>()

  /** 是否已完成内置工具注册 */
  private builtinRegistered = false

  constructor() {
    // 延迟注册内置工具，避免构造时的循环依赖
    // 内置工具在首次 getToolDefinitions() 时自动注册
  }

  /**
   * 确保内置工具已注册到 ToolProviderRegistry。
   * 使用 adaptToToolProvider 适配器（对应 Memory 的 adaptToPlugin 模式）。
   */
  private ensureBuiltinRegistered(): void {
    if (this.builtinRegistered) return
    this.builtinRegistered = true

    const tools = getAllTools()
    if (tools.length === 0) return

    // 注册内置工具集
    const builtinProvider = adaptToToolProvider('@builtin/core', '内建核心工具集（文件操作、命令执行、计划管理等）', tools)

    toolProviderRegistry.register(builtinProvider)
    log('INFO', 'local_provider_builtin_registered', {
      toolCount: tools.length,
    })
  }

  getToolDefinitions(): MCPToolDefinition[] {
    this.ensureBuiltinRegistered()
    return toolProviderRegistry.getTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputJSONSchema.properties,
      required: t.inputJSONSchema.required,
      serverName: t.serverName ?? '@builtin/core',
    }))
  }

  async callTool(name: string, args: Record<string, any>): Promise<MCPToolResult> {
    // 优先检查运行时覆盖
    const override = this.toolHandlerOverrides.get(name)
    if (override) {
      return override(args)
    }

    this.ensureBuiltinRegistered()
    const tool = toolProviderRegistry.getTool(name)
    if (!tool) throw new Error(`未知工具: ${name}`)
    return tool.handler(args)
  }

  /**
   * 注册一个新的工具提供者插件。
   * 调用后，该提供者的所有工具立即可用。
   *
   * 对应 Memory 的 UnifiedMemoryQuery.registerPlugin()。
   */
  registerToolProvider(
    name: string,
    description: string,
    tools: Array<{ name: string; handler: (args: any) => Promise<MCPToolResult>; description: string; inputJSONSchema: any }>,
    hooks?: {
      onRegister?: () => void | Promise<void>
      onUnregister?: () => void | Promise<void>
      dispose?: () => void | Promise<void>
    },
  ): void {
    const fullTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputJSONSchema: t.inputJSONSchema as any,
      handler: t.handler,
      serverName: '@builtin/core',
      isReadOnly: false,
      isEnabled: true,
    }))

    const provider = adaptToToolProvider(name, description, fullTools, hooks)
    toolProviderRegistry.register(provider)
  }

  /**
   * 注销一个工具提供者插件。
   * 调用后，该提供者的所有工具不再可用。
   *
   * 对应 Memory 的 UnifiedMemoryQuery.unregisterPlugin()。
   */
  unregisterToolProvider(name: string): boolean {
    return toolProviderRegistry.unregister(name)
  }

  /**
   * 获取所有已注册的工具提供者信息。
   */
  getRegisteredProviders(): Array<{ name: string; description: string; toolCount: number }> {
    return toolProviderRegistry.getAllProviders().map((p) => ({
      name: p.name,
      description: p.description,
      toolCount: p.getTools().length,
    }))
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
