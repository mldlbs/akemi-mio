import { useState, useMemo, useRef, useEffect } from 'react'

interface RunStep {
  stepId: string
  status: string
  name?: string
  error?: string
  agentResult?: string
  startedAt?: number
  completedAt?: number
  retryCount?: number
}

interface ActiveRun {
  runId: string
  workflowDefId: string
  workflowName: string
  status: string
  steps: RunStep[]
  startedAt: number
  completedAt?: number
  pendingGate?: { stepId: string; message: string; preview: string; options: string[] }
}

interface Props {
  runs: ActiveRun[]
  pipelineLogs: Record<string, string[]>
  onCancel: (runId: string) => void
  onClose: () => void
  onApproveGate?: (runId: string, stepId: string, decision: string, modifiedInput?: string) => void
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

function tryParseJSON(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** JSON tree viewer — renders collapsible JSON */
function JSONViewer({ data, depth = 0 }: { data: any; depth?: number }) {
  const [open, setOpen] = useState(depth < 2)
  const isObject = data !== null && typeof data === 'object'
  const isArray = Array.isArray(data)
  const indent = depth * 16

  if (!isObject) {
    const display = typeof data === 'string' ? `"${data.length > 80 ? data.slice(0, 80) + '...' : data}"` : String(data)
    return <span className="wf-json-value">{display}</span>
  }

  const entries = isArray ? data : Object.keys(data)
  const prefix = isArray ? `Array(${entries.length})` : 'Object'
  const isEmpty = entries.length === 0

  return (
    <div className="wf-json-node" style={{ marginLeft: indent }}>
      <button className="wf-json-toggle" onClick={() => setOpen(!open)}>
        <i className={`ri-${open ? 'arrow-down-s' : 'arrow-right-s'}-line`} />
        <span className="wf-json-preview">
          {prefix}
          {open
            ? ''
            : ` ${isArray ? `[${data.length}]` : `{${Object.keys(data).slice(0, 2).join(', ')}${Object.keys(data).length > 2 ? '...' : ''}}`}`}
        </span>
      </button>
      {open && !isEmpty && (
        <div className="wf-json-children">
          {(isArray ? data.map((v: any, i: number) => ({ k: i, v })) : Object.entries(data)).map(([k, v]: any) => (
            <div key={k} className="wf-json-row">
              <span className="wf-json-key">{isArray ? `[${k}]` : k}: </span>
              <JSONViewer data={v} depth={depth + 1} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Gate approval dialog */
function GateDialog({
  gate,
  runId,
  onApprove,
}: {
  gate: NonNullable<ActiveRun['pendingGate']>
  runId: string
  onApprove: (decision: string, modifiedInput?: string) => void
}) {
  const [modifiedText, setModifiedText] = useState('')
  const previewIsJson = useMemo(() => tryParseJSON(gate.preview), [gate.preview])

  return (
    <div className="wf-gate-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="wf-gate-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="wf-gate-header">
          <i className="ri-lock-2-line" />
          <span>审批请求</span>
        </div>
        <div className="wf-gate-message">{gate.message}</div>
        <div className="wf-gate-section-label">预览</div>
        <div className="wf-gate-preview">
          {previewIsJson ? <JSONViewer data={previewIsJson} /> : <pre className="wf-gate-preview-text">{gate.preview}</pre>}
        </div>
        <div className="wf-gate-section-label">修改建议（可选）</div>
        <textarea
          className="wf-gate-input"
          value={modifiedText}
          onChange={(e) => setModifiedText(e.target.value)}
          placeholder="如有修改建议，请在此输入..."
          rows={3}
        />
        <div className="wf-gate-actions">
          {gate.options.includes('approve') && (
            <button className="wf-gate-btn wf-gate-btn-approve" onClick={() => onApprove('approve', modifiedText)}>
              <i className="ri-check-line" /> 批准
            </button>
          )}
          {gate.options.includes('modify') && modifiedText.trim() && (
            <button className="wf-gate-btn wf-gate-btn-modify" onClick={() => onApprove('modify', modifiedText)}>
              <i className="ri-edit-line" /> 修改后通过
            </button>
          )}
          {gate.options.includes('reject') && (
            <button className="wf-gate-btn wf-gate-btn-reject" onClick={() => onApprove('reject', modifiedText)}>
              <i className="ri-close-line" /> 拒绝
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function WorkflowRunPanel({ runs, pipelineLogs, onCancel, onClose, onApproveGate }: Props) {
  const logRef = useRef<HTMLDivElement>(null)
  const [expandedOutput, setExpandedOutput] = useState<Record<string, boolean>>({})

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
          {runs.some((r) => r.pendingGate) ? (
            <>
              <i className="ri-lock-2-line" /> 等待审批
            </>
          ) : (
            <>
              <i className="ri-loader-4-line ri-spin" /> 运行中
            </>
          )}
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
              {run.pendingGate && onApproveGate && (
                <GateDialog
                  gate={run.pendingGate}
                  runId={run.runId}
                  onApprove={(decision, modifiedInput) => {
                    onApproveGate(run.runId, run.pendingGate!.stepId, decision, modifiedInput)
                  }}
                />
              )}

              <div className="wf-run-panel-item-header">
                <span className="wf-run-panel-item-name">{run.workflowName}</span>
                {run.status === 'running' && !run.pendingGate && (
                  <button className="wf-cancel-btn" onClick={() => onCancel(run.runId)}>
                    <i className="ri-stop-circle-line" /> 取消
                  </button>
                )}
              </div>

              <div className="wf-pipeline-progress-info" style={{ marginBottom: 4 }}>
                <span className="wf-pipeline-step-label">
                  {run.pendingGate ? (
                    <>
                      <i className="ri-lock-2-line" /> 等待审批中
                    </>
                  ) : current ? (
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

              <div className="wf-pipeline-track" style={{ marginTop: 8 }}>
                <div className="wf-pipeline-track-line" />
                <div className="wf-pipeline-stages" style={{ gap: 8 }}>
                  {defSteps.map((step) => (
                    <div key={step.stepId} className="wf-pipeline-stage" style={{ minWidth: 0, flex: '0 0 auto', maxWidth: 140 }}>
                      <div
                        className="wf-pipeline-stage-content"
                        onClick={() => setExpandedOutput((p) => ({ ...p, [step.stepId]: !p[step.stepId] }))}
                      >
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
                        {step.error && (
                          <span className="wf-stage-error" title={step.error}>
                            {step.error}
                          </span>
                        )}
                        {step.retryCount && step.retryCount > 0 ? <span className="wf-stage-retry">重试 {step.retryCount}</span> : null}
                      </div>

                      {expandedOutput[step.stepId] && step.agentResult && (
                        <div className="wf-step-output-detail">
                          {tryParseJSON(step.agentResult) ? (
                            <JSONViewer data={tryParseJSON(step.agentResult)} />
                          ) : (
                            <pre className="wf-step-output-text">{step.agentResult}</pre>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

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
