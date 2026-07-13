/**
 * WorkflowStatusWidget — 工作流状态桌面指示器
 *
 * 在桌面 Overlay 上实时显示长时间运行工作流（Agent/WorkflowScheduler）的状态。
 *
 * 功能：
 * 1. 订阅 workflow IPC 事件，显示运行中的工作流及其进度
 * 2. 进度条和阶段标记（step dots）
 * 3. 中断检测：超过 60s 无步骤更新时指示灯变红
 * 4. 显示"恢复中"或上次检查点时间
 * 5. 用户可点击展开详细视图（各步骤状态列表）
 * 6. 专注模式自动隐藏
 */

import React, { useState, useEffect, useRef } from 'react'
import type { IWallpaperWidgetDefinition, WallpaperWidgetContext } from '../types'

// =============================================================================
// 类型定义
// =============================================================================

interface WorkflowStepStatus {
  stepId: string
  name?: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  error?: string
  startedAt?: number
  completedAt?: number
  agentResult?: string
}

interface WorkflowRun {
  runId: string
  workflowDefId: string
  workflowName: string
  status: string
  steps: WorkflowStepStatus[]
  startedAt: number
  completedAt?: number
}

interface CheckpointInfo {
  time: number
  trigger: string
}

// =============================================================================
// 常量
// =============================================================================

/** 中断判定阈值：超过此毫秒数无步骤更新视为中断 */
const STALL_THRESHOLD_MS = 60_000

/** 阶段颜色映射 */
const STEP_COLORS: Record<string, string> = {
  pending: '#555',
  running: '#60a5fa',
  done: '#22c55e',
  failed: '#ef4444',
  skipped: '#a78bfa',
}

const STEP_ICONS: Record<string, string> = {
  running: '◉',
  done: '✓',
  failed: '✗',
  skipped: '→',
  pending: '○',
}

/** 阶段中文标签 */
const STEP_LABELS: Record<string, string> = {
  pending: '等待',
  running: '运行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
}

