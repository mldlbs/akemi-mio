import { useMemo, useRef, useEffect } from 'react'

interface RunStep {
  stepId: string
  status: string
  name?: string
  error?: string
  agentResult?: string
  startedAt?: number
  completedAt?: number
}

interface ActiveRun {
  runId: string
  workflowDefId: string
  workflowName: string
  status: string
  steps: RunStep[]
  startedAt: number
  completedAt?: number
}

interface Props {
  runs: ActiveRun[]
  pipelineLogs: Record<string, string[]>
  onCancel: (runId: string) => void
  onClose: () => void
}

function fmtElapsed(ms: number): string {
  if (!ms || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

export function WorkflowRunPanel({ runs, pipelineLogs, onCancel, onClose }: Props) {
  const logRef = useRef<HTMLDivElement>(null)

  // Auto-scroll log to bottom
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [pipelineLogs])

  if (runs.length === 0) return null

  return (
    <div className="wf-run-panel-inline">
      <div className="wf-run-panel-inline-header">
        <h3>
          <i className="ri-loader-4-line ri-spin" /> 运行中
        </h3>
        <button className="wf-run-panel-close" onClick={onClose} title="关闭运行面板">
          <i className="ri-close-line" />
        </button>
      </div>
      <div className="wf-run-panel-inline-body">
        {runs.map((run) => {
          const defSteps = run.steps
          const done = defSteps.filter((s) => s.status === 'done').length
          const total = defSteps.length
          const pct = total > 0 ? Math.round((done / total) * 100) : 0
          const current = defSteps.find((s) => s.status === 'running')
          const failed = defSteps.find((s) => s.status === 'failed')
          const logs = pipelineLogs[run.runId] ?? []

          return (
            <div key={run.runId} className="wf-run-panel-item">
              {/* title + cancel */}
              <div className="wf-run-panel-item-header">
                <span className="wf-run-panel-item-name">{run.workflowName}</span>
                {run.status === 'running' && (
                  <button className="wf-cancel-btn" onClick={() => onCancel(run.runId)}>
                    <i className="ri-stop-circle-line" /> 取消
                  </button>
                )}
              </div>

              {/* progress */}
              <div className="wf-pipeline-progress-info" style={{ marginBottom: 4 }}>
                <span className="wf-pipeline-step-label">
                  {current ? (
                    <>
                      <i className="ri-loader-4-line ri-spin" /> 第 {done + 1}/{total} 步：{current.name || current.stepId}
                    </>
                  ) : failed ? (
                    <>
                      <i className="ri-close-circle-line" /> 第 {done + 1}/{total} 步失败
                    </>
                  ) : (
                    <>
                      <i className="ri-check-line" /> {done}/{total} 步完成
                    </>
                  )}
                </span>
                <div className="wf-pipeline-progress-stats">
                  <span className="wf-progress-pct">{pct}%</span>
                </div>
              </div>
              <div className="wf-progress-bar">
                <div
                  className={`wf-progress-fill${failed ? ' failed' : ''}${run.status === 'running' ? ' running' : ''}`}
                  style={{ width: `${Math.max(pct, 3)}%` }}
                />
              </div>

              {/* step track */}
              <div className="wf-pipeline-track" style={{ marginTop: 8 }}>
                <div className="wf-pipeline-track-line" />
                <div className="wf-pipeline-stages" style={{ gap: 8 }}>
                  {defSteps.map((step) => (
                    <div key={step.stepId} className="wf-pipeline-stage" style={{ minWidth: 0, flex: '0 0 auto', maxWidth: 140 }}>
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
                        <span className="wf-stage-label">{step.name || step.stepId}</span>
                        {step.error && <span className="wf-stage-error">{step.error}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* logs */}
              {logs.length > 0 && (
                <div className="wf-pipeline-log">
                  <div className="wf-pipeline-log-header">
                    <i className="ri-terminal-line" /> 实时输出
                  </div>
                  <div className="wf-pipeline-log-body" ref={logRef}>
                    {logs.map((line, idx) => (
                      <div key={idx} className="wf-pipeline-log-line">
                        {line}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
