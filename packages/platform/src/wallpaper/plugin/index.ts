/**
 * Wallpaper Plugin 系统 — 入口
 *
 * 导出所有插件契约、注册表和内置适配器。
 *
 * ── 使用示例 ──
 * ```ts
 * import { WallpaperPluginRegistry, UserBehaviorPluginAdapter } from './wallpaper/plugin'
 * import { UserBehaviorService } from '@akemi-mio/evolution/behavior'
 *
 * // 插件端：创建并注册
 * const registry = WallpaperPluginRegistry.getInstance()
 * const adapter = new UserBehaviorPluginAdapter(behaviorService)
 * registry.register(adapter)
 * await registry.loadAll()
 *
 * // Wallpaper 端：通过契约获取行为数据
 * const provider = registry.getBehaviorProvider()
 * const snapshot = provider?.getBehaviorSnapshot()
 * provider?.onBehaviorChange((snapshot) => { ... })
 * ```
 *
 * @module wallpaper-plugin
 */

export { WallpaperPluginRegistry } from '@akemi-mio/platform/wallpaper/plugin/WallpaperPluginRegistry'
export { UserBehaviorPluginAdapter } from '@akemi-mio/platform/wallpaper/plugin/UserBehaviorPluginAdapter'

export type {
  IWallpaperPlugin,
  IBehaviorProvider,
  WallpaperPluginManifest,
  WallpaperPluginCapability,
  WallpaperBehaviorSnapshot,
} from '@akemi-mio/platform/wallpaper/plugin/types'
