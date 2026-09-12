/**
 * AgentWallpaperBridge — Agent → Wallpaper 增量迁移桥梁
 *
 * 将 AgentPluginRegistry 与 WallpaperPluginRegistry 连接起来，
 * 支持 Agent 子模块逐步迁移为 Wallpaper 插件。
 *
 * ── 设计目标 ──
 * 1. 零中断迁移：已替换的模块走 Wallpaper，未替换的走原有路径
 * 2. 接口兼容：迁移期间新旧接口并存，不破坏现有调用方
 * 3. 观测优先：每个迁移决策都有日志可追踪
 *
 * ── 工作原理 ──
 * 1. AgentWallpaperBridge 在 AppRuntime 启动时初始化
 * 2. 扫描 AGENT_SUB_MODULE_MAPPINGS 的 priorityReplacementQueue
 * 3. 对每个标记为 wallpaper-capable 的子模块，
 *    尝试通过 WallpaperPluginRegistry 获取对应能力
 * 4. 有 Wallpaper 实现 → 使用 Wallpaper 路径（已替换）
 * 5. 无 Wallpaper 实现 → 使用原有 Agent 路径（未替换）
 *
 * ── 使用示例 ──
 * ```ts
 * const bridge = AgentWallpaperBridge.getInstance()
 * bridge.initialize()
 *
 * // 获取内容分类（优先 Wallpaper 路径）
 * const category = bridge.classifyContent(userText)
 * // 如果已替换 → 委托 WallpaperPluginRegistry
 * // 如果未替换 → 直接调用 Agent 原有实现
 * ```
 *
 * @see AGENT_SUB_MODULE_MAPPINGS — 完整子模块映射与优先级
 * @see WallpaperPluginRegistry — Wallpaper 侧插件注册表
 * @see AgentPluginRegistry — Agent 侧插件注册表
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { WallpaperPluginRegistry } from '@akemi-mio/platform/wallpaper/plugin/WallpaperPluginRegistry'
import { AgentPluginRegistry, agentPluginRegistry } from '../plugin/AgentPluginRegistry'
import { AGENT_SUB_MODULE_MAPPINGS, getPriorityReplacementQueue, getByName, type AgentSubModuleMapping } from '../wallpaper-mapping'

// ════════════════════════════════════════════════════════════
//  替换状态
// ════════════════════════════════════════════════════════════

/** 子模块替换状态 */
export interface ReplacementStatus {
  /** 子模块名称 */
  moduleName: string
  /** 是否已被 Wallpaper 插件替换 */
  replaced: boolean
  /** 替换时间（未替换则为 undefined） */
  replacedAt?: number
  /** 回退原因（如替换失败） */
  fallbackReason?: string
  /** Wallpaper 插件实例名（如已替换） */
  wallpaperPluginName?: string
}

// ════════════════════════════════════════════════════════════
//  替换锚点枚举 — 控制是否走 Wallpaper 路径
// ════════════════════════════════════════════════════════════

/**
 * 子模块替换锚点。
 * 每个已迁移到 Wallpaper 的子模块对应一个锚点。
 * Agent 服务代码通过检查这些锚点来决定走哪条路径。
 */
export const wallpaperReplacements = {
  /** ContentClassifier 是否已被 Wallpaper 替换 */
  contentClassifier: false,
  /** SleepCycle 是否已被 Wallpaper 替换 */
  sleepMaintenance: false,
  /** ErrorClassifier 是否已被 Wallpaper 替换 */
  errorClassifier: false,
  /** CheckpointScheduler 是否已被 Wallpaper 替换 */
  checkpointScheduler: false,
} as const

// ════════════════════════════════════════════════════════════
//  AgentWallpaperBridge
// ════════════════════════════════════════════════════════════

export class AgentWallpaperBridge {
  private static instance: AgentWallpaperBridge

  /** 各个子模块的替换状态 */
  private statuses: Map<string, ReplacementStatus> = new Map()

  /** Wallpaper 插件注册表引用 */
  private wallpaperRegistry: WallpaperPluginRegistry | null = null

  /** Agent 插件注册表引用 */
  private agentRegistry: AgentPluginRegistry

  /** 是否已初始化 */
  private _initialized = false

  private constructor() {
    this.agentRegistry = agentPluginRegistry
  }

