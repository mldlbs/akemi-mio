/**
 * TaskPanelWidget — 桌面悬浮任务面板
 *
 * 在壁纸 Overlay 上以卡片式 UI 显示 Agent 的任务状态、计划进度和快捷操作。
 *
 * 功能：
 *   1. Agent 状态指示器（待机/处理中/已暂停）
 *   2. 活跃计划进度条
 *   3. 快捷操作按钮（截图并翻译、快速笔记、添加待办等）
 *   4. 最近操作记录列表
 *   5. 面板折叠/展开
 *   6. 鼠标穿透：非交互区域点击穿透
 *
 * 区：overlay（在主面板下方浮动显示）
 * 可见性：由 TaskPanelService.visible 控制（通过 IPC 切换）
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 类型定义
// =============================================================================

interface TaskPanelQuickAction {
  id: string
  label: string
  icon: string
  description: string
  tool: string
  args: Record<string, string>
  needsInput?: boolean
  inputPrompt?: string
  inputField?: string
}

interface TaskPanelPlanInfo {
  hasActivePlan: boolean
  planTitle: string
  totalSteps: number
  completedSteps: number
  percentComplete: number
  currentStep: string
}

interface TaskPanelAgentState {
  busy: boolean
  paused: boolean
  statusLabel: string
  toolName: string | null
  toolStatus: 'idle' | 'running' | 'success' | 'error' | null
}

interface TaskPanelRecentAction {
  id: string
  tool: string
  status: 'running' | 'success' | 'error'
  summary: string
  timestamp: number
}

interface TaskPanelState {
  agent: TaskPanelAgentState
  plan: TaskPanelPlanInfo
  quickActions: TaskPanelQuickAction[]
  recentActions: TaskPanelRecentAction[]
  visible: boolean
  timestamp: number
}

// =============================================================================
// 常量
// =============================================================================

/** 面板自动刷新间隔（毫秒） */
const POLL_INTERVAL = 5000

/** 最近操作保留数量 */
const MAX_RECENT = 5

/** 状态图标映射 */
const STATUS_ICONS: Record<string, string> = {
  idle: '○',
  running: '◉',
  success: '✓',
  error: '✗',
}

const STATUS_LABELS: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  success: '成功',
  error: '失败',
}

// =============================================================================
// 状态气泡子组件
// =============================================================================

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string; pulse: boolean }> = {
    idle: { bg: '#22c55e33', text: '#4ade80', pulse: false },
    running: { bg: '#60a5fa33', text: '#60a5fa', pulse: true },
    paused: { bg: '#f59e0b33', text: '#fbbf24', pulse: false },
    error: { bg: '#ef444433', text: '#f87171', pulse: false },
  }
  const c = colors[status] || { bg: '#88888833', text: '#888', pulse: false }

  return (
    <span className={`wp-tp-badge${c.pulse ? ' wp-tp-pulse' : ''}`} style={{ background: c.bg, color: c.text }}>
      {status === 'running' ? '● ' : '○ '}
      {status === 'running' ? '处理中' : status === 'paused' ? '已暂停' : status === 'idle' ? '待机' : status}
    </span>
  )
}

// =============================================================================
// 快捷操作按钮
// =============================================================================

function QuickActionButton({
  action,
  onInvoke,
  disabled,
}: {
  action: TaskPanelQuickAction
  onInvoke: (action: TaskPanelQuickAction) => void
  disabled: boolean
}) {
  const [showInput, setShowInput] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleClick = useCallback(() => {
    if (action.needsInput) {
      if (showInput) {
        if (inputValue.trim()) {
          onInvoke({
            ...action,
            args: { ...action.args, [action.inputField || 'content']: inputValue.trim() },
          })
          setInputValue('')
          setShowInput(false)
        }
      } else {
        setShowInput(true)
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    } else {
      onInvoke(action)
    }
  }, [action, showInput, inputValue, onInvoke])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (inputValue.trim()) {
          onInvoke({
            ...action,
            args: { ...action.args, [action.inputField || 'content']: inputValue.trim() },
          })
          setInputValue('')
          setShowInput(false)
        }
      } else if (e.key === 'Escape') {
        setShowInput(false)
        setInputValue('')
      }
    },
    [action, inputValue, onInvoke],
  )

  return (
    <div className="wp-tp-action-wrapper">
      <button className="wp-tp-action-btn" onClick={handleClick} disabled={disabled} title={action.description}>
        <span className="wp-tp-action-icon">{action.icon}</span>
        <span className="wp-tp-action-label">{action.label}</span>
      </button>
      {showInput && (
        <div className="wp-tp-action-input">
          <input
            ref={inputRef}
            type="text"
            className="wp-tp-input"
            placeholder={action.inputPrompt || '输入...'}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setShowInput(false), 150)}
          />
        </div>
      )}
    </div>
  )
}

// =============================================================================
// 进度条子组件
// =============================================================================

function ProgressBar({ percent, color }: { percent: number; color?: string }) {
  return (
    <div className="wp-tp-progress-track">
      <div
        className="wp-tp-progress-fill"
        style={{
          width: `${Math.max(2, Math.min(100, percent))}%`,
          background: color ? `linear-gradient(90deg, ${color}, ${color}cc)` : undefined,
        }}
      />
    </div>
  )
}

// =============================================================================
// 主组件
// =============================================================================

