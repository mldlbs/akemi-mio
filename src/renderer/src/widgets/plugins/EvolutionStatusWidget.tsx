/**
 * EvolutionStatusWidget — 自进化状态面板
 *
 * 在监控面板区域显示自进化系统的当前状态、进度和统计。
 *
 * 模式适配：作为 IWallpaperWidgetDefinition 插件，
 * 通过 shouldShow 控制可见性，通过 Component 渲染内容。
 */

import React from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 阶段映射
// =============================================================================

const STAGE_LABELS: Record<string, string> = {
  idle: '待机',
  collecting: '采集',
  analyzing: '分析',
  fixing: '修复',
  verifying: '验证',
  cooldown: '冷却',
  error: '异常',
}

const STAGE_COLORS: Record<string, string> = {
  idle: '#888',
  collecting: '#60a5fa',
  analyzing: '#60a5fa',
  fixing: '#f59e0b',
  verifying: '#22c55e',
  cooldown: '#f97316',
  error: '#ef4444',
}

// =============================================================================
// 组件
// =============================================================================

function EvolutionStatusPanel({ monitoring }: WallpaperWidgetContext) {
  const evolution = monitoring?.evolution
  if (!evolution) return null

  const stage = evolution.stage || 'idle'
  const label = STAGE_LABELS[stage] || stage
  const color = STAGE_COLORS[stage] || '#888'
  const hasActivity = stage !== 'idle'

  return (
    <div className="wp-evo-status">
      <div className="wp-evo-header">
        <span className="wp-evo-title">自进化</span>
        {hasActivity && (
          <span className="wp-evo-badge" style={{ background: color }}>
            {label}
          </span>
        )}
      </div>

      {/* 进度条 */}
      <div className="wp-evo-progress-track">
        <div
          className="wp-evo-progress-fill"
          style={{
            width: `${Math.max(0, Math.min(100, evolution.progress))}%`,
            background: color,
          }}
        />
      </div>

      {/* 摘要 */}
      {evolution.summary && <div className="wp-evo-summary">{evolution.summary}</div>}

      {/* 统计 */}
      <div className="wp-evo-stats">
        {evolution.fixedCount > 0 && <span className="wp-evo-stat wp-evo-stat--good">✓ {evolution.fixedCount} 修复</span>}
        {evolution.errorCount > 0 && <span className="wp-evo-stat wp-evo-stat--bad">✗ {evolution.errorCount} 错误</span>}
        {evolution.consecutiveFailures > 0 && <span className="wp-evo-stat wp-evo-stat--bad">⚠ 连败 {evolution.consecutiveFailures}</span>}
      </div>
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const evolutionStatusWidget: IWallpaperWidgetDefinition = {
  id: 'evolution-status',
  name: '自进化状态',
  priority: 10,
  zone: 'monitor',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    return ctx.monitoring?.evolution != null
  },
  Component: EvolutionStatusPanel,
}
