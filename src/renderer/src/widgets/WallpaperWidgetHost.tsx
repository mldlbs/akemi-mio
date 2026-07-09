/**
 * WallpaperWidgetHost — Wallpaper Widget 插件渲染主机
 *
 * 模式来源：Memory 架构的 UnifiedMemoryQuery
 *
 * UnifiedMemoryQuery 解决的问题：
 * - 为多个记忆存储插件提供统一的查询入口
 * - 核心组件只需调用 query() 即可获取所有存储的聚合结果
 * - 插件的注册/注销对核心组件透明
 *
 * WallpaperWidgetHost 的对应设计：
 * - 遍历注册表中指定区域的 widget
 * - 调用 shouldShow() 判断可见性（类似 Memory 中 query() 的过滤逻辑）
 * - 渲染可见 widget 的 Component
 * - 对 WallpaperOverlay 透明：只需声明区域，无需了解有哪些 widget
 *
 * 使用方式：
 * ```tsx
 * <WallpaperWidgetHost zone="monitor" ctx={context} />
 * <WallpaperWidgetHost zone="overlay" ctx={context} />
 * <WallpaperWidgetHost zone="decoration" ctx={context} />
 * ```
 */

import React, { useMemo } from 'react'
import { wallpaperWidgetRegistry } from './WallpaperWidgetRegistry'
import type { WallpaperWidgetContext, WallpaperWidgetZone } from './types'

// =============================================================================
// Props
// =============================================================================

interface WallpaperWidgetHostProps {
  /** 要渲染的 widget 区域 */
  zone: WallpaperWidgetZone

  /** 运行时上下文 */
  ctx: WallpaperWidgetContext

  /** 容器 className（可选） */
  className?: string

  /** 额外容器样式（可选） */
  style?: React.CSSProperties

  /** 是否渲染空容器（无可见 widget 时是否渲染容器 div） */
  renderEmpty?: boolean
}

// =============================================================================
// 主机组件
// =============================================================================

/**
 * 渲染指定区域中所有可见的 widget。
 * 按 priority 升序排列组件。
 */
export function WallpaperWidgetHost({
  zone,
  ctx,
  className,
  style,
  renderEmpty = false,
}: WallpaperWidgetHostProps) {
  const visibleWidgets = useMemo(
    () => wallpaperWidgetRegistry.getVisibleWidgets(zone, ctx),
    [zone, ctx],
  )

  if (visibleWidgets.length === 0 && !renderEmpty) return null

  return (
    <div className={className} style={style} data-widget-zone={zone}>
      {visibleWidgets.map((widget) => (
        <widget.Component key={widget.id} {...ctx} />
      ))}
    </div>
  )
}
