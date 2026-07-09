/**
 * SystemResourceWidget — 系统资源面板
 *
 * 在监控面板区域显示系统资源使用情况（内存、RSS、CPU、运行时间）。
 *
 * 模式适配：作为 IWallpaperWidgetDefinition 插件，
 * 通过 shouldShow 控制可见性，通过 Component 渲染内容。
 */

import React from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 工具函数
// =============================================================================

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

// =============================================================================
// 组件
// =============================================================================

function SystemResourcePanel({ monitoring }: WallpaperWidgetContext) {
  const system = monitoring?.system
  if (!system) return null

  const memPercent = system.heapTotalMB > 0
    ? Math.round((system.heapUsedMB / system.heapTotalMB) * 100)
    : 0

  return (
    <div className="wp-resource-panel">
      <div className="wp-resource-row">
        <span className="wp-resource-label">内存</span>
        <div className="wp-resource-track">
          <div
            className="wp-resource-fill"
            style={{
              width: `${Math.min(100, memPercent)}%`,
              background: memPercent > 80 ? '#ef4444' : memPercent > 60 ? '#f59e0b' : '#22c55e',
            }}
          />
        </div>
        <span className="wp-resource-value">{system.heapUsedMB}MB</span>
      </div>
      <div className="wp-resource-row">
        <span className="wp-resource-label">RSS</span>
        <span className="wp-resource-value">{system.rssMB}MB</span>
      </div>
      <div className="wp-resource-row">
        <span className="wp-resource-label">CPU</span>
        <span className="wp-resource-value">{system.cpuUsage}%</span>
      </div>
      <div className="wp-resource-row">
        <span className="wp-resource-label">运行</span>
        <span className="wp-resource-value">{formatUptime(system.uptime)}</span>
      </div>
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const systemResourceWidget: IWallpaperWidgetDefinition = {
  id: 'system-resource',
  name: '系统资源',
  priority: 30,
  zone: 'monitor',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    return ctx.monitoring?.system != null
  },
  Component: SystemResourcePanel,
}
