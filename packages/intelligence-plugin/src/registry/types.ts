/**
 * Plugin Registry — 统一抽象层
 *
 * 从以下系统中提取的共用接口：
 * - SpeechPluginRegistry (ASR / TTS 插件注册表)
 * - WallpaperWidgetRegistry (壁纸 Widget 插件注册表)
 * - Evolution PluginServiceLoader (进化系统插件加载器)
 *
 * 设计原则：
 * 1. 只读接口（查询类）与写接口（变更类）分离，调用方按需依赖
 * 2. 先提取只读接口，再扩展到写接口
 * 3. 每个接口只暴露调用方真正需要的方法，不暴露内部实现细节
 * 4. 两套实现共存后可通过策略模式在运行时选择具体实现
 *
 * 模式来源：ASR SpeechPluginRegistry / Memory 架构 UnifiedMemoryQuery
 * 的 register + query + lifecycle 范式
 */

// ════════════════════════════════════════════════════════════════
//  只读接口（查询类）— 调用方无需修改权限即可使用
// ════════════════════════════════════════════════════════════════

/** 插件基础元数据 */
export interface IPluginManifest {
  /** 唯一标识名，例如 'whisper_gpu', 'baidu_asr', 'memory-context' */
  readonly name: string
  /** 语义版本 */
  readonly version: string
  /** 人类可读描述 */
  readonly description: string
  /** 作者（可选） */
  readonly author?: string
  /** 优先级（数值越大越优先，默认 0） */
  readonly priority?: number
}

/** 插件运行状态 */
export interface IPluginStatus {
  /** 是否已加载就绪 */
  readonly ready: boolean
  /** 是否正在加载中 */
  readonly loading: boolean
  /** 错误信息（有错误时非 null） */
  readonly error: string | null
}

/**
 * 插件基础只读接口。
 *
 * 所有插件系统（ASR、Wallpaper、Evolution 等）可共用此接口的子集。
 * 调用方通过此接口发现插件、获取状态，无需了解具体实现细节。
 */
export interface IPlugin {
  /** 插件元数据 */
  readonly manifest: IPluginManifest

  /**
   * 获取插件当前状态。
   * @returns 包含 loaded/loading/error 的状态对象
   */
  getStatus(): IPluginStatus

  /**
   * 获取插件描述/模型信息（供调试 UI 展示）。
   * @returns 人类可读的描述字符串
   */
  getInfo(): string
}

/**
 * 插件注册表只读接口。
 *
 * 涵盖所有注册表通用的查询操作。
 * 调用方只需此接口即可发现和遍历插件，无需写权限。
 *
 * 示例用法：
 *   function displayPlugins(registry: IPluginRegistryReadonly<IPlugin>) {
 *     console.log(`共 ${registry.count} 个插件`)
 *     for (const p of registry.getAll()) {
 *       console.log(`  ${p.manifest.name} v${p.manifest.version}`)
 *     }
 *   }
 */
export interface IPluginRegistryReadonly<TPlugin extends object> {
  /** 已注册的插件数量 */
  readonly count: number

  /**
   * 获取所有已注册的插件。
   * 返回的数组按优先级降序排列（高优先级在前）。
   */
  getAll(): TPlugin[]

  /**
   * 按名称获取插件。
   * @param name 插件唯一标识名
   * @returns 插件实例，未找到时返回 undefined
   */
  get(name: string): TPlugin | undefined

  /**
   * 检查指定名称的插件是否已注册。
   * @param name 插件唯一标识名
   */
  has(name: string): boolean

  /**
   * 获取注册表统计信息。
   * @returns 包含总数和所有插件清单的对象
   */
  getStats(): IRegistryStats
}

/** 注册表统计信息 */
export interface IRegistryStats {
  /** 插件总数 */
  readonly total: number
  /** 所有已注册插件的元数据列表 */
  readonly plugins: IPluginManifest[]
}

// ════════════════════════════════════════════════════════════════
//  写接口（变更类）— 扩展只读接口，增加注册、注销、生命周期
// ════════════════════════════════════════════════════════════════

