import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { WorkflowEditor } from './WorkflowEditor'
import { ErrorBoundary } from './ErrorBoundary'
import { useWorkflowStore } from '../store/workflowStore'
import { useClockStore } from '../store/clockStore'
import { useIPCEvent } from '../hooks/useIPCEvent'
import { isWorkflowActive } from '../workflow/workflowTypes'
import type { StepRun } from '../workflow/workflowTypes'

type ViewMode = 'list' | 'editor'
type HistoryFilter = 'all' | 'done' | 'failed'
type WfPage = 'defs' | 'running' | 'done'

function stageIcon(status: string): string {
  switch (status) {
    case 'done':
      return 'ri-check-line'
    case 'running':
    case 'in_progress':
      return 'ri-loader-4-line ri-spin'
    case 'failed':
      return 'ri-close-circle-line'
    default:
      return 'ri-circle-line'
  }
}

function stageColor(status: string): string {
  switch (status) {
    case 'done':
      return 'wf-step-done'
    case 'running':
    case 'in_progress':
      return 'wf-step-running'
    case 'failed':
      return 'wf-step-failed'
    default:
      return 'wf-step-pending'
  }
}

function handlerIcon(handler: string): string {
  switch (handler) {
    case 'subagent':
      return 'ri-robot-2-line'
    case 'prompt':
      return 'ri-question-mark'
    case 'tool':
      return 'ri-tools-line'
    case 'api':
      return 'ri-api-line'
    case 'plan':
      return 'ri-file-list-3-line'
    case 'condition':
      return 'ri-git-branch-line'
    case 'foreach':
      return 'ri-loop-left-line'
    case 'transform':
      return 'ri-exchange-2-line'
    case 'gate':
      return 'ri-lock-2-line'
    case 'aggregate':
      return 'ri-folder-5-line'
    case 'subflow':
      return 'ri-organization-chart'
    case 'wait':
      return 'ri-timer-line'
    case 'script':
      return 'ri-terminal-box-line'
    case 'event':
      return 'ri-notification-3-line'
    default:
      return 'ri-circle-line'
  }
}

function handlerClass(handler: string): string {
  switch (handler) {
    case 'subagent':
      return 'wf-handler-subagent'
    case 'prompt':
      return 'wf-handler-prompt'
    case 'tool':
      return 'wf-handler-tool'
    case 'api':
      return 'wf-handler-api'
    case 'plan':
      return 'wf-handler-plan'
    case 'condition':
      return 'wf-handler-condition'
    case 'foreach':
      return 'wf-handler-foreach'
    case 'transform':
      return 'wf-handler-transform'
    case 'gate':
      return 'wf-handler-gate'
    case 'aggregate':
      return 'wf-handler-aggregate'
    case 'subflow':
      return 'wf-handler-subflow'
    case 'wait':
      return 'wf-handler-wait'
    case 'script':
      return 'wf-handler-script'
    case 'event':
      return 'wf-handler-event'
    default:
      return ''
  }
}

function handlerLabel(handler: string): string {
  switch (handler) {
    case 'subagent':
      return 'Agent'
    case 'prompt':
      return 'Prompt'
    case 'tool':
      return 'Tool'
    case 'api':
      return 'API'
    case 'plan':
      return 'Plan'
    case 'condition':
      return '条件'
    case 'foreach':
      return '循环'
    case 'transform':
      return '变换'
    case 'gate':
      return '审批'
    case 'aggregate':
      return '聚合'
    case 'subflow':
      return '子流程'
    case 'wait':
      return '等待'
    case 'script':
      return '脚本'
    case 'event':
      return '事件'
    default:
      return handler
  }
}

