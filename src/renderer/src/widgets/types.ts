/**
 * Wallpaper Widget Plugin — 共享类型定义
 *
 * 模式来源：Memory 架构的 IMemoryPlugin + UnifiedMemoryQuery 的设计模式
 * - 标准化插件接口，解耦核心组件与扩展功能
 * - 统一渲染与可见性管理
 */

import type { BehaviorMode, ActivityContext, WallpaperConfig, BehaviorState } from '../hooks/useBehaviorAwareWallpaper'

// =============================================================================
// 监控数据类型（从 WallpaperOverlay.tsx 提取为共享类型）
// =============================================================================

export interface MonitoringSystem {
  heapUsedMB: number
  heapTotalMB: number
  rssMB: number
  eventLoopLagMs: number
  cpuUsage: number
  uptime: number
  timestamp: number
}

export interface MonitoringEvolution {
  stage: string
  progress: number
  summary: string
  errorCount: number
  fixedCount: number
  queueSize: number
  lastRunAt: number | null
  schedulerState: string
  consecutiveFailures: number
}

export interface MonitoringPlan {
  hasActivePlan: boolean
  planTitle: string
  totalSteps: number
  completedSteps: number
  percentComplete: number
  currentStep: string
}

export interface MonitoringChange {
  filePath: string
  type: string
  timestamp: number
  summary: string
}

export interface MonitoringData {
  system: MonitoringSystem
  evolution: MonitoringEvolution | null
  plan: MonitoringPlan | null
  recentChanges: MonitoringChange[]
  evoLocked: boolean
}

/**
 * Widget 组件类型。
 * 接收展开后的 WallpaperWidgetContext 作为 props。
 * Host 通过 `<widget.Component {...ctx} />` 调用，所以组件必须解构 `WallpaperWidgetContext` 直接属性，
 * 而非 `{ ctx: WallpaperWidgetContext }`。
 */
export type WallpaperWidgetComponent = React.ComponentType<WallpaperWidgetContext>

// =============================================================================
// Widget 插件上下文
// =============================================================================

/**
 * Widget 插件的运行时上下文。
 * 在每次渲染周期由 WallpaperWidgetHost 构造并传递给每个 widget。
 */
export interface WallpaperWidgetContext {
  mode: BehaviorMode
  context: ActivityContext
  config: WallpaperConfig
  behavior: BehaviorState | null
  monitoring: MonitoringData | null
  evoLocked: boolean
  hideDecoration: boolean
  opacity: number
  privacyFade: number
  modeLabel: string
  contextLabel: string
  /** 是否启用进化实时仪表盘（Canvas 模式） */
  evoDashboardEnabled?: boolean
  /** 进化仪表盘透明度覆盖 */
  evoDashboardOpacity?: number
}

/**
 * Widget 在 Overlay 中的摆放区域。
 * - overlay: 覆盖层内容（idle 面板、任务切换器等）
 * - monitor: 右下角监控面板区
 * - decoration: 装饰/美化元素（自然动画等）
 * - badge: 状态徽章（始终显示，除非 hideDecoration）
 */
export type WallpaperWidgetZone = 'overlay' | 'monitor' | 'decoration' | 'badge'

// =============================================================================
// Widget 插件定义
// =============================================================================

/**
 * Wallpaper Widget 插件定义。
 *
 * 模式来源：Memory 架构的 IMemoryPlugin
 * - IMemoryPlugin 定义标准化的 retrieve/update/getContext/dispose 接口
 * - 每个记忆存储（Vector、KG、Summary）通过 adaptToPlugin 适配后注册到 UnifiedMemoryQuery
 * - 核心组件通过统一接口操作所有插件，无需了解各插件内部实现
 *
 * IWallpaperWidgetDefinition 的对应设计：
 * - shouldShow → IMemoryPlugin.retrieve（判断插件是否在当前上下文中生效）
 * - Component   → IMemoryPlugin.getContext（插件提供自己的渲染/输出）
 * - priority    → 通过排序决定渲染顺序（类似插件检索结果的优先级）
 * - onInit/onDestroy → 插件生命周期管理
 */
export interface IWallpaperWidgetDefinition {
  /** 插件唯一标识 */
  readonly id: string

  /** 插件可读名称 */
  readonly name: string

  /**
   * 渲染优先级（低值优先）。
   * 同 zone 内按 priority 升序渲染。
   */
  readonly priority: number

  /** 插件所属区域 */
  readonly zone: WallpaperWidgetZone

  /**
   * 判断是否应在当前上下文中显示。
   * 纯函数，无副作用。
   * 类似 IMemoryPlugin.retrieve() 根据 query 判断相关性。
   */
  shouldShow(ctx: WallpaperWidgetContext): boolean

  /** 渲染组件 */
  Component: WallpaperWidgetComponent

  /**
   * 插件初始化回调（可选）。
   * 在注册时调用。
   */
  onInit?(ctx: WallpaperWidgetContext): void

  /**
   * 插件销毁回调（可选）。
   * 在注销时调用。
   */
  onDestroy?(): void
}
