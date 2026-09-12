/**
 * Wallpaper Widget Plugin System — 导出入口
 *
 * 模式来源：Memory 架构的插件体系（IMemoryPlugin + UnifiedMemoryQuery）
 *
 * 导出所有插件相关类型、注册表和主机组件。
 */

// 类型导出
export type { IWallpaperWidgetDefinition } from './types'
export type {
  WallpaperWidgetContext,
  WallpaperWidgetZone,
  MonitoringData,
  MonitoringSystem,
  MonitoringEvolution,
  MonitoringPlan,
  MonitoringChange,
} from './types'

// 注册表
export { WallpaperWidgetRegistry, wallpaperWidgetRegistry } from './WallpaperWidgetRegistry'

// 主机组件
export { WallpaperWidgetHost } from './WallpaperWidgetHost'
