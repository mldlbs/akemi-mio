/**
 * WallpaperWidgetRegistry — Wallpaper Widget 插件注册表
 *
 * 模式来源：Memory 架构的 UnifiedMemoryQuery
 *
 * UnifiedMemoryQuery 解决的问题：
 * - 多个记忆存储（Vector、KG、Summary、Engineering）需要统一查询入口
 * - 通过 register() 和 registerPlugin() 动态添加存储后端
 * - query() 遍历所有注册的插件，聚合结果
 * - 适配器模式 (adaptToPlugin) 允许现有 store 参与而不修改其代码
 *
 * WallpaperWidgetRegistry 的对应设计：
 * - register() → UnifiedMemoryQuery.registerPlugin()
 * - getWidgets() → UnifiedMemoryQuery.query()
 * - getWidgetsByZone() → 按区域筛选（类似按 type 筛选记忆存储）
 * - clear() → 统一清理（类似 UnifiedMemoryQuery 的 dispose）
 */

import type { IWallpaperWidgetDefinition, WallpaperWidgetContext, WallpaperWidgetZone } from './types'

// =============================================================================
// WallpaperWidgetRegistry
// =============================================================================

/**
 * Wallpaper Widget 注册表。
 * 管理所有 widget 插件的注册、查询和生命周期。
 */
export class WallpaperWidgetRegistry {
  /** 已注册的 widget 插件（按 id 索引） */
  private widgets = new Map<string, IWallpaperWidgetDefinition>()

  /** 按区域分组的 widget ID 列表（保持注册顺序） */
  private zoneOrder = new Map<WallpaperWidgetZone, string[]>()

  // ==================== 注册 / 注销 ====================

  /**
   * 注册一个 widget 插件。
   * 类似 UnifiedMemoryQuery.registerPlugin()。
   * 调用插件的 onInit 回调（如果定义了）。
   *
   * @param widget 要注册的 widget 定义
   * @param ctx 初始化上下文
   * @throws 如果 widget id 已存在
   */
  register(widget: IWallpaperWidgetDefinition, ctx?: WallpaperWidgetContext): void {
    if (this.widgets.has(widget.id)) {
      console.warn(`[WidgetRegistry] Widget "${widget.id}" 已注册，跳过`)
      return
    }

    this.widgets.set(widget.id, widget)

    // 维护区域渲染顺序
    if (!this.zoneOrder.has(widget.zone)) {
      this.zoneOrder.set(widget.zone, [])
    }
    this.zoneOrder.get(widget.zone)!.push(widget.id)

    // 调用初始化回调
    if (widget.onInit && ctx) {
      try {
        widget.onInit(ctx)
      } catch (err) {
        console.error(`[WidgetRegistry] Widget "${widget.id}" onInit 失败:`, err)
      }
    }
  }

  /**
   * 注销一个 widget 插件。
   * 调用插件的 onDestroy 回调（如果定义了）。
   *
   * @param id 要注销的 widget id
   * @returns 是否成功注销
   */
  unregister(id: string): boolean {
    const widget = this.widgets.get(id)
    if (!widget) return false

    // 调用销毁回调
    if (widget.onDestroy) {
      try {
        widget.onDestroy()
      } catch (err) {
        console.error(`[WidgetRegistry] Widget "${id}" onDestroy 失败:`, err)
      }
    }

    this.widgets.delete(id)

    // 从区域顺序中移除
    for (const [zone, ids] of this.zoneOrder) {
      const idx = ids.indexOf(id)
      if (idx >= 0) {
        ids.splice(idx, 1)
        if (ids.length === 0) {
          this.zoneOrder.delete(zone)
        }
        break
      }
    }

    return true
  }

  // ==================== 查询 ====================

  /**
   * 获取所有已注册的 widget 定义。
   * 类似 UnifiedMemoryQuery.getAllPlugins()。
   */
  getAll(): IWallpaperWidgetDefinition[] {
    return Array.from(this.widgets.values())
  }

  /**
   * 按 id 获取 widget 定义。
   */
  get(id: string): IWallpaperWidgetDefinition | undefined {
    return this.widgets.get(id)
  }

  /**
   * 获取指定区域的所有 widget，按 priority 升序排列。
   * 类似 UnifiedMemoryQuery.query() 中按 type 过滤存储。
   */
  getWidgetsByZone(zone: WallpaperWidgetZone): IWallpaperWidgetDefinition[] {
    const ids = this.zoneOrder.get(zone)
    if (!ids) return []

    return ids
      .map((id) => this.widgets.get(id)!)
      .filter(Boolean)
      .sort((a, b) => a.priority - b.priority)
  }

  /**
   * 获取指定区域中在当前上下文中可见的 widget。
   * 调用每个 widget 的 shouldShow() 方法进行过滤。
   */
  getVisibleWidgets(
    zone: WallpaperWidgetZone,
    ctx: WallpaperWidgetContext,
  ): IWallpaperWidgetDefinition[] {
    return this.getWidgetsByZone(zone).filter((w) => w.shouldShow(ctx))
  }

  /**
   * 获取所有已注册的区域列表。
   */
  getZones(): WallpaperWidgetZone[] {
    return Array.from(this.zoneOrder.keys())
  }

  /**
   * 获取已注册的 widget 数量。
   */
  get count(): number {
    return this.widgets.size
  }

  // ==================== 生命周期 ====================

  /**
   * 清理所有已注册的 widget。
   * 类似 UnifiedMemoryQuery 在系统关闭时的清理。
   */
  clear(): void {
    // 按注册顺序逆序销毁
    const ids = Array.from(this.widgets.keys()).reverse()
    for (const id of ids) {
      this.unregister(id)
    }
    this.zoneOrder.clear()
  }
}

// =============================================================================
// 全局单例
// =============================================================================

/** 全局 Wallpaper Widget 注册表单例 */
export const wallpaperWidgetRegistry = new WallpaperWidgetRegistry()
