/**
 * ModeBadgeWidget — 行为模式徽章
 *
 * 在 overlay 上层显示当前行为模式的徽章（专注/多任务/休息）。
 * 始终可见，除非 hideDecoration 为 true。
 *
 * 模式适配：作为 IWallpaperWidgetDefinition 插件，
 * 通过 shouldShow 控制可见性，通过 Component 渲染内容。
 */

import React from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 模式映射
// =============================================================================

const MODE_LABELS: Record<string, string> = {
  focus: '专注',
  multitasking: '多任务',
  break: '休息',
}

const MODE_COLORS: Record<string, string> = {
  focus: '#22c55e',
  multitasking: '#f59e0b',
  break: '#60a5fa',
}

// =============================================================================
// 组件
// =============================================================================

function ModeBadge({ mode }: WallpaperWidgetContext) {
  const color = MODE_COLORS[mode] || MODE_COLORS.focus
  const label = MODE_LABELS[mode] || mode

  return (
    <div className="wp-mode-badge" style={{ borderColor: color }}>
      <span className="wp-mode-badge-dot" style={{ background: color }} />
      <span className="wp-mode-badge-label">{label}</span>
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const modeBadgeWidget: IWallpaperWidgetDefinition = {
  id: 'mode-badge',
  name: '模式徽章',
  priority: 0,
  zone: 'badge',
  shouldShow: () => true, // 始终可见（外层控制整体显隐）
  Component: ModeBadge,
}
