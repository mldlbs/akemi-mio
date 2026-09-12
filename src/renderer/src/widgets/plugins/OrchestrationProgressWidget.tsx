/**
 * OrchestrationProgressWidget — 工具链编排进度桌面指示器
 *
 * 在壁纸 Overlay 上实时显示工具链编排（ToolChainOrchestrator）的执行进度。
 *
 * 功能：
 * 1. 订阅 orchestration:progress IPC 事件，显示编排计划及其步骤进度
 * 2. 进度条和步骤状态标记（step dots）
 * 3. 展开查看详细步骤列表（名称、工具、状态）
 * 4. 自动折叠已完成的编排
 * 5. 中断检测：超过 120s 无更新时指示灯变红
 *
 * 区：overlay（在主面板下方浮动显示）
 * 优先级：26（紧挨 WorkflowStatusWidget 的 25）
 */

import React, { useState, useEffect, useRef } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 类型定义
// =============================================================================

interface StepStatus {
  id: string
  name: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
  toolName: string
}

interface OrchestrationProgressData {
  type: string
  planId: string
  stepId?: string
  stepName?: string
  completedSteps: number
  totalSteps: number
  percent: number
  message: string
  error?: string
  timestamp: number
  stepStatuses: StepStatus[]
}

// =============================================================================
// 常量
// =============================================================================

/** 中断判定阈值 */
const STALL_THRESHOLD_MS = 120_000

const STEP_COLORS: Record<string, string> = {
  pending: '#555',
  running: '#60a5fa',
  success: '#22c55e',
  failed: '#ef4444',
  skipped: '#a78bfa',
}

const STEP_ICONS: Record<string, string> = {
  running: '◉',
  success: '✓',
  failed: '✗',
  skipped: '→',
  pending: '○',
}

const STEP_LABELS: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  success: '完成',
  failed: '失败',
  skipped: '跳过',
}

// =============================================================================
// 子组件
// =============================================================================

function StepRow({ step, index, isLatest }: { step: StepStatus; index: number; isLatest: boolean }) {
  const color = STEP_COLORS[step.status] || '#888'
  const icon = STEP_ICONS[step.status] || '•'
  const label = STEP_LABELS[step.status] || step.status
  const toolHint = step.toolName ? ` (${step.toolName})` : ''

  return (
    <div className={`wp-wf-step-row${isLatest ? ' wp-wf-step-latest' : ''}`} style={{ animationDelay: `${index * 30}ms` }}>
      <span className="wp-wf-step-icon" style={{ color }} title={label}>
        {icon}
      </span>
      <span className="wp-wf-step-name" title={`${step.name}${toolHint}`}>
        {step.name}
        {toolHint}
      </span>
      <span className="wp-wf-step-badge" style={{ background: color }}>
        {label}
      </span>
    </div>
  )
}

function ProgressBar({ percent, color }: { percent: number; color?: string }) {
  return (
    <div className="wp-wf-progress-track">
      <div
        className="wp-wf-progress-fill"
        style={{
          width: `${Math.max(2, percent)}%`,
          background: color || undefined,
        }}
      />
    </div>
  )
}

function PhaseDots({ steps }: { steps: StepStatus[] }) {
  if (steps.length === 0) return null

  return (
    <div className="wp-wf-phases">
      {steps.map((step) => {
        const color = STEP_COLORS[step.status] || '#555'
        const isRunning = step.status === 'running'
        return (
          <div
            key={step.id}
            className={`wp-wf-phase-dot${isRunning ? ' wp-wf-phase-running' : ''}`}
            style={{ background: color }}
            title={`${step.name}: ${STEP_LABELS[step.status] || step.status}`}
          />
        )
      })}
    </div>
  )
}

// =============================================================================
// 主组件
// =============================================================================

