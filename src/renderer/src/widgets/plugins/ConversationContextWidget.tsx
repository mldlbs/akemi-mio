/**
 * ConversationContextWidget — 对话语境信息浮层组件
 *
 * 在桌面 Overlay 上显示当前对话的关键信息：
 * - 对话摘要（可点击跳转到对话）
 * - 待办任务列表（可点击打开任务）
 * - 进度指示器
 *
 * 数据流:
 *   ConversationContextService (main) → IPC push → ConversationContextWidget (renderer)
 *
 * 交互:
 *   单击摘要/任务 → 跳转到对应对话/任务
 *   折叠按钮 → 收起/展开面板
 *   隐私适配 → break 模式下隐藏具体内容
 */

import React, { useState, useEffect, useCallback } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'
import { useBatchSetter } from '../../hooks/useBatchSetter'

// =============================================================================
// 类型
// =============================================================================

interface TaskItem {
  taskId: string
  title: string
  status: string
  completedSteps: number
  totalSteps: number
  progressPercent: number
  updatedAt: number
}

interface ConversationContextPayload {
  summary: string
  summaryConfidence: number
  activeTasks: TaskItem[]
  completedTasks: number
  totalTasks: number
  progressPercent: number
  updatedAt: number
  hasData: boolean
  error?: string
}

interface ConversationContextConfig {
  enabled: boolean
  position: string
  maxTasks: number
  showSummary: boolean
  showTasks: boolean
  showProgress: boolean
}

// =============================================================================
// 常量
// =============================================================================

const MAX_SUMMARY_LENGTH = 100

// =============================================================================
// 子组件：任务进度条
// =============================================================================

function TaskProgressBar({ percent }: { percent: number }) {
  const fillColor = percent >= 100 ? '#4ade80' : percent >= 50 ? '#60a5fa' : '#fbbf24'
  return (
    <div className="wp-cc-progress-track">
      <div className="wp-cc-progress-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%`, background: fillColor }} />
    </div>
  )
}

// =============================================================================
// 子组件：活跃任务项
// =============================================================================

function TaskItemRow({ task, onNavigate }: { task: TaskItem; onNavigate: (taskId: string) => void }) {
  const statusIcon = task.status === 'paused' ? '⏸️' : '🔄'
  const statusClass = task.status === 'paused' ? 'wp-cc-task--paused' : 'wp-cc-task--active'

  return (
    <div
      className={`wp-cc-task ${statusClass}`}
      onClick={(e) => {
        e.stopPropagation()
        onNavigate(task.taskId)
      }}
      title={`单击跳转到任务：${task.title}`}
    >
      <span className="wp-cc-task-icon">{statusIcon}</span>
      <span className="wp-cc-task-title">{task.title}</span>
      {task.totalSteps > 0 && (
        <span className="wp-cc-task-steps">
          {task.completedSteps}/{task.totalSteps}
        </span>
      )}
    </div>
  )
}

// =============================================================================
// 主组件
// =============================================================================

