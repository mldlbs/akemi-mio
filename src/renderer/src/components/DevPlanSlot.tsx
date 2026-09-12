import { usePlansStore } from '../store/plansStore'
import { ErrorBoundary } from './ErrorBoundary'

function stageIcon(status: string): string {
  switch (status) {
    case 'done':
      return 'ri-checkbox-circle-fill'
    case 'in_progress':
      return 'ri-loader-4-line ri-spin'
    case 'failed':
      return 'ri-close-circle-fill'
    default:
      return 'ri-checkbox-blank-circle-line'
  }
}

export function DevPlanSlot() {
  const activePlan = usePlansStore((s) => s.activePlan)
  const doneSteps = activePlan?.steps.filter((s: any) => s.status === 'done').length ?? 0
  const totalSteps = activePlan?.steps.length ?? 0
  const progress = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0

  return (
    <div className="devplan-slot">
      <ErrorBoundary>
        <div className="devplan-header">
          <i className="ri-code-s-slash-line" />
          <span>开发计划</span>
        </div>

        {activePlan ? (
          <div className="devplan-body">
            <div className="devplan-card">
              <div className="devplan-card-top">
                <h3 className="devplan-title">{activePlan.title}</h3>
                <span className={`devplan-status devplan-status--${activePlan.status}`}>
                  <i
                    className={
                      activePlan.status === 'in_progress' || activePlan.status === 'running'
                        ? 'ri-loader-4-line ri-spin'
                        : activePlan.status === 'done' || activePlan.status === 'completed'
                          ? 'ri-check-line'
                          : 'ri-time-line'
                    }
                  />
                  {activePlan.status === 'in_progress'
                    ? '进行中'
                    : activePlan.status === 'done' || activePlan.status === 'completed'
                      ? '已完成'
                      : activePlan.status === 'failed'
                        ? '失败'
                        : activePlan.status === 'running'
                          ? '运行中'
                          : activePlan.status}
                </span>
              </div>

              <div className="devplan-progress">
                <div className="devplan-progress-bar">
                  <div className="devplan-progress-fill" style={{ width: `${Math.max(progress, 3)}%` }} />
                </div>
                <span className="devplan-progress-text">
                  {doneSteps}/{totalSteps} 步
                </span>
              </div>
            </div>

            <div className="devplan-steps">
              <div className="devplan-steps-header">
                <span>执行步骤</span>
              </div>
              {activePlan.steps.map((step: any, idx: number) => {
                const isRunning = step.status === 'in_progress' || step.status === 'running'
                const isDone = step.status === 'done' || step.status === 'completed'
                const isFailed = step.status === 'failed'
                return (
                  <div
                    key={step.id}
                    className={`devplan-step devplan-step--${isDone ? 'done' : isRunning ? 'running' : isFailed ? 'failed' : 'pending'}`}
                  >
                    <div className="devplan-step-icon">
                      {isRunning ? <div className="devplan-step-spinner" /> : <i className={stageIcon(step.status)} />}
                    </div>
                    <div className="devplan-step-body">
                      <div className="devplan-step-title">
                        <span className="devplan-step-num">#{idx + 1}</span>
                        <span>{step.description}</span>
                      </div>
                      {step.result && <div className="devplan-step-result">{step.result}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="devplan-empty">
            <div className="devplan-empty-icon">
              <i className="ri-code-s-slash-line" />
            </div>
            <div className="devplan-empty-text">当前没有活跃的开发计划</div>
            <div className="devplan-empty-sub">向 AI 描述需求，自动生成开发管线</div>
          </div>
        )}
      </ErrorBoundary>
    </div>
  )
}
