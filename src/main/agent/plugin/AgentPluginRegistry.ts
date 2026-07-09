/**
 * AgentPluginRegistry — Agent 插件运行时加载器（ServiceLoader 模式）
 *
 * 模式来源：
 * - src/main/speech/SpeechPluginRegistry.ts — ASR/TTS 插件的 ServiceLoader 模式
 * - 迁移到 Agent 领域，适配 Agent 的认知管线（OTPAR）和运行时特性
 *
 * 职责：
 *   1. 维护 AgentPlugin 注册表
 *   2. 提供按能力（capability）发现插件的查询接口
 *   3. 管理插件的生命周期（initialize / onUnload）
 *
 * 设计意图：
 *   - 单例，全局唯一
 *   - 插件注册后由 registry 统一管理，AgentService 不直接持有插件引用
 *   - 新增认知阶段只需注册对应插件，无需修改核心服务
 *
 * 使用方式：
 *   const registry = AgentPluginRegistry.getInstance()
 *   registry.register(new ObserveStagePlugin())
 *   registry.register(new ThinkStagePlugin())
 *   await registry.loadAll()
 *   const stages = registry.getPluginsByCapability('cognitive_stage')
 *   // 按优先级排序使用
 *
 * 对照 SpeechPluginRegistry：
 *   - SpeechPluginRegistry: registerAsr(plugin) / registerTts(plugin)
 *   - AgentPluginRegistry: register(plugin) — 插件通过 manifest.capability 区分
 *   - SpeechPluginRegistry: getAsrPlugins() / getTtsPlugins()
 *   - AgentPluginRegistry: getPluginsByCapability(capability)
 */

import { log } from '../../logger/Logger'
import type {
  AgentPlugin,
  AgentPluginManifest,
  AgentCapability,
  AgentPluginStatus,
} from './types'

export class AgentPluginRegistry {
  private static instance: AgentPluginRegistry

  /** 已注册的插件（manifest.name → AgentPlugin） */
  private plugins = new Map<string, AgentPlugin>()

  /** 是否已执行 loadAll */
  private loaded = false

  private constructor() {
    // 单例，不允许外部 new
  }

  static getInstance(): AgentPluginRegistry {
    if (!AgentPluginRegistry.instance) {
      AgentPluginRegistry.instance = new AgentPluginRegistry()
    }
    return AgentPluginRegistry.instance
  }

  // ==================== 注册 ====================

  /**
   * 注册一个 Agent 插件。
   * 同名插件只能注册一次，重复注册会打印警告并跳过。
   *
   * @param plugin 要注册的插件实例
   */
  register(plugin: AgentPlugin): void {
    const name = plugin.manifest.name
    if (this.plugins.has(name)) {
      log('WARN', 'agent_plugin_already_registered', { name })
      return
    }

    // 检查依赖（软检查：打印警告但不阻塞）
    const deps = plugin.manifest.dependencies
    if (deps && deps.length > 0) {
      const missing = deps.filter((dep) => !this.plugins.has(dep))
      if (missing.length > 0) {
        log('WARN', 'agent_plugin_missing_dependencies', {
          plugin: name,
          missing,
        })
      }
    }

    this.plugins.set(name, plugin)
    log('INFO', 'agent_plugin_registered', {
      name,
      version: plugin.manifest.version,
      capability: plugin.manifest.capability,
      priority: plugin.manifest.priority ?? 0,
    })
  }

  /**
   * 注销一个插件。
   *
   * @param name 插件名
   * @returns true 表示成功移除
   */
  unregister(name: string): boolean {
    const plugin = this.plugins.get(name)
    if (!plugin) return false

    try {
      plugin.onUnload?.()
    } catch (err) {
      log('WARN', 'agent_plugin_unload_failed', { name, error: String(err) })
    }

    this.plugins.delete(name)
    log('INFO', 'agent_plugin_unregistered', { name })
    return true
  }

  // ==================== 发现 ====================

  /**
   * 获取所有已注册的插件，按优先级降序排列。
   */
  getAllPlugins(): AgentPlugin[] {
    return Array.from(this.plugins.values()).sort(
      (a, b) => (b.manifest.priority ?? 0) - (a.manifest.priority ?? 0),
    )
  }

