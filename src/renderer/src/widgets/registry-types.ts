/**
 * Registry Types — 渲染进程侧的统一抽象层接口
 *
 * 与主进程的 src/main/plugin/registry/types.ts 结构一致，
 * 提供渲染进程中 WallpaperWidget 插件系统的统一接口。
 *
 * 设计意图：
 *   主进程的 SpeechPluginRegistry 和渲染进程的 WallpaperWidgetRegistry
 *   遵循相同的注册表模式。此文件提供渲染进程侧的接口定义，
 *   使两个注册表可以通过同一套接口操作。
 *
 * 注意：渲染进程无法直接引用主进程的类型定义（不同 tsconfig 项目），
 * 因此此文件维护一份结构兼容的副本。
 */

// ════════════════════════════════════════════════════════════════
//  插件基础类型（只读接口）
// ════════════════════════════════════════════════════════════════

/** 插件基础元数据（与主进程 IPluginManifest 结构兼容） */
export interface IPluginManifest {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly author?: string
  readonly priority?: number
}

/** 插件运行状态（与主进程 IPluginStatus 结构兼容） */
export interface IPluginStatus {
  readonly ready: boolean
  readonly loading: boolean
  readonly error: string | null
}

/** 插件基础只读接口（与主进程 IPlugin 结构兼容） */
export interface IPlugin {
  readonly manifest: IPluginManifest
  getStatus(): IPluginStatus
  getInfo(): string
}

/** 注册表统计信息 */
export interface IRegistryStats {
  readonly total: number
  readonly plugins: IPluginManifest[]
}

/**
 * 插件注册表只读接口（与主进程 IPluginRegistryReadonly 结构兼容）。
 *
 * 调用方通过此接口发现和遍历插件，无需写权限。
 */
export interface IPluginRegistryReadonly<TPlugin extends IPlugin> {
  readonly count: number
  getAll(): TPlugin[]
  get(name: string): TPlugin | undefined
  has(name: string): boolean
  getStats(): IRegistryStats
}

// ════════════════════════════════════════════════════════════════
//  插件注册表完整接口（读 + 写）
// ════════════════════════════════════════════════════════════════

/**
 * 插件注册表完整接口（与主进程 IPluginRegistry 结构兼容）。
 *
 * 扩展只读接口，添加注册、注销和批量生命周期管理。
 */
export interface IPluginRegistry<TPlugin extends IPlugin> extends IPluginRegistryReadonly<TPlugin> {
  register(plugin: TPlugin): void
  unregister(name: string): boolean
  loadAll(): Promise<void>
  unloadAll(): Promise<void>
  clear(): void
}

// ════════════════════════════════════════════════════════════════
//  服务生命周期接口
// ════════════════════════════════════════════════════════════════

/** 服务运行状态枚举 */
export type ServiceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/** 服务状态快照 */
export interface ServiceStatus {
  readonly state: ServiceState
  readonly healthy: boolean
  readonly lastError?: string
  readonly uptimeMs?: number
}

/**
 * 服务生命周期接口（与主进程 IService 结构兼容）。
 *
 * 适用于需要显式启动/停止的服务。
 */
export interface IService {
  readonly name: string
  getStatus(): ServiceStatus
  start(): void | Promise<void>
  stop(): void | Promise<void>
  destroy(): void
}
