/**
 * EvolutionDashboard — 自进化壁纸仪表盘
 *
 * 在桌面右下角以半透明卡片实时展示 Evolution 系统的运行状态:
 * - 当前阶段（idle/collecting/analyzing/fixing/verifying/cooldown/error）
 * - 进度条（0-100%）
 * - 变更摘要文本
 * - 错误/修复计数
 * - 支持鼠标穿透（卡片区域除外）和托盘切换显示
 */

import { useState, useEffect, useCallback } from 'react'
import { useIPCEvent } from '../hooks/useIPCEvent'
import { useActivityOpacity } from '../hooks/useActivityOpacity'

// =============================================================================
// 类型定义
// =============================================================================

interface DashboardData {
  stage: string
  progress: number
  summary: string
  errorCount: number
  fixedCount: number
  queueSize: number
  lastRunAt: number | null
  schedulerState: string
  safetyMode: string
  consecutiveFailures: number
  visible: boolean
  updatedAt: number
}

// =============================================================================
// 阶段标签与进度颜色映射
// =============================================================================

const STAGE_LABELS: Record<string, string> = {
  idle: '待机中',
  collecting: '采集信号',
  analyzing: '分析中',
  fixing: '修复中',
  verifying: '验证中',
  cooldown: '冷却中',
  error: '异常',
}

const STAGE_COLORS: Record<string, string> = {
  idle: 'var(--text-muted)',
  collecting: 'var(--accent-slot)',
  analyzing: 'var(--accent-slot)',
  fixing: 'var(--accent)',
  verifying: 'var(--accent-soft)',
  cooldown: '#f59e0b',
  error: '#ef4444',
}

// =============================================================================
// 进度条子组件
// =============================================================================

function ProgressBar({ progress, stage }: { progress: number; stage: string }) {
  const clamped = Math.max(0, Math.min(100, progress))
  const color = STAGE_COLORS[stage] || 'var(--accent)'
  const isIndeterminate = stage === 'analyzing' || stage === 'fixing'

  return (
    <div className="evo-dash-progress-track">
      <div
        className={`evo-dash-progress-fill ${isIndeterminate ? 'evo-dash-progress--indeterminate' : ''}`}
        style={{
          width: isIndeterminate ? '40%' : `${clamped}%`,
          background: color,
        }}
      />
      {!isIndeterminate && <span className="evo-dash-progress-label">{clamped}%</span>}
    </div>
  )
}

// =============================================================================
// 时间格式化
// =============================================================================

function formatTimeAgo(timestamp: number | null): string {
  if (!timestamp) return '—'
  const diff = Date.now() - timestamp
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

// =============================================================================
// 主组件
// =============================================================================

export function EvolutionDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  const { opacity } = useActivityOpacity({ idleThresholdMs: 30_000, minOpacity: 0.15, maxOpacity: 1.0 })

  // 监听 IPC push 事件
  useIPCEvent<DashboardData>(
    (cb) => (window as any).electronAPI?.onEvolutionDashboard?.(cb) ?? (() => {}),
    (incoming) => {
      setData(incoming)
    },
  )

  // 按 Esc 或点击外部区域可折叠（不影响穿透后的桌面）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCollapsed((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  // 隐藏状态 — 不渲染任何内容，桌面完全穿透
  if (!data || !data.visible) {
    return null
  }

  const stage = data.stage || 'idle'
  const stageLabel = STAGE_LABELS[stage] || stage
  const stageColor = STAGE_COLORS[stage] || 'var(--text-muted)'
  const hasActivity = stage !== 'idle'

  return (
    <div className="evolution-dashboard" data-stage={stage} style={{ opacity, transition: 'opacity 0.8s ease' }}>
      {/* 折叠状态：只显示小指示器 */}
      {collapsed ? (
        <button className="evo-dash-collapsed-btn" onClick={toggleCollapse} title="展开自进化仪表盘">
          <span className="evo-dash-dot" style={{ background: stageColor }} />
          <span className="evo-dash-collapsed-label">{stageLabel}</span>
        </button>
      ) : (
        <div className="evo-dash-card">
          {/* 标题栏 */}
          <div className="evo-dash-header">
            <span className="evo-dash-title">自进化</span>
            <div className="evo-dash-header-right">
              {hasActivity && (
                <span className="evo-dash-stage-badge" style={{ background: stageColor }}>
                  {stageLabel}
                </span>
              )}
              <button className="evo-dash-collapse-btn" onClick={toggleCollapse} title="折叠">
                <i className="ri-arrow-down-s-line" />
              </button>
            </div>
          </div>

          {/* 进度条 */}
          <ProgressBar progress={data.progress} stage={stage} />

          {/* 摘要 */}
          {data.summary && <p className="evo-dash-summary">{data.summary}</p>}

          {/* 统计行 */}
          <div className="evo-dash-stats">
            {data.fixedCount > 0 && (
              <span className="evo-dash-stat evo-dash-stat--good">
                <i className="ri-check-line" />
                {data.fixedCount} 修复
              </span>
            )}
            {data.errorCount > 0 && (
              <span className="evo-dash-stat evo-dash-stat--bad">
                <i className="ri-error-warning-line" />
                {data.errorCount} 错误
              </span>
            )}
            {data.queueSize > 0 && (
              <span className="evo-dash-stat evo-dash-stat--queue">
                <i className="ri-stack-line" />
                {data.queueSize} 待处理
              </span>
            )}
            {data.consecutiveFailures > 0 && (
              <span className="evo-dash-stat evo-dash-stat--bad">
                <i className="ri-close-circle-line" />
                连续 {data.consecutiveFailures} 次失败
              </span>
            )}
          </div>

          {/* 页脚：时间戳 + 安全模式 */}
          <div className="evo-dash-footer">
            <span className="evo-dash-time">{formatTimeAgo(data.lastRunAt)}</span>
            <span className="evo-dash-mode">{data.safetyMode === 'review' ? '审查模式' : '自动模式'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
