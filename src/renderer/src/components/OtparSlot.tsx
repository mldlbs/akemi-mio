import { ErrorBoundary } from './ErrorBoundary'
import type { OtparEntry } from '../hooks/usePlans'

const OTPAR_PHASES: { type: OtparEntry['type']; label: string; icon: string }[] = [
  { type: 'observe', label: 'Observe', icon: 'ri-eye-line' },
  { type: 'think', label: 'Think', icon: 'ri-brain-line' },
  { type: 'reflect', label: 'Reflect', icon: 'ri-repeat-line' },
]

function groupOtparByStep(entries: OtparEntry[]): { step: number; entries: OtparEntry[] }[] {
  const map = new Map<number, OtparEntry[]>()
  for (const e of entries) {
    if (!map.has(e.step)) map.set(e.step, [])
    map.get(e.step)!.push(e)
  }
  const ORDER = { observe: 0, think: 1, reflect: 2 }
  for (const [, list] of map) {
    list.sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9))
  }
  return Array.from(map.entries())
    .map(([step, list]) => ({ step, entries: list }))
    .sort((a, b) => b.step - a.step)
}

interface Props {
  otparStages: OtparEntry[]
}

export function OtparSlot({ otparStages }: Props) {
  return (
    <div className="workflow-slot workflow-slot-content">
      <ErrorBoundary>
        {otparStages.length > 0 ? (
          <section className="wf-otpar">
            <h4 className="wf-section-title">OTPAR 认知循环</h4>
            {groupOtparByStep(otparStages).length > 0 ? (
              <div className="wf-otpar-groups">
                {groupOtparByStep(otparStages).map((group) => {
                  const completed = group.entries.filter((e) => e.durationMs !== undefined).length
                  return (
                    <div key={group.step} className="wf-otpar-group">
                      <div className="wf-otpar-group-header">
                        <span className="wf-otpar-group-step">步骤 #{group.step}</span>
                        <span className="wf-otpar-group-progress">
                          {completed} / {group.entries.length} 完成
                        </span>
                      </div>
                      <div className="wf-otpar-group-phases">
                        {OTPAR_PHASES.map((phase) => {
                          const entry = group.entries.find((e) => e.type === phase.type)
                          if (!entry) {
                            return (
                              <div key={phase.type} className="wf-otpar-phase wf-otpar-phase-pending">
                                <div className="wf-otpar-phase-icon">
                                  <i className={phase.icon} />
                                </div>
                                <div className="wf-otpar-phase-body">
                                  <span className="wf-otpar-phase-label">{phase.label}</span>
                                  <span className="wf-otpar-phase-detail">等待中</span>
                                </div>
                              </div>
                            )
                          }
                          const isLatest = entry === otparStages[otparStages.length - 1] && entry.durationMs === undefined
                          return (
                            <div key={phase.type} className={`wf-otpar-phase wf-otpar-phase-${entry.type}${isLatest ? ' current' : ''}`}>
                              <div className={`wf-otpar-phase-icon wf-otpar-${entry.type}`}>
                                <i className={phase.icon} />
                              </div>
                              <div className="wf-otpar-phase-body">
                                <div className="wf-otpar-phase-head">
                                  <span className="wf-otpar-phase-label">{phase.label}</span>
                                  {entry.durationMs !== undefined && (
                                    <span className="wf-otpar-phase-time">{(entry.durationMs / 1000).toFixed(1)}s</span>
                                  )}
                                  {isLatest && <span className="wf-otpar-phase-dot" />}
                                </div>
                                <div className="wf-otpar-phase-detail">{entry.detail}</div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="workflow-empty" style={{ padding: '20px 0' }}>
                <div className="workflow-empty-icon" style={{ fontSize: 24 }}>
                  <i className="ri-loader-4-line ri-spin" />
                </div>
                <div className="workflow-empty-text">收集认知数据中…</div>
              </div>
            )}
          </section>
        ) : (
          <div className="workflow-empty" style={{ padding: '60px 0' }}>
            <div className="workflow-empty-icon">
              <i className="ri-brain-line" />
            </div>
            <div className="workflow-empty-text">没有认知数据</div>
            <div className="workflow-empty-sub">AI 思考过程中会显示 OTPAR 认知循环</div>
          </div>
        )}
      </ErrorBoundary>
    </div>
  )
}
