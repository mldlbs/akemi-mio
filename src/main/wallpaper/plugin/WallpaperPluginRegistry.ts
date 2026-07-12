/**
 * WallpaperPluginRegistry — Wallpaper 插件 ServiceLoader
 *
 * 职责：
 *   1. 维护 IWallpaperPlugin 注册表
 *   2. 提供按能力（capability）发现插件的查询接口
 *   3. 管理插件的生命周期（onLoad / onUnload）
 *
 * 使用方式：
 *   const registry = WallpaperPluginRegistry.getInstance()
 *   registry.register(userBehaviorPlugin)
 *   await registry.loadAll()
 *   const provider = registry.getBehaviorProvider()
 *
 * 设计意图：
 *   - 单例，全局唯一
 *   - 插件注册后由 registry 统一管理，Wallpaper 系统不直接持有插件引用
 *   - 外部模块（如 UserBehavior）通过 registry 接入 Wallpaper，
 *     无需关心 Wallpaper 的内部调度
 *
 * 原理：
 *   基于 ServiceRegistry<IWallpaperPlugin, WallpaperPluginCapability>，
 *   通过 CapabilityReader 从 manifest.capabilities 中读取能力。
 *
 * 模式来源：
 *   - src/main/core/patterns/ServiceRegistry — 通用服务注册表
 *   - src/main/evolution/plugin/PluginServiceLoader — Evolution 同款 ServiceLoader
 */

import { ServiceRegistry } from '../../core/patterns/ServiceRegistry'
import type { IWallpaperPlugin, WallpaperPluginCapability, IBehaviorProvider } from './types'

/**
 * Wallpaper 插件能力读取器：从 manifest.capabilities（数组）中读取。
 */
function readWallpaperCapability(p: IWallpaperPlugin): WallpaperPluginCapability[] {
  return p.manifest.capabilities
}

export class WallpaperPluginRegistry extends ServiceRegistry<IWallpaperPlugin, WallpaperPluginCapability> {
  private static instance: WallpaperPluginRegistry

  private constructor() {
    super('wallpaper_plugin')
    this.setCapabilityReader(readWallpaperCapability)
  }

  static getInstance(): WallpaperPluginRegistry {
    if (!WallpaperPluginRegistry.instance) {
      WallpaperPluginRegistry.instance = new WallpaperPluginRegistry()
    }
    return WallpaperPluginRegistry.instance
  }

  /**
   * 获取行为提供者插件。
   * 遍历所有 behavior_provider 能力的插件，返回第一个提供 behaviorProvider 的接口。
   *
   * @returns IBehaviorProvider | null（无可用行为提供者时返回 null）
   */
  getBehaviorProvider(): IBehaviorProvider | null {
    const plugins = this.getByCapability('behavior_provider')
    for (const p of plugins) {
      if (p.behaviorProvider) return p.behaviorProvider
    }
    return null
  }
}