function OrchestrationProgressPanel({ hideDecoration }: WallpaperWidgetContext) {
  const [progress, setProgress] = useState<OrchestrationProgressData | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [lastActivity, setLastActivity] = useState<number>(Date.now())

  const stallTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastActivityRef = useRef<number>(Date.now())

  // ── 中断检测定时器 ──
  useEffect(() => {
    lastActivityRef.current = lastActivity

    if (stallTimerRef.current) {
      clearInterval(stallTimerRef.current)
    }

    stallTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current
      const isRunning = progress?.type === 'step_started' || progress?.type === 'plan_created'
      if (isRunning && elapsed > STALL_THRESHOLD_MS) {
        setStalled(true)
      } else {
        setStalled(false)
      }
    }, 10_000)

    return () => {
      if (stallTimerRef.current) {
        clearInterval(stallTimerRef.current)
        stallTimerRef.current = null
      }
    }
  }, [progress, lastActivity])

  // ── 订阅 orchestration:progress 事件 ──
  useEffect(() => {
    // 监听事件总线上的编排进度事件
    // 通过 window.electronAPI 上的 onOrchestrationProgress 接收
    if (window.electronAPI?.onOrchestrationProgress) {
      const unsub = window.electronAPI.onOrchestrationProgress((data: OrchestrationProgressData) => {
        setProgress(data)
        setLastActivity(Date.now())
        setStalled(false)

        // 编排完成或失败后自动折叠
        if (data.type === 'orchestration_completed' || data.type === 'orchestration_failed') {
          const timer = setTimeout(() => setExpanded(false), 5000)
          return () => clearTimeout(timer)
        }
      })
      return unsub
    }
  }, [])

  // ── 焦点模式隐藏 ──
  if (hideDecoration) return null

  // ── 无活跃编排时隐藏 ──
  if (!progress) return null

  // 编排完成后 30 秒自动隐藏
  const isCompleted = progress.type === 'orchestration_completed' || progress.type === 'orchestration_failed'
  const isRunning = progress.type === 'step_started' || progress.type === 'plan_created'

  if (isCompleted && Date.now() - progress.timestamp > 30_000) return null

  const stepList = progress.stepStatuses || []
  const doneSteps = stepList.filter((s) => s.status === 'success').length
  const failedSteps = stepList.filter((s) => s.status === 'failed').length
  const currentStep = stepList.find((s) => s.status === 'running')

  const indicatorClass = stalled
    ? 'wp-wf-indicator-stalled'
    : isRunning
      ? 'wp-wf-indicator-active'
      : isCompleted
        ? 'wp-wf-indicator-idle'
        : ''
  const titleIcon = stalled ? '⏸' : isRunning ? '⚡' : isCompleted ? '✅' : '📋'
  const titleText = stalled ? '编排中断' : isRunning ? '工具链编排' : '编排完成'

  return (
    <div className="wp-wf-panel">
      {/* ── 标题栏 ── */}
      <div
        className="wp-wf-header"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setExpanded(!expanded)
        }}
      >
        <div className="wp-wf-header-left">
          <span className={`wp-wf-indicator ${indicatorClass}`} />
          <span className="wp-wf-title">
            {titleIcon} {titleText}
          </span>
        </div>
        <div className="wp-wf-header-right">
          {isRunning && <span className="wp-wf-percent">{progress.percent}%</span>}
          <span className="wp-wf-expand-icon">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {/* ── 折叠状态：进度条 + 当前步骤 ── */}
      {!expanded && (
        <>
          <ProgressBar percent={progress.percent} color={stalled ? '#ef4444' : failedSteps > 0 ? '#f59e0b' : undefined} />
          {stepList.length > 0 && <PhaseDots steps={stepList} />}
          <div className="wp-wf-summary">
            {stalled ? (
              <div className="wp-wf-stalled-info">
                <span className="wp-wf-stalled-icon">⚠</span>
                <span className="wp-wf-stalled-text">编排可能已中断</span>
              </div>
            ) : currentStep ? (
              <div className="wp-wf-current">
                <span className="wp-wf-current-dot" />
                <span className="wp-wf-current-name">{currentStep.name}</span>
              </div>
            ) : (
              <div className="wp-wf-stats">
                <span className="wp-wf-stat">
                  {doneSteps}/{stepList.length} 步
                </span>
                {failedSteps > 0 && <span className="wp-wf-stat wp-wf-stat-fail">失败 {failedSteps}</span>}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── 展开详细视图 ── */}
      {expanded && (
        <div className="wp-wf-detail">
          <div className="wp-wf-run-detail wp-wf-run-active">
            <div className="wp-wf-run-header">
              <div className="wp-wf-run-title-group">
                <span className="wp-wf-run-name">编排计划</span>
                <span className="wp-wf-run-badge wp-wf-run-badge-running">{isCompleted ? '已完成' : isRunning ? '运行中' : '等待'}</span>
              </div>
              <div className="wp-wf-run-meta">
                <span className="wp-wf-run-pct">{progress.percent}%</span>
              </div>
            </div>
            <ProgressBar percent={progress.percent} />
            {/* 步骤列表 */}
            {stepList.length > 0 ? (
              <div className="wp-wf-step-list">
                {stepList.map((step, i) => (
                  <StepRow key={step.id} step={step} index={i} isLatest={step.status === 'running'} />
                ))}
              </div>
            ) : (
              <div className="wp-wf-step-empty">等待步骤数据…</div>
            )}
            {progress.error && (
              <div className="wp-wf-step-empty" style={{ color: '#ef4444' }}>
                错误: {progress.error}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const orchestrationProgressWidget: IWallpaperWidgetDefinition = {
  id: 'orchestration-progress',
  name: '编排进度',
  priority: 26,
  zone: 'overlay',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    return true
  },
  Component: OrchestrationProgressPanel,
}