function TaskPanelContainer({ hideDecoration }: WallpaperWidgetContext) {
  const [panelState, setPanelState] = useState<TaskPanelState | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [invokingAction, setInvokingAction] = useState<string | null>(null)
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── 加载面板状态 ──
  const loadState = useCallback(async () => {
    try {
      const res = await window.electronAPI.getTaskPanelState()
      if (res.success && res.state) {
        setPanelState(res.state)
      }
    } catch {
      // 静默失败
    } finally {
      setLoading(false)
    }
  }, [])

  // ── 初始加载 + 轮询 ──
  useEffect(() => {
    loadState()
    pollRef.current = setInterval(loadState, POLL_INTERVAL)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [loadState])

  // ── 请求立即刷新 ──
  const handleRefresh = useCallback(() => {
    loadState()
  }, [loadState])

  // ── 执行快捷操作 ──
  const handleInvokeAction = useCallback(
    async (action: TaskPanelQuickAction) => {
      setInvokingAction(action.id)
      setFeedbackMsg(null)

      try {
        const res = await window.electronAPI.invokeTaskPanelQuickAction(action.id, action.args)
        if (res.success) {
          setFeedbackMsg(`✅ ${action.label} 已执行`)
        } else {
          setFeedbackMsg(`❌ ${res.error || '执行失败'}`)
        }
        // 刷新状态
        loadState()
      } catch (err: any) {
        setFeedbackMsg(`❌ ${err.message || '异常'}`)
      } finally {
        setInvokingAction(null)
        setTimeout(() => setFeedbackMsg(null), 3000)
      }
    },
    [loadState],
  )

  // ── 聚焦模式/隐藏状态不渲染 ──
  if (hideDecoration) return null

  // ── 空状态 ──
  if (loading) {
    return null
  }

  if (!panelState || !panelState.visible) {
    return null
  }

  // ── 计算进度 ──
  const agent = panelState.agent
  const plan = panelState.plan
  const recentActions = panelState.recentActions?.slice(0, MAX_RECENT) || []
  const hasActivePlan = plan?.hasActivePlan

  return (
    <div className={`wp-tp-panel${expanded ? ' wp-tp-expanded' : ''}`}>
      {/* ── 标题栏 ── */}
      <div
        className="wp-tp-header"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setExpanded(!expanded)
        }}
      >
        <div className="wp-tp-header-left">
          <StatusBadge status={agent.paused ? 'paused' : agent.busy ? 'running' : 'idle'} />
        </div>
        <div className="wp-tp-header-right">
          {hasActivePlan && <span className="wp-tp-plan-pct">{plan.percentComplete}%</span>}
          <button
            className="wp-tp-refresh-btn"
            onClick={(e) => {
              e.stopPropagation()
              handleRefresh()
            }}
            title="刷新"
          >
            ↻
          </button>
          <span className="wp-tp-expand-icon">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {/* ── 计划进度 ── */}
      {hasActivePlan && (
        <div className="wp-tp-plan-section">
          <div className="wp-tp-plan-title" title={plan.planTitle}>
            📋 {plan.planTitle.length > 25 ? plan.planTitle.slice(0, 25) + '…' : plan.planTitle}
          </div>
          <ProgressBar percent={plan.percentComplete} color="#60a5fa" />
          <div className="wp-tp-plan-stats">
            <span>
              {plan.completedSteps}/{plan.totalSteps} 步
            </span>
            {plan.currentStep && (
              <span className="wp-tp-plan-current" title={plan.currentStep}>
                → {plan.currentStep.length > 20 ? plan.currentStep.slice(0, 20) + '…' : plan.currentStep}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── 折叠状态（仅进度条，无快捷操作） ── */}
      {!expanded && (
        <>
          {/* 反馈提示 */}
          {feedbackMsg && <div className="wp-tp-feedback">{feedbackMsg}</div>}
        </>
      )}

      {/* ── 展开状态（快捷操作 + 最近记录） ── */}
      {expanded && (
        <>
          {/* 反馈提示 */}
          {feedbackMsg && <div className="wp-tp-feedback">{feedbackMsg}</div>}

          {/* 快捷操作 */}
          {panelState.quickActions && panelState.quickActions.length > 0 && (
            <div className="wp-tp-actions">
              <div className="wp-tp-section-title">快捷操作</div>
              <div className="wp-tp-action-grid">
                {panelState.quickActions.map((action) => (
                  <QuickActionButton
                    key={action.id}
                    action={action}
                    onInvoke={handleInvokeAction}
                    disabled={invokingAction === action.id}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 最近操作记录 */}
          {recentActions.length > 0 && (
            <div className="wp-tp-recent">
              <div className="wp-tp-section-title">最近操作</div>
              <div className="wp-tp-recent-list">
                {recentActions.map((ra) => (
                  <div key={ra.id} className={`wp-tp-recent-item wp-tp-recent-${ra.status}`}>
                    <span
                      className="wp-tp-recent-icon"
                      style={{
                        color: ra.status === 'success' ? '#4ade80' : ra.status === 'error' ? '#f87171' : '#60a5fa',
                      }}
                    >
                      {STATUS_ICONS[ra.status] || '○'}
                    </span>
                    <span className="wp-tp-recent-summary">{ra.summary}</span>
                    <span className="wp-tp-recent-time">{formatTimeAgo(ra.timestamp)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 空状态提示 */}
          {(!panelState.quickActions || panelState.quickActions.length === 0) && recentActions.length === 0 && (
            <div className="wp-tp-empty">
              <p>暂无快捷操作</p>
              <p className="wp-tp-empty-hint">Agent 就绪，等待指令</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// =============================================================================
// 工具函数
// =============================================================================

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 5_000) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  return `${Math.floor(diff / 3_600_000)}小时前`
}

// =============================================================================
// Widget 定义
// =============================================================================

export const taskPanelWidget: IWallpaperWidgetDefinition = {
  id: 'task-panel',
  name: '桌面任务面板',
  priority: 5,
  zone: 'overlay',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    return true
  },
  Component: TaskPanelContainer,
}
