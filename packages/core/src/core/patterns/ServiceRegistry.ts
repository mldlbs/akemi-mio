/**
 * ServiceRegistry — 通用服务/插件注册表
 *
 * 核心抽象：将服务发现与生命周期管理标准化。
 * 替代 AgentPluginRegistry 和 PluginServiceLoader 的重复实现。
 *
 * 用法：
 *   interface MyPlugin extends ServicePlugin { ... }
 *   const registry = new ServiceRegistry<MyPlugin, MyCapability>('my_registry')
 *   registry.register(myPlugin)
 *   await registry.loadAll()
 *   const collectors = registry.getByCapability('collect')
 *
 * 设计原则：
 * - 无偏见：不关心插件的具体能力，只管理注册和生命周期
 * - 领域差异通过泛型 TCapability 表达
 * - 支持初始化配置（loadAll 时可传入 per-plugin configs）
 * - 兼容 Agent（plugin.initialize）和 Evolution（plugin.onLoad）两种初始化约定
 *
 * 来源分析（AgentPluginRegistry + PluginServiceLoader）：
 * - AgentPluginRegistry — Agent 认知管线扩展的注册/发现/生命周期
 * - PluginServiceLoader — Evolution 插件系统的注册/发现/生命周期
 * - 两者在注册、能力发现、批量加载/卸载上实现完全一致
 */

import { log } from '@akemi-mio/core/logger/Logger'

// ── 基础类型 ──

/** 服务清单（插件元数据的最小公共接口） */
export interface ServiceManifest {
  /** 唯一标识名 */
  name: string
  /** 语义版本（可选） */
  version?: string
  /** 人类可读描述（可选） */
  description?: string
}

/** 具有生命周期钩子的服务插件基础接口 */
export interface ServicePlugin {
  readonly manifest: ServiceManifest
  /** 插件初始化/加载（Agent → initialize, Evolution → onLoad，两者均可） */
  initialize?(config?: unknown): Promise<void>
  /** 插件卸载清理 */
  onUnload?(): Promise<void>
}

// ── 注册表配置 ──

export interface ServiceRegistryOptions {
  /** 日志分类名前缀，默认 'service_registry' */
  loggerName?: string
  /** 重复注册时是否打印警告（默认 true） */
  warnOnDuplicate?: boolean
}

// ── 能力发现辅助类型 ──

/** 从 manifest 中提取能力字段的读取器 */
export type CapabilityReader<TPlugin, TCapability> = (plugin: TPlugin) => TCapability | TCapability[] | undefined

// ── 核心注册表 ──

export class ServiceRegistry<TPlugin extends ServicePlugin, TCapability extends string = string> {
  /** 已注册的服务（name → plugin） */
  protected readonly plugins = new Map<string, TPlugin>()
  /** 是否已执行 loadAll */
  protected loaded = false
  protected readonly loggerName: string
  private readonly warnOnDuplicate: boolean
  /** 自定义能力读取器（默认可选：manifest.capabilities 数组 或 manifest.capability 字符串） */
  private capabilityReader?: CapabilityReader<TPlugin, TCapability>

  constructor(loggerName?: string, options?: ServiceRegistryOptions)
  constructor(optionsOrName?: string | ServiceRegistryOptions, options?: ServiceRegistryOptions) {
    if (typeof optionsOrName === 'string') {
      this.loggerName = optionsOrName
      this.warnOnDuplicate = options?.warnOnDuplicate ?? true
    } else {
      this.loggerName = optionsOrName?.loggerName ?? 'service_registry'
      this.warnOnDuplicate = optionsOrName?.warnOnDuplicate ?? true
    }
  }

  /**
   * 设置自定义能力读取器。
   * 当插件的能力字段路径非标准时使用。
   */
  setCapabilityReader(reader: CapabilityReader<TPlugin, TCapability>): void {
    this.capabilityReader = reader
  }

  // ==================== 注册 ====================

  /**
   * 注册一个服务/插件。
   * 同名只能注册一次，重复注册会打印警告并跳过。
   */
  register(plugin: TPlugin): void {
    const name = plugin.manifest.name
    if (this.plugins.has(name)) {
      if (this.warnOnDuplicate) {
        log('WARN', `${this.loggerName}_already_registered`, { name })
      }
      return
    }
    this.plugins.set(name, plugin)
    log('INFO', `${this.loggerName}_registered`, { name, version: plugin.manifest.version })
  }

  /**
   * 注销一个服务/插件。
   * 如果插件已加载，会先调用 onUnload 再移除。
   * @returns true 表示成功移除
   */
  unregister(name: string): boolean {
    const plugin = this.plugins.get(name)
    if (!plugin) return false
    this.callOnUnloadSafe(name, plugin)
    this.plugins.delete(name)
    log('INFO', `${this.loggerName}_unregistered`, { name })
    return true
  }