function MiniDag({ steps }: { steps: any[] }) {
  const NODE_W = 96
  const NODE_H = 40
  const GAP_X = 20
  const GAP_Y = 26
  const COLS = 3
  const PAD_TOP = 8
  if (!steps || steps.length === 0) return <span className="wf-mini-empty">暂无步骤</span>
  const rows = Math.ceil(steps.length / COLS)
  const totalW = COLS * NODE_W + (COLS - 1) * GAP_X
  const totalH = PAD_TOP + rows * NODE_H + (rows - 1) * GAP_Y
  const pos = (i: number) => ({
    x: (i % COLS) * (NODE_W + GAP_X),
    y: PAD_TOP + Math.floor(i / COLS) * (NODE_H + GAP_Y),
  })
  const shortName = (n: string, i: number) => {
    const base = n || '步骤' + (i + 1)
    return base.length > 9 ? base.slice(0, 8) + '?' : base
  }
  const edgePath = (i: number) => {
    const a = pos(i)
    const b = pos(i + 1)
    const cy1 = a.y + NODE_H / 2
    const cy2 = b.y + NODE_H / 2
    if (b.y === a.y) {
      const x1 = a.x + NODE_W
      const x2 = b.x
      const mid = (x1 + x2) / 2
      return 'M ' + x1 + ' ' + cy1 + ' C ' + mid + ' ' + cy1 + ', ' + mid + ' ' + cy2 + ', ' + x2 + ' ' + cy2
    }
    const x1 = a.x + NODE_W
    const elbowY = a.y + NODE_H + GAP_Y / 2
    return (
      'M ' +
      x1 +
      ' ' +
      cy1 +
      ' C ' +
      (x1 + 8) +
      ' ' +
      cy1 +
      ', ' +
      (x1 + 8) +
      ' ' +
      elbowY +
      ', ' +
      x1 +
      ' ' +
      elbowY +
      ' L ' +
      b.x +
      ' ' +
      elbowY +
      ' L ' +
      b.x +
      ' ' +
      cy2
    )
  }
  return (
    <div className="wf-mini-dag">
      <svg className="wf-mini-dag-svg" viewBox={'0 0 ' + totalW + ' ' + totalH} preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="wf-mini-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="wf-mini-dag-arrow" />
          </marker>
        </defs>
        {steps.slice(0, -1).map((s: any, i: number) => (
          <path key={s.id} d={edgePath(i)} className="wf-mini-dag-edge" markerEnd="url(#wf-mini-arrow)" />
        ))}
        {steps.map((s: any, i: number) => {
          const p = pos(i)
          const handler = s.handler || 'subagent'
          return (
            <g
              key={s.id}
              className={'wf-mini-dag-node wf-handler-' + handler + (s.runOn === 'failure' ? ' on-failure' : '')}
              transform={'translate(' + p.x + ', ' + p.y + ')'}
            >
              <title>{s.name || '步骤' + (i + 1)}</title>
              <rect x="0.75" y="0.75" width={NODE_W - 1.5} height={NODE_H - 1.5} rx="9" className="wf-mini-dag-node-bg" />
              <rect x="0" y="7" width="3" height={NODE_H - 14} rx="1.5" className="wf-mini-dag-node-bar" />
              <circle cx="0" cy={NODE_H / 2} r="3.4" className="wf-mini-dag-port" />
              <circle cx={NODE_W} cy={NODE_H / 2} r="3.4" className="wf-mini-dag-port" />
              <text x="14" y={NODE_H / 2 - 5} className="wf-mini-dag-name">
                {shortName(s.name, i)}
              </text>
              <text x="14" y={NODE_H / 2 + 11} className="wf-mini-dag-label">
                {handlerLabel(s.handler)}
              </text>
              {s.runOn === 'failure' && (
                <g className="wf-mini-dag-fail">
                  <rect x={NODE_W - 40} y="-6" width="40" height="14" rx="7" className="wf-mini-dag-fail-bg" />
                  <text x={NODE_W - 20} y="4.5" textAnchor="middle" className="wf-mini-dag-fail-text">
                    失败时
                  </text>
                </g>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function WorkflowSlot() {
  const store = useWorkflowStore()
  const workflowDefs = store.definitions
  const workflowRuns = store.workflowRuns
  const workflowActiveRuns = store.workflowRuns.filter((r) => r.status === 'running' || r.status === 'paused')
  const wfLoading = store.loading

  const refreshDefs = useCallback(() => {
    Promise.all([window.electronAPI.listWorkflowDefinitions(), window.electronAPI.listWorkflowRuns(20)]).then(([defs, runList]) => {
      store.setDefinitions(defs)
      store.setLoading(false)
      for (const run of runList) {
        const steps: StepRun[] = (run.steps || []).map((s: any) => {
          if (s.status === 'running' || s.status === 'in_progress')
            return { status: 'running', stepId: s.stepId, startedAt: s.startedAt ?? Date.now() }
          if (s.status === 'done' || s.status === 'completed')
            return {
              status: 'done',
              stepId: s.stepId,
              startedAt: s.startedAt ?? Date.now(),
              endedAt: s.completedAt ?? Date.now(),
              agentResult: s.agentResult,
            }
          if (s.status === 'failed')
            return {
              status: 'failed',
              stepId: s.stepId,
              startedAt: s.startedAt ?? Date.now(),
              endedAt: s.completedAt ?? Date.now(),
              error: s.error,
            }
          if (s.status === 'skipped')
            return { status: 'skipped', stepId: s.stepId, startedAt: s.startedAt ?? Date.now(), endedAt: s.completedAt ?? Date.now() }
          return { status: 'pending', stepId: s.stepId }
        })
        store.addWorkflowEvent({
          type: 'workflow.created',
          runId: run.runId,
          workflowDefId: run.workflowDefId,
          workflowName: run.workflowName || '',
          steps,
          timestamp: run.startedAt || Date.now(),
        })
      }
    })
  }, [store])

  useEffect(() => {
    if (wfLoading) refreshDefs()
  }, [wfLoading, refreshDefs])

  const [page, setPage] = useState<WfPage>('defs')
  const [view, setView] = useState<ViewMode>('list')
  const [editDef, setEditDef] = useState<any | null>(null)
  const [focusStepId, setFocusStepId] = useState<string | null>(null)
  const now = useClockStore((s) => s.now)
  const [runError, setRunError] = useState('')
  const [runSuccess, setRunSuccess] = useState('')

  // ── Search ──
  const [searchQuery, setSearchQuery] = useState('')

  // ── Pipeline log ──
  const [pipelineLogs, setPipelineLogs] = useState<Record<string, string[]>>({})
  const logBodyRef = useRef<HTMLDivElement>(null)

  // ── History ──
  const [historyExpandedRun, setHistoryExpandedRun] = useState<string | null>(null)
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all')

  // ── 停用工作流折叠 ──
  const [showDisabled, setShowDisabled] = useState(false)

  // Auto-scroll log only if user hasn't scrolled up
  useEffect(() => {
    const el = logBodyRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [pipelineLogs])

  // 活跃工作流计时器 — 使用全局 ClockStore
  const hasActive = workflowActiveRuns.length > 0
  const startTime = useMemo(() => {
    if (!hasActive) return 0
    const earliest = Math.min(...workflowActiveRuns.map((r: any) => r.startedAt || Date.now()))
    return earliest
  }, [hasActive, workflowActiveRuns])

  const elapsed = hasActive && startTime > 0 ? now - startTime : 0

  // 收集 pipeline 实时日志 — 从步骤事件直接累积，不掉帧
  useIPCEvent(window.electronAPI?.onWorkflowRunStep, (data) => {
    // 同 WorkflowEditor：收窄不会穿透到 updater 闭包，先捕获为局部常量。
    const agentResult = data.agentResult
    if (!agentResult) return
    setPipelineLogs((prev) => {
      const lines = prev[data.runId] ?? []
      const last = lines[lines.length - 1]
      if (last === agentResult) return prev
      return { ...prev, [data.runId]: [...lines, agentResult].slice(-100) }
    })
  })

  // 2秒后自动清除成功/失败提示
  useEffect(() => {
    if (!runSuccess) return
    const t = setTimeout(() => setRunSuccess(''), 2500)
    return () => clearTimeout(t)
  }, [runSuccess])

  const filteredDefs = useMemo(() => {
    if (!searchQuery.trim()) return workflowDefs
    const q = searchQuery.toLowerCase()
    return workflowDefs.filter((d) => d.name?.toLowerCase().includes(q) || d.description?.toLowerCase().includes(q))
  }, [workflowDefs, searchQuery])

  const historyRuns = useMemo(() => {
    const completed = workflowRuns.filter((r: any) => r.status !== 'running' && r.status !== 'paused')
    if (historyFilter === 'all') return completed
    return completed.filter((r: any) => r.status === historyFilter)
  }, [workflowRuns, historyFilter])

  // Preset templates to suggest when empty
  const presets = useMemo(() => {
    if (workflowDefs.length > 0) return []
    return [
      { id: 'dev-pipeline-simple', name: '开发流水线·简', description: '代码审查 → 构建 → 部署', steps: 3, icon: 'ri-code-line' },
      {
        id: 'dev-pipeline-medium',
        name: '开发流水线·中',
        description: '需求分析 → 设计 → 编码 → 审查 → 部署',
        steps: 5,
        icon: 'ri-code-box-line',
      },
      { id: 'writing-pipeline', name: '写作流水线', description: '选题 → 大纲 → 写作 → 润色 → 发布', steps: 5, icon: 'ri-pen-nib-line' },
    ]
  }, [workflowDefs])

  const showPipeline = workflowActiveRuns.length > 0
  const historyCount = workflowRuns.filter((r: any) => r.status !== 'running' && r.status !== 'paused').length
  const showHistory = historyCount > 0

  // 按启用/禁用分组
  const enabledDefs = useMemo(() => filteredDefs.filter((d) => d.enabled !== false), [filteredDefs])
  const disabledDefs = useMemo(() => filteredDefs.filter((d) => d.enabled === false), [filteredDefs])

  function fmtElapsed(ms: number): string {
    if (!ms || ms < 0) return ''
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
    if (m > 0) return `${m}m ${s % 60}s`
    return `${s}s`
  }

  function fmtTime(ts: number): string {
    if (!ts) return ''
    const d = new Date(ts)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    const thisYear = d.getFullYear() === now.getFullYear()
    if (thisYear) return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  function openEditorAt(def: any, stepId: string) {
    setEditDef(def)
    setFocusStepId(stepId)
    setView('editor')
  }

  function syncStageFades(el: HTMLElement | null) {
    if (!el) return
    el.classList.toggle('is-scroll-left', el.scrollLeft > 2)
    el.classList.toggle('is-scroll-right', el.scrollLeft < el.scrollWidth - el.clientWidth - 2)
  }

  async function startRun(defId: string) {
    setRunError('')
    setRunSuccess('')
    const result = await window.electronAPI.startWorkflow(defId)
    if (result?.success) {
      setRunSuccess('工作流已启动')
      refreshDefs()
    } else {
      setRunError(result?.error ?? '启动失败')
    }
  }

  if (view === 'editor') {
    return (
      <WorkflowEditor
        initial={editDef}
        focusStepId={focusStepId ?? undefined}
        onBack={() => {
          setView('list')
          setEditDef(null)
          setFocusStepId(null)
        }}
        onSaved={() => refreshDefs()}
      />
    )
  }

  return (
    <div className="workflow-slot workflow-slot-content">
      <ErrorBoundary>
        {/* ── 三页签导航 ── */}
        <div className="wf-page-tabs" role="tablist" aria-label="工作流面板">
          <button
            className={`wf-page-tab${page === 'defs' ? ' active' : ''}`}
            onClick={() => setPage('defs')}
            role="tab"
            aria-selected={page === 'defs'}
            title="工作流定义列表"
          >
            <i className="ri-flow-chart" />
            <span>工作流</span>
            {workflowDefs.length > 0 && <span className="wf-page-count">{workflowDefs.length}</span>}
          </button>
          <button
            className={`wf-page-tab${page === 'running' ? ' active' : ''}`}
            onClick={() => setPage('running')}
            role="tab"
            aria-selected={page === 'running'}
            title="正在运行的工作流"
          >
            <i className="ri-loader-4-line" />
            <span>运行中</span>
            {workflowActiveRuns.length > 0 && <span className="wf-page-count live">{workflowActiveRuns.length}</span>}
          </button>
          <button
            className={`wf-page-tab${page === 'done' ? ' active' : ''}`}
            onClick={() => setPage('done')}
            role="tab"
            aria-selected={page === 'done'}
            title="已完成的运行记录"
          >
            <i className="ri-history-line" />
            <span>已完成</span>
            {historyCount > 0 && <span className="wf-page-count">{historyCount}</span>}
          </button>
        </div>

        {/* ── Action bar ── */}
        <div className="wf-action-bar">
          {page === 'defs' && (
            <div className="wf-search-box">
              <i className="ri-search-line" />
              <input
                className="wf-search-input"
                type="text"
                placeholder="搜索工作流…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="wf-search-clear" onClick={() => setSearchQuery('')}>
                  <i className="ri-close-line" />
                </button>
              )}
            </div>
          )}
          <button
            className="wf-editor-btn wf-editor-btn-add"
            onClick={() => {
              setEditDef(null)
              setFocusStepId(null)
              setView('editor')
            }}
          >
            <i className="ri-add-line" /> 新建工作流
          </button>
        </div>

        {/* ── 反馈条 ── */}
        {runError && (
          <div className="wf-editor-error">
            <i className="ri-alert-line" /> {runError}
          </div>
        )}
        {runSuccess && (
          <div className="wf-editor-success">
            <i className="ri-check-line" /> {runSuccess}
          </div>
        )}

        {/* ── 运行中的 pipeline ── */}
        {page === 'running' &&
          (workflowActiveRuns.length > 0 ? (
            workflowActiveRuns.map((run: any) => {
              const def = workflowDefs.find((d: any) => d.id === run.workflowDefId)
              const runSteps = run.steps.map((s: any) => {
                const stepDef = def?.steps.find((ds: any) => ds.id === s.stepId)
                return { ...s, name: stepDef?.name || s.stepId }
              })
              const runDone = runSteps.filter((s: any) => s.status === 'done').length
              const runTotal = runSteps.length
              const runPct = runTotal > 0 ? Math.round((runDone / runTotal) * 100) : 0
              const currentStep = runSteps.find((s: any) => s.status === 'running')
              const isRunning = run.status === 'running'
              const hasCurrentStep = !!currentStep
              const failedStep = runSteps.find((s: any) => s.status === 'failed')
              const focusTarget = failedStep?.stepId ?? currentStep?.stepId ?? runSteps[0]?.stepId
              const logs = pipelineLogs[run.runId] ?? []

              return (
                <section key={run.runId} className={`wf-pipeline${isRunning ? ' running' : ''}${failedStep ? ' failed' : ''}`}>
                  <div className="wf-pipeline-header">
                    <div className="wf-pipeline-icon">
                      <i className={isRunning ? 'ri-flask-line' : failedStep ? 'ri-close-circle-line' : 'ri-check-double-line'} />
                    </div>
                    <div
                      className="wf-pipeline-title-group"
                      onClick={() => def && focusTarget && openEditorAt(def, focusTarget)}
                      title="在画布中查看该流程"
                    >
                      <h4 className="wf-section-title" style={{ margin: 0 }}>
                        {run.workflowName}
                      </h4>
                      {isRunning && (
                        <span className="wf-pipeline-badge">
                          <i className="ri-loader-4-line ri-spin" /> 运行中
                        </span>
                      )}
                    </div>
                    <div className="wf-pipeline-header-right">
                      {def && focusTarget && (
                        <button className="wf-pipeline-canvas-btn" title="在画布中查看" onClick={() => openEditorAt(def, focusTarget)}>
                          <i className="ri-eye-line" /> 画布
                        </button>
                      )}
                      {isRunning && hasCurrentStep && (
                        <span className="wf-elapsed">
                          <i className="ri-time-line" /> {fmtElapsed(elapsed)}
                        </span>
                      )}
                      {isRunning && (
                        <button
                          className="wf-cancel-btn"
                          title="取消运行"
                          onClick={async () => {
                            const res = await window.electronAPI.stopWorkflowRun(run.runId)
                            if (!res.success) {
                              setRunError(res.error || '取消失败')
                              // 刷新列表消除状态不一致
                              const list = await window.electronAPI.listWorkflowRuns(20)
                              for (const r of list) {
                                const steps: StepRun[] = (r.steps || []).map((s: any) => {
                                  if (s.status === 'running' || s.status === 'in_progress')
                                    return { status: 'running', stepId: s.stepId, startedAt: s.startedAt ?? Date.now() }
                                  if (s.status === 'done' || s.status === 'completed')
                                    return {
                                      status: 'done',
                                      stepId: s.stepId,
                                      startedAt: s.startedAt ?? Date.now(),
                                      endedAt: s.completedAt ?? Date.now(),
                                      agentResult: s.agentResult,
                                    }
                                  if (s.status === 'failed')
                                    return {
                                      status: 'failed',
                                      stepId: s.stepId,
                                      startedAt: s.startedAt ?? Date.now(),
                                      endedAt: s.completedAt ?? Date.now(),
                                      error: s.error,
                                    }
                                  if (s.status === 'skipped')
                                    return {
                                      status: 'skipped',
                                      stepId: s.stepId,
                                      startedAt: s.startedAt ?? Date.now(),
                                      endedAt: s.completedAt ?? Date.now(),
                                    }
                                  return { status: 'pending', stepId: s.stepId }
                                })
                                store.addWorkflowEvent({
                                  type: 'workflow.created',
                                  runId: r.runId,
                                  workflowDefId: r.workflowDefId,
                                  workflowName: r.workflowName || '',
                                  steps,
                                  timestamp: r.startedAt || Date.now(),
                                })
                              }
                            }
                          }}
                        >
                          <i className="ri-stop-circle-line" /> 取消
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="wf-pipeline-progress-main">
                    <div className="wf-pipeline-progress-info">
                      <span className="wf-pipeline-step-label">
                        {isRunning && hasCurrentStep ? (
                          <>
                            <i className="ri-loader-4-line ri-spin" /> 第 {runDone + 1}/{runTotal} 步：{currentStep.name}
                          </>
                        ) : failedStep ? (
                          <>
                            <i className="ri-close-circle-line" /> 第 {runDone + 1}/{runTotal} 步失败
                          </>
                        ) : (
                          <>
                            <i className="ri-check-line" /> {runDone}/{runTotal} 步完成
                          </>
                        )}
                      </span>
                      <div className="wf-pipeline-progress-stats">
                        <span className="wf-progress-pct">{runPct}%</span>
                      </div>
                    </div>
                    <div className="wf-progress-bar">
                      <div
                        className={`wf-progress-fill${failedStep ? ' failed' : ''}${isRunning ? ' running' : ''}`}
                        style={{ width: `${Math.max(runPct, 3)}%` }}
                      />
                    </div>
                  </div>

                  <div className="wf-pipeline-track">
                    <div className="wf-pipeline-track-line" />
                    <div className="wf-pipeline-stages" ref={(el) => syncStageFades(el)} onScroll={(e) => syncStageFades(e.currentTarget)}>
                      {runSteps.map((step: any, i: number) => (
                        <div
                          key={step.stepId}
                          className="wf-pipeline-stage"
                          onClick={() => def && openEditorAt(def, step.stepId)}
                          title="在画布中定位该节点"
                        >
                          <div className="wf-pipeline-stage-content">
                            <div
                              className={`wf-stage-dot${step.status === 'done' ? ' done' : ''}${step.status === 'running' ? ' current' : ''}${step.status === 'failed' ? ' failed' : ''}`}
                            >
                              {step.status === 'done' ? (
                                <i className="ri-check-line" />
                              ) : step.status === 'failed' ? (
                                <i className="ri-close-line" />
                              ) : step.status === 'running' ? (
                                <i className="ri-loader-4-line ri-spin" />
                              ) : (
                                <span className="wf-stage-dot-inner" />
                              )}
                            </div>
                            <span className="wf-stage-label">{step.name}</span>
                            {step.status === 'failed' && step.error && (
                              <span className="wf-stage-error" title={step.error}>
                                {step.error}
                              </span>
                            )}
                          </div>
                          {i < runSteps.length - 1 && (
                            <div
                              className={`wf-stage-connector${step.status === 'done' ? ' done' : ''}${runSteps[i + 1]?.status === 'running' ? ' active' : ''}`}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {isRunning && logs.length > 0 && (
                    <div className="wf-pipeline-log">
                      <div className="wf-pipeline-log-header">
                        <i className="ri-terminal-line" /> 实时输出
                      </div>
                      <div className="wf-pipeline-log-body" ref={logBodyRef}>
                        {logs.map((line, idx) => (
                          <div key={idx} className="wf-pipeline-log-line">
                            {line}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="wf-pipeline-foot">
                    <span className="wf-pipeline-foot-time">
                      <i className="ri-time-line" /> {fmtTime(run.startedAt)}
                    </span>
                    <span className="wf-pipeline-runid">{run.runId}</span>
                  </div>
                </section>
              )
            })
          ) : (
            <div className="wf-page-empty">
              <i className="ri-inbox-2-line" />
              <span>当前没有运行中的工作流</span>
              <button className="wf-editor-btn wf-editor-btn-add" onClick={() => setPage('defs')}>
                <i className="ri-play-list-2-line" /> 去选择工作流
              </button>
            </div>
          ))}

        {page === 'defs' && (
          <>
            {/* ── 快速启动模板 ── */}
            {enabledDefs.length === 0 && disabledDefs.length === 0 && !searchQuery && presets.length > 0 && (
              <section className="wf-presets">
                <div className="wf-presets-header">
                  <h4 className="wf-section-title" style={{ margin: 0 }}>
                    快速开始
                  </h4>
                  <span className="wf-presets-hint">选择一个预设模板，或自行创建</span>
                </div>
                <div className="wf-presets-grid">
                  {presets.map((p) => (
                    <div
                      key={p.id}
                      className="wf-preset-card"
                      onClick={async () => {
                        const result = await window.electronAPI.startWorkflow(p.id)
                        if (result?.success) {
                          setRunSuccess(`已启动「${p.name}」`)
                          refreshDefs()
                        } else setRunError(result?.error ?? '启动失败')
                      }}
                    >
                      <div className="wf-preset-card-icon">
                        <i className={p.icon} />
                      </div>
                      <div className="wf-preset-card-body">
                        <span className="wf-preset-card-name">{p.name}</span>
                        <span className="wf-preset-card-desc">{p.description}</span>
                      </div>
                      <span className="wf-preset-card-steps">{p.steps} 步</span>
                      <i className="ri-play-circle-line wf-preset-card-play" />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* -- 工作流画布看板 -- */}
            {enabledDefs.length > 0 && (
              <div className="wf-canvas-board">
                {enabledDefs.map((def: any) => {
                  const isDefRunning = workflowActiveRuns.some((r: any) => r.workflowDefId === def.id)
                  return (
                    <section key={def.id} className={'wf-canvas-card' + (isDefRunning ? ' running' : '')}>
                      <div className="wf-canvas-card-header">
                        <div className="wf-canvas-card-title">
                          <span className={'wf-canvas-card-dot' + (isDefRunning ? ' running' : '')} />
                          <h3 className="wf-canvas-card-name">{def.name}</h3>
                          {isDefRunning && <span className="wf-plan-badge running">运行中</span>}
                        </div>
                        <div className="wf-canvas-card-meta">
                          {def.trigger?.type && def.trigger.type !== 'manual' && (
                            <span className={'wf-trigger-badge wf-trigger-badge-' + def.trigger.type}>
                              <i className={def.trigger.type === 'cron' ? 'ri-timer-line' : 'ri-flashlight-line'} />
                              {def.trigger.type === 'cron' ? def.trigger.cron : def.trigger.type}
                            </span>
                          )}
                          <span className="wf-plan-badge">{def.steps.length} 步</span>
                        </div>
                      </div>
                      <p className="wf-desc">{def.description}</p>
                      <div
                        className="wf-canvas-card-canvas"
                        onClick={() => {
                          setEditDef(def)
                          setFocusStepId(null)
                          setView('editor')
                        }}
                      >
                        <MiniDag steps={def.steps} />
                      </div>
                      <div className="wf-canvas-card-foot">
                        <span className="wf-meta-time">
                          <i className="ri-time-line" /> {fmtTime(def.updatedAt || def.createdAt)}
                        </span>
                        <div className="wf-canvas-card-actions">
                          <button
                            className="wf-canvas-action wf-canvas-action-run"
                            title="运行"
                            onClick={(e) => {
                              e.stopPropagation()
                              startRun(def.id)
                            }}
                          >
                            <i className="ri-play-fill" /> 运行
                          </button>
                          <button
                            className="wf-canvas-action wf-canvas-action-edit"
                            title="编辑"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditDef(def)
                              setFocusStepId(null)
                              setView('editor')
                            }}
                          >
                            <i className="ri-edit-line" /> 编辑
                          </button>
                          <button
                            className="wf-canvas-action wf-canvas-action-icon"
                            title="复制"
                            onClick={async (e) => {
                              e.stopPropagation()
                              const r = await window.electronAPI.duplicateWorkflowDefinition(def.id)
                              if (r?.success) {
                                setRunSuccess('已复制')
                                refreshDefs()
                              } else setRunError(r?.error ?? '复制失败')
                            }}
                          >
                            <i className="ri-file-copy-line" />
                          </button>
                          <button
                            className="wf-canvas-action wf-canvas-action-icon"
                            title="停用"
                            onClick={async (e) => {
                              e.stopPropagation()
                              setRunError('')
                              const result = await window.electronAPI.disableWorkflowDefinition(def.id)
                              if (result?.success) refreshDefs()
                              else setRunError(result?.error ?? '操作失败')
                            }}
                          >
                            <i className="ri-pause-circle-line" />
                          </button>
                          <button
                            className="wf-canvas-action wf-canvas-action-icon danger"
                            title="删除"
                            onClick={async (e) => {
                              e.stopPropagation()
                              if (!confirm('确认删除工作流「' + def.name + '」？')) return
                              await window.electronAPI.deleteWorkflowDefinition(def.id)
                              refreshDefs()
                            }}
                          >
                            <i className="ri-delete-bin-line" />
                          </button>
                        </div>
                      </div>
                    </section>
                  )
                })}
              </div>
            )}

            {/* -- 停用工作流折叠区 -- */}
            {disabledDefs.length > 0 && (
              <section className="wf-history wf-canvas-section" style={{ marginTop: 8 }}>
                <button className="wf-history-toggle" onClick={() => setShowDisabled(!showDisabled)}>
                  <div className="wf-history-toggle-left">
                    <i className={'ri-arrow-' + (showDisabled ? 'down' : 'right') + '-s-line'} />
                    停用工作流
                    <span className="wf-history-count">{disabledDefs.length}</span>
                  </div>
                </button>

                {showDisabled && (
                  <div className="wf-canvas-board wf-canvas-board-disabled">
                    {disabledDefs.map((def: any) => (
                      <section key={def.id} className="wf-canvas-card disabled">
                        <div className="wf-canvas-card-header">
                          <div className="wf-canvas-card-title">
                            <span className="wf-canvas-card-dot" />
                            <h3 className="wf-canvas-card-name">{def.name}</h3>
                            <span className="wf-plan-badge wf-badge-disabled">已停用</span>
                          </div>
                          <div className="wf-canvas-card-meta">
                            <span className="wf-plan-badge">{def.steps.length} 步</span>
                          </div>
                        </div>
                        <p className="wf-desc">{def.description}</p>
                        <div className="wf-canvas-card-canvas">
                          <MiniDag steps={def.steps} />
                        </div>
                        <div className="wf-canvas-card-foot">
                          <span className="wf-meta-time">
                            <i className="ri-time-line" /> {fmtTime(def.updatedAt || def.createdAt)}
                          </span>
                          <div className="wf-canvas-card-actions">
                            <button
                              className="wf-canvas-action wf-canvas-action-icon"
                              title="复制"
                              onClick={async (e) => {
                                e.stopPropagation()
                                const r = await window.electronAPI.duplicateWorkflowDefinition(def.id)
                                if (r?.success) {
                                  setRunSuccess('已复制')
                                  refreshDefs()
                                } else setRunError(r?.error ?? '复制失败')
                              }}
                            >
                              <i className="ri-file-copy-line" />
                            </button>
                            <button
                              className="wf-canvas-action wf-canvas-action-edit"
                              title="启用"
                              onClick={async (e) => {
                                e.stopPropagation()
                                const result = await window.electronAPI.enableWorkflowDefinition(def.id)
                                if (result?.success) refreshDefs()
                                else setRunError(result?.error ?? '操作失败')
                              }}
                            >
                              <i className="ri-play-circle-line" /> 启用
                            </button>
                            <button
                              className="wf-canvas-action wf-canvas-action-icon danger"
                              title="删除"
                              onClick={async (e) => {
                                e.stopPropagation()
                                if (!confirm('确认删除工作流「' + def.name + '」？')) return
                                await window.electronAPI.deleteWorkflowDefinition(def.id)
                                refreshDefs()
                              }}
                            >
                              <i className="ri-delete-bin-line" />
                            </button>
                          </div>
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </section>
            )}

            {enabledDefs.length === 0 && disabledDefs.length === 0 && searchQuery && workflowDefs.length > 0 && (
              <div className="workflow-empty">
                <div className="workflow-empty-icon">
                  <i className="ri-search-line" />
                </div>
                <div className="workflow-empty-text">没有匹配的工作流</div>
                <div className="workflow-empty-sub">
                  尝试其他关键词，或
                  <button className="wf-search-clear-link" onClick={() => setSearchQuery('')}>
                    清除搜索
                  </button>
                </div>
              </div>
            )}

            {/* ── 全空状态 ── */}
            {enabledDefs.length === 0 && disabledDefs.length === 0 && !showHistory && !searchQuery && presets.length === 0 && (
              <div className="workflow-empty">
                <div className="workflow-empty-icon">
                  <i className="ri-file-list-3-line" />
                </div>
                <div className="workflow-empty-text">还没有工作流</div>
                <div className="workflow-empty-sub">点击上方「新建工作流」创建，或让 AI 通过工具自动生成</div>
              </div>
            )}
          </>
        )}

        {/* ── 已完成 ── */}
        {page === 'done' && (
          <section className="wf-history">
            <div className="wf-history-titlebar">
              <div className="wf-history-toggle-left">
                <i className="ri-history-line" />
                运行记录
                <span className="wf-history-count">{historyCount}</span>
              </div>
            </div>

            <>
              <div className="wf-history-filters">
                {(['all', 'done', 'failed'] as HistoryFilter[]).map((f) => (
                  <button
                    key={f}
                    className={`wf-history-filter-tag${historyFilter === f ? ' active' : ''}`}
                    onClick={() => setHistoryFilter(f)}
                  >
                    {f === 'all' ? '全部' : f === 'done' ? '成功' : '失败'}
                  </button>
                ))}
              </div>

              {historyRuns.length === 0 ? (
                <div className="wf-history-empty">
                  <div className="wf-history-empty-icon">
                    <i className="ri-history-line" />
                  </div>
                  <span className="wf-history-empty-title">没有匹配的记录</span>
                  <span className="wf-history-empty-sub">运行完成或失败的工作流会归档到这里</span>
                </div>
              ) : (
                <div className="wf-history-list">
                  {historyRuns.map((run: any) => (
                    <div key={run.runId} className="wf-history-item">
                      <div
                        className="wf-history-item-head"
                        onClick={() => setHistoryExpandedRun(historyExpandedRun === run.runId ? null : run.runId)}
                      >
                        <div className="wf-history-item-left">
                          <span className="wf-history-title">{run.workflowName}</span>
                          <span className="wf-history-time">{fmtTime(run.startedAt)}</span>
                        </div>
                        <div className="wf-history-item-right">
                          <span className={`wf-history-status-badge ${run.status}`}>
                            {run.status === 'done' ? '成功' : run.status === 'failed' ? '失败' : run.status}
                          </span>
                          <i className={`ri-arrow-${historyExpandedRun === run.runId ? 'up' : 'down'}-s-line`} />
                        </div>
                      </div>
                      <div className="wf-history-meta">
                        {run.steps.filter((s: any) => s.status === 'done').length}/{run.steps.length} 步
                        {run.completedAt && run.startedAt && <> · 耗时 {fmtElapsed(run.completedAt - run.startedAt)}</>}
                      </div>

                      {/* 操作按钮 */}
                      <div className="wf-history-actions">
                        <button
                          className="wf-history-action-btn"
                          title="重新运行"
                          onClick={(e) => {
                            e.stopPropagation()
                            const srcDef = workflowDefs.find((d: any) => d.id === run.workflowDefId)
                            if (srcDef) startRun(srcDef.id)
                            else setRunError('找不到对应的工作流定义')
                          }}
                        >
                          <i className="ri-refresh-line" /> 重新运行
                        </button>
                        <button
                          className="wf-history-action-btn wf-history-action-btn-del"
                          title="删除记录"
                          onClick={async (e) => {
                            e.stopPropagation()
                            if (!confirm(`删除此运行记录？`)) return
                            await window.electronAPI.deleteWorkflowRun(run.runId)
                            refreshDefs()
                          }}
                        >
                          <i className="ri-delete-bin-6-line" /> 删除
                        </button>
                      </div>

                      {historyExpandedRun === run.runId && (
                        <ul className="wf-steps" style={{ marginTop: 8, marginBottom: 4 }}>
                          {run.steps.map((s: any) => {
                            const dur = s.completedAt && s.startedAt ? fmtElapsed(s.completedAt - s.startedAt) : null
                            return (
                              <li key={s.stepId} className={`wf-step ${stageColor(s.status)}`}>
                                <i className={stageIcon(s.status)} />
                                <span className="wf-step-text">{s.stepId}</span>
                                {dur && <span className="wf-step-duration">{dur}</span>}
                                {s.error && <span className="wf-step-result">{s.error}</span>}
                                {s.agentResult && !s.error && <span className="wf-step-result">{s.agentResult}</span>}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          </section>
        )}
      </ErrorBoundary>
    </div>
  )
}
