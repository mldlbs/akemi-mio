import { useState, useEffect } from 'react'
import { WorkflowEditor } from './WorkflowEditor'
import { ErrorBoundary } from './ErrorBoundary'

type ViewMode = 'list' | 'editor'

function stageIcon(status: string): string {
  switch (status) {
    case 'done':
      return 'ri-check-line'
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
    default:
      return handler
  }
}

export interface WorkflowSlotProps {
  workflowDefs: any[]
  workflowRuns: any[]
  workflowActiveRuns: any[]
  wfLoading: boolean
  onRefreshDefs?: () => void
}

export function WorkflowSlot({ workflowDefs, workflowRuns, workflowActiveRuns, wfLoading, onRefreshDefs }: WorkflowSlotProps) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyExpandedRun, setHistoryExpandedRun] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('list')
  const [editDef, setEditDef] = useState<any | null>(null)
  const [runError, setRunError] = useState('')
  const [elapsed, setElapsed] = useState(0)

  // 活跃工作流计时器 — 每秒更新，给用户"还在跑"的反馈
  const hasActive = workflowActiveRuns.length > 0
  useEffect(() => {
    if (!hasActive) {
      setElapsed(0)
      return
    }
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Date.now() - t0), 1000)
    return () => clearInterval(id)
  }, [hasActive])

  function fmtElapsed(ms: number): string {
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
    if (m > 0) return `${m}m ${s % 60}s`
    return `${s}s`
  }

  // ── Editor view ──
  if (view === 'editor') {
    return (
      <WorkflowEditor
        initial={editDef}
        onBack={() => {
          setView('list')
          setEditDef(null)
        }}
        onSaved={() => {
          onRefreshDefs?.()
        }}
      />
    )
  }

  const showPipeline = workflowActiveRuns.length > 0
  const showDefs = workflowDefs.length > 0
  const showHistory = workflowRuns.filter((r: any) => r.status !== 'running').length > 0

  return (
    <div className="workflow-slot workflow-slot-content">
      <ErrorBoundary>
        {/* ── 运行中的 pipeline ── */}
        {showPipeline &&
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
            const isRunning = !!currentStep
            const failedStep = runSteps.find((s: any) => s.status === 'failed')
            const statusTag = failedStep ? `${failedStep.name} 失败` : currentStep ? `${currentStep.name}` : '完成'
            return (
              <section key={run.runId} className={`wf-pipeline${isRunning ? ' running' : ''}`}>
                <div className="wf-pipeline-header">
                  <h4 className="wf-section-title" style={{ margin: 0 }}>
                    {run.workflowName}
                  </h4>
                  {isRunning && (
                    <button
                      className="wf-cancel-btn"
                      title="取消运行"
                      onClick={async () => {
                        await window.electronAPI.stopWorkflowRun(run.runId)
                      }}
                    >
                      <i className="ri-stop-circle-line" /> 取消
                    </button>
                  )}
                </div>
                <div className="wf-pipeline-status-text">
                  {isRunning ? (
                    <span className="wf-progress-running">
                      <i className="ri-loader-4-line ri-spin" />第 {runDone + 1}/{runTotal} 步：{currentStep.name}
                      <span className="wf-elapsed">{fmtElapsed(elapsed)}</span>
                    </span>
                  ) : failedStep ? (
                    <span className="wf-progress-failed">
                      <i className="ri-close-circle-line" />第 {runDone + 1}/{runTotal} 步失败：{failedStep.error || failedStep.name}
                    </span>
                  ) : (
                    <span className="wf-progress-done">
                      <i className="ri-check-line" />
                      {runDone}/{runTotal} 步完成
                    </span>
                  )}
                  <span className="wf-progress-pct">{runPct}%</span>
                </div>
                {isRunning && currentStep.agentResult && (
                  <div className="wf-step-activity">
                    <code>{currentStep.agentResult}</code>
                  </div>
                )}
                <div className="wf-pipeline-track">
                  <div className="wf-pipeline-fill" style={{ width: `${Math.max(runPct, 4)}%` }} />
                  <div className="wf-pipeline-stages">
                    {runSteps.map((step: any) => (
                      <div key={step.stepId} className="wf-pipeline-stage">
                        <div
                          className={`wf-stage-dot${step.status === 'done' ? ' done' : ''}${step.status === 'running' ? ' current' : ''}${step.status === 'failed' ? ' failed' : ''}`}
                        >
                          <span className="wf-stage-dot-inner" />
                          <span className="wf-stage-label">{step.name}</span>
                          {step.status === 'failed' && step.error && (
                            <span className="wf-stage-error" title={step.error}>
                              {step.error}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            )
          })}

        {/* ── 工作流定义列表 ── */}
        <div className="wf-list-header">
          <p className="wf-hint">AI 可通过 create_workflow / start_workflow 工具创建和启动，也可手动编辑</p>
          <button
            className="wf-editor-btn wf-editor-btn-add"
            onClick={() => {
              setEditDef(null)
              setView('editor')
            }}
          >
            <i className="ri-add-line" />
            新建工作流
          </button>
        </div>

        {runError && (
          <div className="wf-editor-error">
            <i className="ri-alert-line" />
            {runError}
          </div>
        )}

        {showDefs &&
          workflowDefs.map((def: any) => (
            <section key={def.id} className={`wf-plan-card${def.enabled === false ? ' wf-plan-card-disabled' : ''}`}>
              <div className="wf-plan-header">
                <h3 className="wf-plan-title">
                  {def.name}
                  {def.enabled === false && <span className="wf-plan-badge wf-badge-disabled">已停用</span>}
                </h3>
                <span className="wf-plan-badge">{def.steps.length} 步</span>
              </div>
              <p className="wf-desc">{def.description}</p>
              <div className="wf-meta-row">
                <span className="wf-meta-time">{new Date(def.updatedAt || def.createdAt).toLocaleString('zh-CN')}</span>
              </div>
              <ul className="wf-steps">
                {def.steps.map((s: any) => (
                  <li key={s.id} className="wf-step wf-step-pending" style={{ opacity: 0.7 }}>
                    <i className="ri-circle-line" />
                    <span className="wf-step-text">{s.name}</span>
                    <span className={`wf-step-handler-tag ${handlerClass(s.handler)}`}>
                      <i className={handlerIcon(s.handler)} />
                      {handlerLabel(s.handler)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="wf-summary-row">
                <button
                  className="wf-editor-btn wf-editor-btn-edit"
                  onClick={() => {
                    setEditDef(def)
                    setView('editor')
                  }}
                >
                  <i className="ri-edit-line" />
                  编辑
                </button>
                <button
                  className="wf-editor-btn wf-editor-btn-run"
                  disabled={def.enabled === false}
                  onClick={async () => {
                    setRunError('')
                    const result = await window.electronAPI.startWorkflow(def.id)
                    if (result.success) {
                      onRefreshDefs?.()
                    } else {
                      setRunError(result.error ?? '启动失败')
                    }
                  }}
                >
                  <i className="ri-play-circle-line" />
                  运行
                </button>
                <button
                  className="wf-editor-btn wf-editor-btn-toggle"
                  onClick={async () => {
                    setRunError('')
                    const fn =
                      def.enabled === false ? window.electronAPI.enableWorkflowDefinition : window.electronAPI.disableWorkflowDefinition
                    const result = await fn(def.id)
                    if (result.success) {
                      onRefreshDefs?.()
                    } else {
                      setRunError(result.error ?? '操作失败')
                    }
                  }}
                >
                  <i className={`ri-${def.enabled === false ? 'play-circle' : 'pause-circle'}-line`} />
                  {def.enabled === false ? '启用' : '停用'}
                </button>
                <button
                  className="wf-editor-btn wf-editor-btn-del"
                  onClick={async () => {
                    if (!confirm(`确认删除工作流「${def.name}」？`)) return
                    await window.electronAPI.deleteWorkflowDefinition(def.id)
                    onRefreshDefs?.()
                  }}
                >
                  <i className="ri-delete-bin-line" />
                  删除
                </button>
              </div>
            </section>
          ))}

        {/* ── 运行历史 ── */}
        {showHistory && (
          <section className="wf-history">
            <button className="wf-history-toggle" onClick={() => setHistoryOpen(!historyOpen)}>
              <i className={`ri-arrow-${historyOpen ? 'down' : 'right'}-s-line`} />
              运行历史（{workflowRuns.filter((r: any) => r.status !== 'running').length}）
            </button>
            {historyOpen && (
              <div className="wf-history-list">
                {workflowRuns
                  .filter((r: any) => r.status !== 'running')
                  .map((run: any) => (
                    <div key={run.runId} className="wf-history-item">
                      <div
                        className="wf-history-item-head"
                        onClick={() => setHistoryExpandedRun(historyExpandedRun === run.runId ? null : run.runId)}
                        style={{ cursor: 'pointer' }}
                      >
                        <span className="wf-history-title">{run.workflowName}</span>
                        <span className={`wf-plan-badge ${run.status}`}>{run.status}</span>
                      </div>
                      <div className="wf-history-meta">
                        {new Date(run.startedAt).toLocaleString('zh-CN')} · {run.steps.filter((s: any) => s.status === 'done').length}/
                        {run.steps.length} 步
                      </div>
                      {historyExpandedRun === run.runId && (
                        <ul className="wf-steps" style={{ marginTop: 8 }}>
                          {run.steps.map((s: any) => (
                            <li key={s.stepId} className={`wf-step ${stageColor(s.status)}`}>
                              <i className={stageIcon(s.status)} />
                              <span className="wf-step-text">{s.stepId}</span>
                              {s.error && <span className="wf-step-result">{s.error}</span>}
                              {s.agentResult && <span className="wf-step-result">{s.agentResult}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </section>
        )}

        {!showDefs && !showHistory && (
          <div className="workflow-empty" style={{ padding: '60px 0' }}>
            <div className="workflow-empty-icon">
              <i className="ri-file-list-3-line" />
            </div>
            <div className="workflow-empty-text">还没有工作流</div>
            <div className="workflow-empty-sub">点击上方「新建工作流」创建，或让 AI 通过工具自动生成</div>
          </div>
        )}
      </ErrorBoundary>
    </div>
  )
}