  // ==================== 发现 ====================

  /** 获取所有已注册的服务 */
  getAll(): TPlugin[] {
    return Array.from(this.plugins.values())
  }

  /** 获取指定名称的服务 */
  getPlugin(name: string): TPlugin | undefined {
    return this.plugins.get(name)
  }

  /** 检查指定名称的服务是否已注册 */
  hasPlugin(name: string): boolean {
    return this.plugins.has(name)
  }

  /**
   * 获取具有指定能力的所有服务。
   *
   * 能力字段优先级：
   * 1. 自定义 CapabilityReader（若已设置）
   * 2. manifest.capabilities（数组，如 Evolution 插件）
   * 3. manifest.capability（单个值，如 Agent 插件）
   */
  getByCapability(capability: TCapability): TPlugin[] {
    return this.getAll().filter((p) => {
      if (this.capabilityReader) {
        const caps = this.capabilityReader(p)
        return Array.isArray(caps) ? caps.includes(capability) : caps === capability
      }
      const caps = (p.manifest as any).capabilities ?? (p.manifest as any).capability
      if (Array.isArray(caps)) return caps.includes(capability)
      return caps === capability
    })
  }

  /** 获取具有指定能力的第一个服务 */
  getFirstByCapability(capability: TCapability): TPlugin | undefined {
    return this.getByCapability(capability)[0]
  }

  /** 检查是否有注册的服务具有指定能力 */
  hasCapability(capability: TCapability): boolean {
    return this.getByCapability(capability).length > 0
  }

  // ==================== 生命周期 ====================

  /**
   * 初始化/加载所有已注册的服务。
   * 遍历调用每个服务的 initialize() 钩子（兼容 Agent 风格）。
   * 也兼容 onLoad() 钩子（Evolution 风格），若存在则调用之。
   * 单个服务初始化失败不影响其他服务。
   *
   * @param configs 可选的 per-plugin 配置（plugin name → config）
   */
  async loadAll(configs?: Map<string, unknown>): Promise<void> {
    if (this.loaded) {
      log('WARN', `${this.loggerName}_already_loaded`)
      return
    }

    let success = 0
    let fail = 0

    for (const [name, plugin] of this.plugins) {
      const initFn =
        typeof (plugin as any).initialize === 'function'
          ? (plugin as any).initialize
          : typeof (plugin as any).onLoad === 'function'
            ? (plugin as any).onLoad
            : null

      if (initFn) {
        try {
          const config = configs?.get(name)
          await initFn.call(plugin, config)
          success++
        } catch (err) {
          fail++
          log('WARN', `${this.loggerName}_init_failed`, { name, error: String(err) })
        }
      } else {
        success++
      }
    }

    this.loaded = true
    log('INFO', `${this.loggerName}_loaded`, {
      total: this.plugins.size,
      success,
      failed: fail,
    })
  }

  /**
   * 卸载所有服务。
   * 遍历调用每个服务的 onUnload() 钩子并清空注册表。
   */
  async unloadAll(): Promise<void> {
    for (const [name, plugin] of this.plugins) {
      this.callOnUnloadSafe(name, plugin)
    }
    this.plugins.clear()
    this.loaded = false
    log('INFO', `${this.loggerName}_unloaded`)
  }

  /**
   * 卸载指定服务。
   * @returns true 表示成功移除
   */
  async unload(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name)
    if (!plugin) return false
    this.callOnUnloadSafe(name, plugin)
    this.plugins.delete(name)
    log('INFO', `${this.loggerName}_unloaded_plugin`, { name })
    return true
  }

  // ==================== 统计 ====================

  /** 获取服务注册表统计信息 */
  getStats(): { total: number; byCapability?: Record<string, number> } {
    const stats: { total: number; byCapability?: Record<string, number> } = { total: this.plugins.size }
    // 尝试按能力统计
    const byCap = new Map<string, number>()
    for (const plugin of this.plugins.values()) {
      const caps = (plugin.manifest as any).capabilities ?? (plugin.manifest as any).capability
      if (Array.isArray(caps)) {
        for (const c of caps) byCap.set(c, (byCap.get(c) || 0) + 1)
      } else if (caps) {
        byCap.set(caps, (byCap.get(caps) || 0) + 1)
      }
    }
    if (byCap.size > 0) {
      stats.byCapability = Object.fromEntries(byCap)
    }
    return stats
  }

  // ==================== 内部 ====================

  private callOnUnloadSafe(name: string, plugin: TPlugin): void {
    try {
      if (typeof plugin.onUnload === 'function') {
        plugin.onUnload()
      }
    } catch (err) {
      log('WARN', `${this.loggerName}_unload_failed`, { name, error: String(err) })
    }
  }
}
