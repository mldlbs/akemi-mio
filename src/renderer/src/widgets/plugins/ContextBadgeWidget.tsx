/**
 * ContextBadgeWidget — 活动情境标签
 *
 * 在 overlay 右上角显示当前活动情境标签（编程/浏览/休息）。
 *
 * 模式适配：作为 IWallpaperWidgetDefinition 插件，
 * 通过 shouldShow 控制可见性，通过 Component 渲染内容。
 */

import React from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 情境映射
// =============================================================================

const CONTEXT_LABELS: Record<string, string> = {
  coding: '编程',
  browsing: '浏览',
  resting: '休息',
}

// =============================================================================
// 组件
// =============================================================================

function ContextBadge({ context, contextLabel, behavior }: WallpaperWidgetContext) {
  const icon = context === 'coding' ? '💻' : context === 'browsing' ? '🌐' : '🌿'

  return (
    <div className="wp-context-badge" title={contextLabel}>
      <span className="wp-context-badge-icon">{icon}</span>
      <span className="wp-context-badge-label">{contextLabel}</span>
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const contextBadgeWidget: IWallpaperWidgetDefinition = {
  id: 'context-badge',
  name: '情境标签',
  priority: 5,
  zone: 'badge',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    return ctx.behavior != null
  },
  Component: ContextBadge,
}
