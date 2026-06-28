import { ErrorBoundary } from './ErrorBoundary'

interface Props {
  activePlan: any
}

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

export function DevPlanSlot({ activePlan }: Props) {
  const doneSteps = activePlan?.steps.filter((s: any) => s.status === 'done').length ?? 0
  const totalSteps = activePlan?.steps.length ?? 0
  const progress = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0

  return (
    <div className="workflow-slot workflow-slot-content">
      <ErrorBoundary>
        {activePlan ? (
          <section className="wf-plan-card running">
            <div className="wf-plan-header">
              <h3 className="wf-plan-title">{activePlan.title}</h3>
              <span className={`wf-plan-badge ${activePlan.status}`}>{activePlan.status}</span>
            </div>
            <div className="wf-progress-row">
              <div className="wf-progress-bar">
                <div className="wf-progress-fill" style={{ width: `${Math.max(progress, 4)}%` }} />
              </div>
              <span className="wf-progress-text">
                {doneSteps}/{totalSteps}
              </span>
            </div>
            <ul className="wf-steps">
              {activePlan.steps.map((step: any) => (
                <li key={step.id} className={`wf-step ${stageColor(step.status)}`}>
                  <i className={stageIcon(step.status)} />
                  <span className="wf-step-text">{step.description}</span>
                  {step.result && <span className="wf-step-result">{step.result}</span>}
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className="workflow-empty" style={{ padding: '60px 0' }}>
            <div className="workflow-empty-icon">
              <i className="ri-code-s-slash-line" />
            </div>
            <div className="workflow-empty-text">当前没有活跃的开发计划</div>
            <div className="workflow-empty-sub">向 AI 描述需求，自动生成开发管线</div>
          </div>
        )}
      </ErrorBoundary>
    </div>
  )
}