function ConversationContextPanel({ ctx }: { ctx: WallpaperWidgetContext }) {
  const [payload, setPayload] = useState<ConversationContextPayload | null>(null)
  const [config, setConfig] = useState<ConversationContextConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [showConfig, setShowConfig] = useState(false)

  // 加载配置
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const cfg = await window.electronAPI.getConversationContextConfig()
        setConfig(cfg as ConversationContextConfig)
      } catch {
        // 静默失败，使用默认值
      }
    }
    loadConfig()
  }, [])

  // 订阅对话语境 IPC 推送（rAF 批量合并）
  const setBatchedPayload = useBatchSetter<ConversationContextPayload>((d) => {
    setPayload(d)
    if (d.error) {
      setError(d.error)
    } else {
      setError(null)
    }
  })
  useEffect(() => {
    const unsub = window.electronAPI.onConversationContextData((data) => {
      setBatchedPayload(data as ConversationContextPayload)
    })
    return unsub
  }, [setBatchedPayload])

  // 跳转到对话
  const handleNavigateToConversation = useCallback((conversationId: string) => {
    window.electronAPI.navigateToConversation(conversationId).catch(() => {})
  }, [])

  // 跳转到任务
  const handleNavigateToTask = useCallback((taskId: string) => {
    // 传递 taskId 作为对话 ID 跳转
    window.electronAPI.navigateToConversation(taskId).catch(() => {})
  }, [])

  // 切换折叠
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  // 切换配置面板
  const toggleConfig = useCallback(() => {
    setShowConfig((prev) => !prev)
  }, [])

  // ── 隐私适配：break 模式 + 高隐私淡入 → 隐藏具体内容 ──
  const isPrivacyMode = ctx.mode === 'break' && ctx.privacyFade > 0.5

  // 错误状态
  if (error && !payload?.hasData) {
    return (
      <div className="wp-cc-panel wp-cc-panel--error" title={error}>
        <div className="wp-cc-panel-title">
          <span className="wp-cc-panel-icon">💬</span>
          对话语境
        </div>
        <div className="wp-cc-error">加载失败</div>
      </div>
    )
  }

  // 空数据状态
  if (payload && !payload.hasData && !error) {
    return (
      <div className="wp-cc-panel wp-cc-panel--empty">
        <div className="wp-cc-panel-title">
          <span className="wp-cc-panel-icon">💬</span>
          对话语境
          <span className="wp-cc-panel-subtitle">暂无数据</span>
        </div>
      </div>
    )
  }

  // 无数据（服务未就绪）
  if (!payload) {
    return (
      <div className="wp-cc-panel wp-cc-panel--loading">
        <div className="wp-cc-panel-title">
          <span className="wp-cc-panel-icon">💬</span>
          对话语境
          <span className="wp-cc-panel-subtitle">等待数据…</span>
        </div>
      </div>
    )
  }

  // 折叠状态
  if (collapsed) {
    return (
      <div
        className={`wp-cc-panel wp-cc-panel--collapsed ${config?.position === 'left' ? 'wp-cc--left' : 'wp-cc--right'}`}
        onClick={toggleCollapsed}
        title="展开对话语境"
      >
        <span className="wp-cc-panel-icon">💬</span>
        <span className="wp-cc-collapsed-count">{payload.activeTasks.length > 0 ? payload.activeTasks.length : '✓'}</span>
      </div>
    )
  }

  const showSummary = config?.showSummary !== false && !isPrivacyMode
  const showTasks = config?.showTasks !== false && !isPrivacyMode
  const showProgress = config?.showProgress !== false && !isPrivacyMode
  const positionClass = config?.position === 'left' ? 'wp-cc--left' : 'wp-cc--right'

  return (
    <div className={`wp-cc-panel ${positionClass}`}>
      {/* 标题栏 */}
      <div className="wp-cc-panel-header">
        <div className="wp-cc-panel-title" onClick={toggleCollapsed}>
          <span className="wp-cc-panel-icon">💬</span>
          对话语境
          {payload.activeTasks.length > 0 && <span className="wp-cc-panel-count">{payload.activeTasks.length}</span>}
        </div>
        <div className="wp-cc-panel-actions">
          <button className="wp-cc-config-btn" onClick={toggleConfig} title="显示设置">
            ⚙️
          </button>
          <button className="wp-cc-collapse-btn" onClick={toggleCollapsed} title="折叠">
            −
          </button>
        </div>
      </div>

      {/* 配置面板 */}
      {showConfig && (
        <div className="wp-cc-config-dropdown">
          {(['summary', 'tasks', 'progress'] as const).map((key) => {
            const labels: Record<string, string> = { summary: '显示摘要', tasks: '显示任务', progress: '显示进度' }
            const current = key === 'summary' ? showSummary : key === 'tasks' ? showTasks : showProgress
            return (
              <label key={key} className="wp-cc-config-item">
                <input
                  type="checkbox"
                  checked={current}
                  onChange={async (e) => {
                    const patch: Record<string, boolean> = {}
                    patch[`show${key.charAt(0).toUpperCase() + key.slice(1)}`] = e.target.checked
                    try {
                      await window.electronAPI.setConversationContextConfig(patch)
                      // 重新加载配置
                      const cfg = await window.electronAPI.getConversationContextConfig()
                      setConfig(cfg as ConversationContextConfig)
                    } catch {
                      // 静默失败
                    }
                  }}
                />
                <span>{labels[key]}</span>
              </label>
            )
          })}
        </div>
      )}

      {/* 对话摘要 */}
      {showSummary && payload.summary && (
        <div className="wp-cc-summary" onClick={() => handleNavigateToConversation('current')} title="单击跳转到当前对话">
          <span className="wp-cc-summary-icon">📝</span>
          <span className="wp-cc-summary-text">
            {payload.summary.length > MAX_SUMMARY_LENGTH ? payload.summary.slice(0, MAX_SUMMARY_LENGTH - 3) + '...' : payload.summary}
          </span>
        </div>
      )}

      {/* 隐私模式占位 */}
      {isPrivacyMode && (
        <div className="wp-cc-privacy-placeholder">
          <span className="wp-cc-privacy-icon">🌙</span>
          <span className="wp-cc-privacy-text">休息中…</span>
        </div>
      )}

      {/* 进度条 */}
      {showProgress && payload.totalTasks > 0 && (
        <div className="wp-cc-progress-section">
          <div className="wp-cc-progress-header">
            <span className="wp-cc-progress-label">
              任务进度 {payload.completedTasks}/{payload.totalTasks}
            </span>
            <span className="wp-cc-progress-pct">{payload.progressPercent}%</span>
          </div>
          <TaskProgressBar percent={payload.progressPercent} />
        </div>
      )}

      {/* 活跃任务列表 */}
      {showTasks && payload.activeTasks.length > 0 && (
        <div className="wp-cc-tasks-section">
          <div className="wp-cc-tasks-header">
            <span className="wp-cc-tasks-label">待办任务</span>
          </div>
          <div className="wp-cc-tasks-list">
            {payload.activeTasks.slice(0, config?.maxTasks || 5).map((task) => (
              <TaskItemRow key={task.taskId} task={task} onNavigate={handleNavigateToTask} />
            ))}
          </div>
        </div>
      )}

      {/* 底部信息 */}
      <div className="wp-cc-panel-footer">
        <span className="wp-cc-refresh-time">{formatTime(payload.updatedAt)}</span>
      </div>
    </div>
  )
}

// =============================================================================
// 工具函数
// =============================================================================

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const now = Date.now()
  const diffMs = now - timestamp

  if (diffMs < 60_000) return '刚刚'
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// =============================================================================
// Widget 定义
// =============================================================================

export const conversationContextWidget: IWallpaperWidgetDefinition = {
  id: 'conversation-context',
  name: '对话语境',
  priority: 25,
  zone: 'overlay',
  shouldShow: (ctx: WallpaperWidgetContext) => {
    // 仅在非专注模式、非隐藏装饰时显示
    if (ctx.hideDecoration) return false
    if (ctx.mode === 'focus') return false
    // multitasking 模式下隐藏（减少信息负担）
    if (ctx.mode === 'multitasking') return false
    return true
  },
  Component: (ctx: WallpaperWidgetContext) => <ConversationContextPanel ctx={ctx} />,
}