  /**
   * 获取指定名称的插件。
   */
  getPlugin(name: string): AgentPlugin | undefined {
    return this.plugins.get(name)
  }

  /**
   * 获取指定能力类型的所有插件，按优先级降序排列。
   *
   * @param capability 能力类型
   * @returns 匹配的插件列表
   */
  getPluginsByCapability(capability: AgentCapability): AgentPlugin[] {
    return this.getAllPlugins().filter(
      (p) => p.manifest.capability === capability,
    )
  }

  /**
   * 获取指定能力类型的第一个已初始化插件。
   *
   * @param capability 能力类型
   * @returns 匹配的插件，或 undefined
   */
  getFirstPlugin(capability: AgentCapability): AgentPlugin | undefined {
    return this.getPluginsByCapability(capability)[0]
  }

  /**
   * 检查指定名称的插件是否已注册。
   */
  hasPlugin(name: string): boolean {
    return this.plugins.has(name)
  }

  /**
   * 检查指定能力类型是否有已注册的插件。
   */
  hasCapability(capability: AgentCapability): boolean {
    return this.getPluginsByCapability(capability).length > 0
  }

  /**
   * 获取指定插件状态。
   */
  getPluginStatus(name: string): AgentPluginStatus | null {
    const plugin = this.plugins.get(name)
    if (!plugin) return null
    return {
      registered: true,
      initialized: this.loaded,
      error: null,
    }
  }

  /**
   * 获取按能力分类的插件统计信息。
   */
  getStats(): {
    total: number
    byCapability: Record<string, number>
    plugins: AgentPluginManifest[]
  } {
    const byCapability: Record<string, number> = {}
    for (const plugin of this.plugins.values()) {
      const cap = plugin.manifest.capability
      byCapability[cap] = (byCapability[cap] || 0) + 1
    }
    return {
      total: this.plugins.size,
      byCapability,
      plugins: Array.from(this.plugins.values()).map((p) => p.manifest),
    }
  }

  // ==================== 生命周期 ====================

  /**
   * 初始化所有已注册的插件。
   * 遍历调用每个插件的 initialize() 钩子。
   * 单个插件初始化失败不影响其他插件。
   *
   * 可在插件全部注册完成后调用一次。
   * 重复调用安全（已加载时跳过）。
   */
  async loadAll(configs?: Map<string, unknown>): Promise<void> {
    if (this.loaded) {
      log('WARN', 'agent_plugins_already_loaded')
      return
    }

    let success = 0
    let fail = 0

    for (const [name, plugin] of this.plugins) {
      if (typeof plugin.initialize === 'function') {
        try {
          const config = configs?.get(name)
          await plugin.initialize(config)
          success++
        } catch (err) {
          fail++
          log('WARN', 'agent_plugin_init_failed', {
            name,
            error: String(err),
          })
        }
      } else {
        success++
      }
    }

    this.loaded = true
    log('INFO', 'agent_plugins_loaded', {
      total: this.plugins.size,
      success,
      failed: fail,
    })
  }

  /**
   * 卸载所有插件。
   * 清理所有已注册插件的资源。
   */
  async unloadAll(): Promise<void> {
    for (const [name, plugin] of this.plugins) {
      try {
        await plugin.onUnload?.()
      } catch (err) {
        log('WARN', 'agent_plugin_unload_failed', {
          name,
          error: String(err),
        })
      }
    }
    this.plugins.clear()
    this.loaded = false
    log('INFO', 'agent_plugins_unloaded')
  }

  /**
   * 卸载并移除指定插件。
   *
   * @param name 插件名
   * @returns true 表示成功移除
   */
  async unloadPlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name)
    if (!plugin) return false
    try {
      await plugin.onUnload?.()
    } catch (err) {
      log('WARN', 'agent_plugin_unload_failed', {
        name,
        error: String(err),
      })
    }
    this.plugins.delete(name)
    log('INFO', 'agent_plugin_unloaded', { name })
    return true
  }
}

// =============================================================================
// 单例
// =============================================================================

/** 全局单例，供 AgentService 发现和管理 Agent 插件 */
export const agentPluginRegistry = AgentPluginRegistry.getInstance()