/** 工作流状态中文映射 */
const RUN_STATUS_LABELS: Record<string, string> = {
  running: '运行中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

// =============================================================================
// 辅助组件
// =============================================================================

/** 单步状态行（展开详情时使用） */
function StepRow({ step, index, isLatest }: { step: WorkflowStepStatus; index: number; isLatest: boolean }) {
  const color = STEP_COLORS[step.status] || '#888'
  const icon = STEP_ICONS[step.status] || '•'
  const label = STEP_LABELS[step.status] || step.status
  const name = step.name || step.stepId

  return (
    <div
      className={`wp-wf-step-row${isLatest ? ' wp-wf-step-latest' : ''}`}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <span className="wp-wf-step-icon" style={{ color }} title={label}>
        {icon}
      </span>
      <span className="wp-wf-step-name" title={name}>
        {name}
      </span>
      <span className="wp-wf-step-badge" style={{ background: color }}>
        {label}
      </span>
      {step.status === 'failed' && step.error && (
        <span className="wp-wf-step-error" title={step.error}>!</span>
      )}
    </div>
  )
}

/** 进度条 */
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

/** 阶段标记点 — 在迷你进度条下方显示步骤节点 */
function PhaseDots({ steps }: { steps: WorkflowStepStatus[] }) {
  if (steps.length === 0) return null

  return (
    <div className="wp-wf-phases">
      {steps.map((step) => {
        const color = STEP_COLORS[step.status] || '#555'
        const isRunning = step.status === 'running'
        return (
          <div
            key={step.stepId}
            className={`wp-wf-phase-dot${isRunning ? ' wp-wf-phase-running' : ''}`}
            style={{ background: color }}
            title={`${step.name || step.stepId}: ${STEP_LABELS[step.status] || step.status}`}
          />
        )
      })}
    </div>
  )
}

// =============================================================================
// 主组件
// =============================================================================

function WorkflowStatusPanel({ hideDecoration }: WallpaperWidgetContext) {
  // ── 状态 ──
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [expanded, setExpanded] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [lastActivity, setLastActivity] = useState<number>(Date.now())
  const [checkpoint, setCheckpoint] = useState<CheckpointInfo | null>(null)
  const [detailRunId, setDetailRunId] = useState<string | null>(null)

  // Refs for timers
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
      const hasActiveRuns = runs.some((r) => r.status === 'running')
      if (hasActiveRuns && elapsed > STALL_THRESHOLD_MS) {
        setStalled(true)
      } else {
        setStalled(false)
      }
    }, 5_000)

    return () => {
      if (stallTimerRef.current) {
        clearInterval(stallTimerRef.current)
        stallTimerRef.current = null
      }
    }
  }, [runs, lastActivity])

  // ── 订阅 workflow 创建事件 ──
  useEffect(() => {
    const unsub = window.electronAPI.onWorkflowRunCreated((data) => {
      setRuns((prev) => {
        if (prev.some((r) => r.runId === data.runId)) return prev
        const newRun: WorkflowRun = {
          runId: data.runId,
          workflowDefId: data.workflowDefId,
          workflowName: data.workflowDefId,
          status: 'running',
          steps: [],
          startedAt: Date.now(),
        }
        return [newRun, ...prev].slice(0, 5)
      })
      setLastActivity(Date.now())
      setStalled(false)
    })
    return unsub
  }, [])

  // ── 订阅 workflow 更新事件 ──
  useEffect(() => {
    const unsub = window.electronAPI.onWorkflowRunUpdated((data) => {
      setRuns((prev) =>
        prev.map((r) =>
          r.runId !== data.runId
            ? r
            : { ...r, status: data.status, completedAt: data.status !== 'running' ? Date.now() : undefined },
        ),
      )
      setLastActivity(Date.now())
      setStalled(false)
    })
    return unsub
  }, [])

  // ── 订阅 workflow 步骤事件 ──
  useEffect(() => {
    const unsub = window.electronAPI.onWorkflowRunStep((data) => {
      setRuns((prev) =>
        prev.map((r) => {
          if (r.runId !== data.runId) return r
          const now = Date.now()
          const existingIdx = r.steps.findIndex((s) => s.stepId === data.stepId)
          const newSteps: WorkflowStepStatus[] =
            existingIdx >= 0
              ? r.steps.map((s, i) =>
                  i !== existingIdx
                    ? s
                    : {
                        ...s,
                        status: data.status as WorkflowStepStatus['status'],
                        error: data.status === 'failed' ? (data as any).error : undefined,
                        agentResult: data.status === 'done' ? (data as any).agentResult : undefined,
                        completedAt: ['done', 'failed', 'skipped'].includes(data.status) ? now : undefined,
                      },
                )
              : [
                  ...r.steps,
                  {
                    stepId: data.stepId,
                    name: (data as any).name || data.stepId,
                    status: data.status as WorkflowStepStatus['status'],
                    startedAt: now,
                    completedAt: ['done', 'failed', 'skipped'].includes(data.status) ? now : undefined,
                  },
                ]
          return { ...r, steps: newSteps }
        }),
      )
      setLastActivity(Date.now())
      setStalled(false)
    })
    return unsub
  }, [])

  // ── 订阅监控指标（获取进程/计划数据及中断恢复信息） ──
  useEffect(() => {
    const unsub = window.electronAPI.onMonitoringMetrics((data) => {
      // 从监控数据中检查计划进度，作为辅助工作流信息
      if (data.plan?.hasActivePlan) {
        // 检查是否有活跃工作流，没有则用计划信息作为补充
        setRuns((prev) => {
          const hasWorkflowRun = prev.some((r) => r.status === 'running')
          if (hasWorkflowRun) return prev
          return prev
        })
      }
    })
    return unsub
  }, [])

  // ── 从主进程查询活跃运行（初始加载） ──
  useEffect(() => {
    const loadActiveRuns = async () => {
      try {
        const runList = await window.electronAPI.listWorkflowRuns(10)
        const active = runList.filter((r) => r.status === 'running' || r.status === 'paused')
        if (active.length > 0) {
          setRuns(
            active.slice(0, 5).map((r) => ({
              runId: r.runId,
              workflowDefId: r.workflowDefId,
              workflowName: r.workflowName || r.workflowDefId,
              status: r.status,
              steps: (r.steps || []).map((s) => ({
                stepId: s.stepId,
                name: s.name || s.stepId,
                status: s.status as WorkflowStepStatus['status'],
                error: s.error,
                startedAt: s.startedAt,
                completedAt: s.completedAt,
                agentResult: s.agentResult,
              })),
              startedAt: r.startedAt || Date.now(),
              completedAt: r.completedAt,
            })),
          )
        }
      } catch {}
    }
    loadActiveRuns()
  }, [])

  // ── 检查状态：是否有活跃运行 ──
  const activeRuns = runs.filter((r) => r.status === 'running' || r.status === 'paused')
  const hasActive = activeRuns.length > 0

  // ── 焦点模式隐藏 ──
  if (hideDecoration) return null

  // ── 空状态 ──
  if (runs.length === 0) {
    return null
  }

  // ── 聚合所有活跃运行的步骤 ──
  const allSteps = activeRuns.flatMap((r) => r.steps)
  const doneSteps = allSteps.filter((s) => s.status === 'done').length
  const totalSteps = allSteps.length
  const overallPercent = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0
  const currentStep = activeRuns.length === 1
    ? activeRuns[0].steps.find((s) => s.status === 'running')
    : null

  // ── 格式化时间 ──
  const fmtTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
  }

  const fmtElapsed = (ms: number) => {
    if (!ms || ms < 0) return ''
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
    if (m > 0) return `${m}m ${s % 60}s`
    return `${s}s`
  }

  return (
    <div className="wp-wf-panel">
      {/* ── 标题栏 ── */}
      <div
        className="wp-wf-header"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded(!expanded) }}
      >
        <div className="wp-wf-header-left">
          {/* 中断/健康指示灯 */}
          <span
            className={`wp-wf-indicator${stalled ? ' wp-wf-indicator-stalled' : hasActive ? ' wp-wf-indicator-active' : ' wp-wf-indicator-idle'}`}
            title={stalled ? '工作流可能已中断' : hasActive ? '工作流运行中' : '空闲'}
          />
          <span className="wp-wf-title">
            {stalled ? '⏸ 工作流中断' : hasActive ? '⚡ 工作流' : '📋 工作流'}
          </span>
        </div>
        <div className="wp-wf-header-right">
          {hasActive && (
            <span className="wp-wf-percent">{overallPercent}%</span>
          )}
          <span className="wp-wf-expand-icon">
            {expanded ? '▾' : '▸'}
          </span>
        </div>
      </div>

      {/* ── 活跃工作流摘要 ── */}
      {hasActive && !expanded && (
        <>
          {/* 进度条 */}
          <ProgressBar percent={overallPercent} color={stalled ? '#ef4444' : undefined} />

          {/* 阶段标记点 */}
          {activeRuns.length === 1 && activeRuns[0].steps.length > 0 && (
            <PhaseDots steps={activeRuns[0].steps} />
          )}

          {/* 当前步骤 + 统计 */}
          <div className="wp-wf-summary">
            {stalled ? (
              <div className="wp-wf-stalled-info">
                <span className="wp-wf-stalled-icon">⚠</span>
                <span className="wp-wf-stalled-text">
                  最后活动: {fmtTime(lastActivity)}
                </span>
                {checkpoint && (
                  <span className="wp-wf-checkpoint">
                    检查点: {fmtTime(checkpoint.time)}
                  </span>
                )}
              </div>
            ) : currentStep ? (
              <div className="wp-wf-current">
                <span className="wp-wf-current-dot" />
                <span className="wp-wf-current-name" title={currentStep.name || currentStep.stepId}>
                  {currentStep.name || currentStep.stepId}
                </span>
              </div>
            ) : (
              <div className="wp-wf-stats">
                <span className="wp-wf-stat">
                  {doneSteps}/{totalSteps} 步
                </span>
                {allSteps.filter((s) => s.status === 'failed').length > 0 && (
                  <span className="wp-wf-stat wp-wf-stat-fail">
                    失败 {allSteps.filter((s) => s.status === 'failed').length}
                  </span>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── 多工作流摘要（展开前显示运行数量） ── */}
      {hasActive && !expanded && activeRuns.length > 1 && (
        <div className="wp-wf-run-count">
          共 {activeRuns.length} 个工作流运行中
        </div>
      )}

      {/* ── 空状态消息 ── */}
      {!hasActive && !expanded && runs.length > 0 && (
        <div className="wp-wf-idle-note">
          {runs.filter((r) => r.status === 'done').length > 0
            ? `上次完成: ${runs.length} 个工作流`
            : '所有工作流已完成'}
        </div>
      )}

      {/* ── 展开详细视图 ── */}
      {expanded && (
        <div className="wp-wf-detail">
          {runs.map((run) => {
            const runDone = run.steps.filter((s) => s.status === 'done').length
            const runTotal = run.steps.length
            const runPct = runTotal > 0 ? Math.round((runDone / runTotal) * 100) : 0
            const isExpanded = detailRunId === run.runId
            const elapsed = run.startedAt ? Date.now() - run.startedAt : 0

            return (
              <div
                key={run.runId}
                className={`wp-wf-run-detail${run.status === 'running' ? ' wp-wf-run-active' : ''}${run.status === 'failed' ? ' wp-wf-run-failed' : ''}`}
              >
                {/* 工作流头部 */}
                <div
                  className="wp-wf-run-header"
                  onClick={() => setDetailRunId(isExpanded ? null : run.runId)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setDetailRunId(isExpanded ? null : run.runId) }}
                >
                  <div className="wp-wf-run-title-group">
                    <span className="wp-wf-run-name">{run.workflowName}</span>
                    <span className={`wp-wf-run-badge wp-wf-run-badge-${run.status}`}>
                      {RUN_STATUS_LABELS[run.status] || run.status}
                    </span>
                  </div>
                  <div className="wp-wf-run-meta">
                    {elapsed > 0 && run.status === 'running' && (
                      <span className="wp-wf-run-elapsed">{fmtElapsed(elapsed)}</span>
                    )}
                    <span className="wp-wf-run-pct">{runPct}%</span>
                    <span className="wp-wf-expand-icon">
                      {isExpanded ? '▾' : '▸'}
                    </span>
                  </div>
                </div>

                {/* 工作流进度条 */}
                <ProgressBar percent={runPct} />

                {/* 阶段标记点 */}
                {run.steps.length > 0 && <PhaseDots steps={run.steps} />}

                {/* 步骤列表（展开时） */}
                {isExpanded && run.steps.length > 0 && (
                  <div className="wp-wf-step-list">
                    {run.steps.map((step, i) => (
                      <StepRow
                        key={step.stepId}
                        step={step}
                        index={i}
                        isLatest={i === run.steps.length - 1 && step.status === 'running'}
                      />
                    ))}
                  </div>
                )}

                {/* 空步骤提示 */}
                {isExpanded && run.steps.length === 0 && (
                  <div className="wp-wf-step-empty">等待步骤数据…</div>
                )}
              </div>
            )
          })}

          {/* 初始加载提示 */}
          {runs.length === 0 && (
            <div className="wp-wf-step-empty">等待工作流数据…</div>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Widget 定义
// =============================================================================

export const workflowStatusWidget: IWallpaperWidgetDefinition = {
  id: 'workflow-status',
  name: '工作流状态',
  priority: 25,
  zone: 'overlay',
  shouldShow: (ctx) => {
    if (ctx.hideDecoration) return false
    return true // 始终监听，内部通过 null 状态控制显示
  },
  Component: WorkflowStatusPanel,
}
