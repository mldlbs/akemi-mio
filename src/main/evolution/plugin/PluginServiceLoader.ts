/**
 * PluginServiceLoader — Evolution 插件运行时加载器（ServiceLoader 模式）
 *
 * 职责：
 *   1. 维护 EvolutionPlugin 注册表
 *   2. 提供按能力（capability）发现插件的查询接口
 *   3. 管理插件的生命周期（onLoad / onUnload）
 *
 * 使用方式：
 *   const loader = PluginServiceLoader.getInstance()
 *   loader.register(new WallpaperPlugin(projectRoot))
 *   await loader.loadAll()
 *   const collectors = loader.getByCapability('collect')
 *
 * 设计意图：
 *   - 单例，全局唯一
 *   - 插件注册后由 loader 统一管理，Evolution 系统不直接持有插件引用
 *   - PipelineOrchestrator 通过 PluginCollectorAdapter/PluginExecutorAdapter 消费插件
 */

import { log } from '../../logger/Logger'
import type { EvolutionPlugin, EvolutionCapability } from './types'

export class PluginServiceLoader {
  private static instance: PluginServiceLoader

  /** 已注册的插件（name → plugin） */
  private plugins = new Map<string, EvolutionPlugin>()

  /** 是否已执行过 loadAll（防止重复调用） */
  private loaded = false

  private constructor() {
    // 单例，不允许外部 new
  }

  static getInstance(): PluginServiceLoader {
    if (!PluginServiceLoader.instance) {
      PluginServiceLoader.instance = new PluginServiceLoader()
    }
    return PluginServiceLoader.instance
  }

  // ==================== 注册与发现 ====================

  /**
   * 注册一个 Evolution 插件。
   * 同名插件只能注册一次，重复注册会打印警告并跳过。
   */
  register(plugin: EvolutionPlugin): void {
    const name = plugin.manifest.name
    if (this.plugins.has(name)) {
      log('WARN', 'plugin_already_registered', { name })
      return
    }
    this.plugins.set(name, plugin)
    log('INFO', 'evolution_plugin_registered', {
      name,
      version: plugin.manifest.version,
      capabilities: plugin.manifest.capabilities,
    })
  }

  /**
   * 检查指定插件是否已注册。
   */
  hasPlugin(name: string): boolean {
    return this.plugins.has(name)
  }

  /**
   * 获取指定名称的插件。
   */
  getPlugin(name: string): EvolutionPlugin | undefined {
    return this.plugins.get(name)
  }

  /**
   * 获取具有指定能力的所有插件。
   * 例如 getByCapability('collect') 返回所有支持采集的插件。
   */
  getByCapability(capability: EvolutionCapability): EvolutionPlugin[] {
    return Array.from(this.plugins.values()).filter((p) =>
      p.manifest.capabilities.includes(capability),
    )
  }

  /**
   * 获取所有已注册的插件。
   */
  getAll(): EvolutionPlugin[] {
    return Array.from(this.plugins.values())
  }

  // ==================== 生命周期 ====================

  /**
   * 初始化所有已注册的插件。
   * 遍历调用每个插件的 onLoad() 钩子。
   * 单个插件 onLoad 失败不影响其他插件。
   */
  async loadAll(): Promise<void> {
    if (this.loaded) {
      log('WARN', 'evolution_plugins_already_loaded')
      return
    }

    let successCount = 0
    let failCount = 0

    for (const [name, plugin] of this.plugins) {
      if (typeof plugin.onLoad === 'function') {
        try {
          await plugin.onLoad()
          successCount++
        } catch (err) {
          failCount++
          log('WARN', 'plugin_onload_failed', { name, error: String(err) })
        }
      } else {
        successCount++
      }
    }

    this.loaded = true
    log('INFO', 'evolution_plugins_loaded', {
      total: this.plugins.size,
      success: successCount,
      failed: failCount,
    })
  }

  /**
   * 卸载所有插件。
   * 遍历调用每个插件的 onUnload() 钩子并清空注册表。
   */
  async unloadAll(): Promise<void> {
    for (const [name, plugin] of this.plugins) {
      try {
        await plugin.onUnload?.()
      } catch (err) {
        log('WARN', 'plugin_onunload_failed', { name, error: String(err) })
      }
    }
    this.plugins.clear()
    this.loaded = false
    log('INFO', 'evolution_plugins_unloaded')
  }

  /**
   * 卸载指定插件。
   */
  async unload(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name)
    if (!plugin) return false
    try {
      await plugin.onUnload?.()
    } catch (err) {
      log('WARN', 'plugin_onunload_failed', { name, error: String(err) })
    }
    this.plugins.delete(name)
    log('INFO', 'evolution_plugin_unloaded', { name })
    return true
  }
}