/**
 * 插件注册表完整接口（读+写）。
 *
 * 扩展只读接口，添加注册、注销和批量生命周期管理。
 * 需要写权限的调用方使用此接口。
 */
export interface IPluginRegistry<TPlugin extends object> extends IPluginRegistryReadonly<TPlugin> {
  /**
   * 注册一个插件。
   * 同名插件只能注册一次，重复注册应打印警告并跳过。
   * 注册后调用插件的 onInit/onLoad 回调（如果定义了）。
   *
   * @param plugin 要注册的插件实例
   */
  register(plugin: TPlugin): void

  /**
   * 注销指定名称的插件。
   * 注销前调用插件的 onUnload/onDestroy 回调（如果定义了）。
   *
   * @param name 要注销的插件名称
   * @returns 是否成功注销
   */
  unregister(name: string): boolean

  /**
   * 初始化所有已注册插件。
   * 遍历调用每个插件的 initialize() 钩子。
   * 单个插件初始化失败不影响其他插件。
   */
  loadAll(): Promise<void>

  /**
   * 卸载所有已注册插件。
   * 遍历调用每个插件的 onUnload() 钩子。
   */
  unloadAll(): Promise<void>

  /**
   * 清空所有插件。
   * 调用 unloadAll 的简写 —— 注销所有插件并清空注册表。
   */
  clear(): void
}

// ════════════════════════════════════════════════════════════════
//  服务生命周期接口
// ════════════════════════════════════════════════════════════════

/** 服务运行状态枚举 */
export type ServiceState =
  | 'stopped' // 已停止
  | 'starting' // 正在启动
  | 'running' // 运行中
  | 'stopping' // 正在停止
  | 'error' // 错误状态

/** 服务状态快照 */
export interface ServiceStatus {
  /** 当前运行状态 */
  readonly state: ServiceState
  /** 是否健康（running 状态下为 true） */
  readonly healthy: boolean
  /** 上次错误信息 */
  readonly lastError?: string
  /** 运行时长（毫秒，仅 running 时有效） */
  readonly uptimeMs?: number
}

/**
 * 服务生命周期接口。
 *
 * 适用于需要显式启动/停止的服务：
 * - MemoryContextService (wallpaper)
 * - WallpaperEventBridge
 * - MonitoringService
 * - AsrService 的部分子组件
 *
 * 调用方通过此接口统一管理服务，无需了解各服务的内部启动逻辑。
 */
export interface IService {
  /** 服务名称 */
  readonly name: string

  /** 获取服务当前状态 */
  getStatus(): ServiceStatus

  /** 启动服务 */
  start(): void | Promise<void>

  /** 停止服务 */
  stop(): void | Promise<void>

  /** 销毁服务，释放所有资源 */
  destroy(): void
}

// ════════════════════════════════════════════════════════════════
//  策略模式 — 运行时选择具体实现
// ════════════════════════════════════════════════════════════════

/**
 * 策略提供者 — 在运行时选择具体实现。
 *
 * ASR 示例：GPU Whisper → CPU Whisper → Baidu Cloud 的降级策略
 * Wallpaper 示例：不同壁纸模式（focus / multitasking / break）的显示策略
 * TTS 示例：本地引擎 vs 云端引擎的路由选择
 *
 * 使用方式：
 *   const provider: IStrategyProvider<AsrPlugin> = asrStrategyProvider
 *   // 查询当前活跃策略
 *   const active = provider.getActive()
 *   // 运行时切换策略
 *   provider.setActive('whisper_gpu')
 */
export interface IStrategyProvider<TStrategy> {
  /**
   * 获取当前活跃的策略实例。
   * @returns 当前策略，无可用策略时返回 null
   */
  getActive(): TStrategy | null

  /**
   * 获取所有可用策略。
   * @returns 全部已注册的策略实例列表
   */
  getAll(): TStrategy[]

  /**
   * 设置活跃策略。
   * @param name 策略名称（对应策略的 manifest.name）
   * @returns 是否设置成功
   */
  setActive(name: string): boolean
}
