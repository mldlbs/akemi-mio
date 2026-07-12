/**
 * ToolProviderRegistry — 工具提供者注册表
 *
 * 集中管理所有 IToolProvider 插件的注册、注销和生命周期。
 * 与 Memory 系统的 UnifiedMemoryQuery 模式一致：
 *
 * | UnifiedMemoryQuery            | ToolProviderRegistry        | 说明                     |
 * |-------------------------------|-----------------------------|-------------------------|
 * | registerPlugin(plugin)        | register(provider)          | 注册插件                 |
 * | unregisterPlugin(name)        | unregister(name)            | 注销插件                 |
 * | getPluginNames()              | getProviderNames()          | 列出所有插件              |
 * | getAllPlugins()               | getAllProviders()           | 获取所有插件实例          |
 * | getPlugin(name)               | getProvider(name)           | 按名获取插件              |
 * | query()                       | getTools() / getTool(name)  | 统一查询接口              |
 *
 * ## 解决的问题
 * 工具注册目前通过 getAllTools() 静态数组完成，缺少：
 * 1. 动态注册/注销能力（运行时添加/移除工具集合）
 * 2. 生命周期管理（注册前初始化、注销前清理）
 * 3. 提供者粒度的启用/禁用
 * 4. 提供者元数据（描述、版本等）
 *
 * 与 Memory IMemoryPlugin 模式迁移一致：
 * - UnifiedMemoryQuery.registerPlugin() → ToolProviderRegistry.register()
 * - UnifiedMemoryQuery.unregisterPlugin() → ToolProviderRegistry.unregister()
 * - 新增 onRegister/onUnregister 生命周期 hooks
 */

import { log } from '../logger/Logger'
import type { IToolProvider } from './IToolProvider'
import type { Tool } from './types'

export class ToolProviderRegistry {
  /** 已注册的提供者（名 → 实例） */
  private providers = new Map<string, IToolProvider>()

  /** 提供者工具名 → 提供者名 的逆向索引（快速查找工具归属） */
  private toolToProvider = new Map<string, string>()

  /**
   * 注册一个工具提供者插件。
   *
   * 流程：
   * 1. 检查同名提供者是否已注册（防止重复）
   * 2. 调用 onRegister 生命周期 hook
   * 3. 获取工具列表并建立逆向索引
   * 4. 记录日志
   *
   * @throws 如果同名提供者已注册
   */
  register(provider: IToolProvider): void {
    const name = provider.name

    if (this.providers.has(name)) {
      log('WARN', 'tool_provider_already_registered', { provider: name })
      return // 幂等：重复注册不抛错
    }

    // 1. 生命周期：注册前回调
    if (provider.onRegister) {
      try {
        const result = provider.onRegister()
        if (result instanceof Promise) {
          // 同步处理，不 await（避免阻塞注册流程）
          result.catch((err) => log('WARN', 'tool_provider_onregister_async_error', { provider: name, error: String(err) }))
        }
      } catch (err) {
        log('WARN', 'tool_provider_onregister_error', { provider: name, error: String(err) })
      }
    }

    // 2. 注册提供者
    this.providers.set(name, provider)

    // 3. 建立工具 → 提供者逆向索引
    const tools = provider.getTools()
    for (const tool of tools) {
      // 如果工具名已被其他提供者注册，记录冲突（不覆盖，先注册者优先）
      if (this.toolToProvider.has(tool.name)) {
        log('WARN', 'tool_provider_tool_conflict', {
          tool: tool.name,
          existing: this.toolToProvider.get(tool.name),
          incoming: name,
        })
        continue
      }
      this.toolToProvider.set(tool.name, name)
    }

    log('INFO', 'tool_provider_registered', {
      provider: name,
      toolCount: tools.length,
    })
  }

  /**
   * 注销一个工具提供者插件。
   *
   * @returns true 如果提供者存在并被成功注销
   */
  unregister(name: string): boolean {
    const provider = this.providers.get(name)
    if (!provider) return false

    try {
      // 1. 生命周期：注销前回调
      if (provider.onUnregister) {
        const result = provider.onUnregister()
        if (result instanceof Promise) {
          result.catch((err) => log('WARN', 'tool_provider_onunregister_async_error', { provider: name, error: String(err) }))
        }
      }
    } catch (err) {
      log('WARN', 'tool_provider_onunregister_error', { provider: name, error: String(err) })
    }

    // 2. 清理逆向索引
    const tools = provider.getTools()
    for (const tool of tools) {
      this.toolToProvider.delete(tool.name)
    }

    // 3. 移除提供者
    this.providers.delete(name)

    log('INFO', 'tool_provider_unregistered', {
      provider: name,
      toolCount: tools.length,
    })

    return true
  }

  /**
   * 获取所有已注册提供者的所有工具。
   * 合并后的工具列表，按 provider 注册顺序排列。
   */
  getTools(): Tool[] {
    const tools: Tool[] = []
    for (const [, provider] of this.providers) {
      tools.push(...provider.getTools())
    }
    return tools
  }

  /**
   * 按工具名查找工具定义。
   * 遍历所有已注册提供者，返回第一个匹配的工具。
   */
  getTool(name: string): Tool | undefined {
    // 优先通过逆向索引查找
    const providerName = this.toolToProvider.get(name)
    if (providerName) {
      const provider = this.providers.get(providerName)
      if (provider) {
        return provider.getTools().find((t) => t.name === name)
      }
    }

    // 兜底：线性查找
    for (const [, provider] of this.providers) {
      const tool = provider.getTools().find((t) => t.name === name)
      if (tool) return tool
    }

    return undefined
  }

  /**
   * 获取指定工具的提供者名。
   */
  getProviderForTool(toolName: string): string | undefined {
    return this.toolToProvider.get(toolName)
  }

  /**
   * 获取所有已注册的提供者名列表。
   */
  getProviderNames(): string[] {
    return Array.from(this.providers.keys())
  }

  /**
   * 获取指定名称的提供者实例。
   */
  getProvider(name: string): IToolProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * 获取所有已注册的提供者实例。
   */
  getAllProviders(): IToolProvider[] {
    return Array.from(this.providers.values())
  }

  /**
   * 检查指定提供者是否已注册。
   */
  hasProvider(name: string): boolean {
    return this.providers.has(name)
  }

  /**
   * 获取已注册的提供者数量。
   */
  getProviderCount(): number {
    return this.providers.size
  }

  /**
   * 获取已注册的工具总数。
   */
  getToolCount(): number {
    let count = 0
    for (const [, provider] of this.providers) {
      count += provider.getTools().length
    }
    return count
  }

  /**
   * 清理所有已注册的提供者。
   * 依次调用每个提供者的 onUnregister 和 dispose，然后清空注册表。
   */
  async clear(): Promise<void> {
    const names = Array.from(this.providers.keys())

    for (const name of names) {
      const provider = this.providers.get(name)
      if (!provider) continue

      try {
        // 先注销
        if (provider.onUnregister) {
          await Promise.resolve(provider.onUnregister())
        }
        // 再清理
        if (provider.dispose) {
          await Promise.resolve(provider.dispose())
        }
      } catch (err) {
        log('WARN', 'tool_provider_clear_error', { provider: name, error: String(err) })
      }
    }

    this.providers.clear()
    this.toolToProvider.clear()

    log('INFO', 'tool_provider_registry_cleared', { cleared: names.length })
  }
}