  static getInstance(): AgentWallpaperBridge {
    if (!AgentWallpaperBridge.instance) {
      AgentWallpaperBridge.instance = new AgentWallpaperBridge()
    }
    return AgentWallpaperBridge.instance
  }

  // ════════════════════════════════════════════════════════════
  //  初始化
  // ════════════════════════════════════════════════════════════

  /**
   * 初始化桥梁。
   * 在 AppRuntime 启动时、WallpaperPluginRegistry 就绪后调用。
   *
   * @param wallpaperRegistry 可选注入，默认使用 WallpaperPluginRegistry.getInstance()
   */
  initialize(wallpaperRegistry?: WallpaperPluginRegistry): void {
    if (this._initialized) return
    this._initialized = true

    this.wallpaperRegistry = wallpaperRegistry ?? WallpaperPluginRegistry.getInstance()
    this.scanAndReport()

    log('INFO', 'wallpaper_bridge_initialized', {
      wallpaperPlugins: this.wallpaperRegistry.getStats().total,
      agentPlugins: this.agentRegistry.getStats().total,
      replacements: this.getReplacementCount(),
    })
  }

  /** 扫描当前替换状态并报告 */
  private scanAndReport(): void {
    if (!this.wallpaperRegistry) return

    const priorityQueue = getPriorityReplacementQueue()
    for (const mapping of priorityQueue) {
      const wallpaperPlugin = this.findWallpaperPlugin(mapping)
      this.statuses.set(mapping.name, {
        moduleName: mapping.name,
        replaced: !!wallpaperPlugin,
        replacedAt: wallpaperPlugin ? Date.now() : undefined,
        wallpaperPluginName: wallpaperPlugin ? wallpaperPlugin.manifest.name : undefined,
      })

      if (wallpaperPlugin) {
        log('INFO', 'wallpaper_bridge_replaced', {
          module: mapping.name,
          pluginName: wallpaperPlugin.manifest.name,
          wallpaperCapability: mapping.wallpaperCapability,
        })
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  //  查询方法
  // ════════════════════════════════════════════════════════════

  /** 获取指定子模块的替换状态 */
  getStatus(moduleName: string): ReplacementStatus | undefined {
    return this.statuses.get(moduleName)
  }

  /** 获取所有子模块的替换状态 */
  getAllStatuses(): ReplacementStatus[] {
    return Array.from(this.statuses.values())
  }

  /** 获取当前已替换的子模块数量 */
  getReplacementCount(): number {
    let count = 0
    for (const status of this.statuses.values()) {
      if (status.replaced) count++
    }
    return count
  }

  /** 检查指定子模块是否已被 Wallpaper 替换 */
  isReplaced(moduleName: string): boolean {
    const status = this.statuses.get(moduleName)
    return status?.replaced ?? false
  }

  /** 检查指定子模块是否有可用的 Wallpaper 插件实现 */
  hasWallpaperPlugin(mapping: AgentSubModuleMapping): boolean {
    if (!this.wallpaperRegistry || !mapping.wallpaperCapability) return false
    const plugins = this.wallpaperRegistry.getByCapability(mapping.wallpaperCapability as any)
    return plugins.length > 0
  }

  /**
   * 优先替换队列 — 当前阶段推荐替换的子模块列表。
   * 基于 mapping 中 priority <= 2 的模块。
   */
  getNextReplacementCandidates(): AgentSubModuleMapping[] {
    return AGENT_SUB_MODULE_MAPPINGS.filter((m) => m.priority <= 2 && m.wallpaperSuitability !== 'not_suitable')
      .filter((m) => !this.isReplaced(m.name))
      .sort((a, b) => a.priority - b.priority)
  }

  // ════════════════════════════════════════════════════════════
  //  内部辅助
  // ════════════════════════════════════════════════════════════

  /**
   * 在 WallpaperPluginRegistry 中查找匹配的插件。
   * 通过 mapping.wallpaperCapability 遍历 Wallpaper 插件的能力列表。
   */
  private findWallpaperPlugin(mapping: AgentSubModuleMapping) {
    if (!this.wallpaperRegistry || !mapping.wallpaperCapability) return null
    const plugins = this.wallpaperRegistry.getByCapability(mapping.wallpaperCapability as any)
    return plugins.length > 0 ? plugins[0] : null
  }
}

// =============================================================================
// 单例
// =============================================================================

/** 全局单例 */
export const agentWallpaperBridge = AgentWallpaperBridge.getInstance()
