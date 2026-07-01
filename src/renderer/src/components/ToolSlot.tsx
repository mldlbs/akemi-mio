import type { ToolEvent } from '../slots/types'
import { useAgentStore } from '../store/agentStore'

export function ToolSlot() {
  const toolRunning = useAgentStore((s) => s.toolRunning)
  const toolCompleted = useAgentStore((s) => s.toolCompleted)

  const allEmpty = toolRunning.length === 0 && toolCompleted.length === 0

  if (allEmpty) {
    return (
      <div className="tool-slot">
        <div className="tool-empty-icon">
          <i className="ri-tools-line" />
        </div>
        <div className="chat-empty-text tool-empty-text">AI 在回答过程中使用工具时，工具调用会显示在此</div>
      </div>
    )
  }

  return (
    <div className="tool-slot tool-slot-content">
      {toolRunning.length > 0 && (
        <div className="tool-slot-section">
          <div className="tool-slot-heading">执行中</div>
          {toolRunning.map((t) => (
            <div key={t.id} className="tool-item tool-item-running">
              <div className="tool-item-icon">
                <i className="ri-loader-4-line ri-spin" />
              </div>
              <div className="tool-item-body">
                <div className="tool-item-name">{t.tool}</div>
                {t.args && <div className="tool-item-args">{JSON.stringify(t.args).slice(0, 120)}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      {toolCompleted.length > 0 && (
        <div className="tool-slot-section">
          <div className="tool-slot-heading">已执行</div>
          {toolCompleted.map((t) => (
            <div key={t.id} className={`tool-item ${t.error ? 'tool-item-failed' : 'tool-item-done'}`}>
              <div className="tool-item-icon">
                <i className={`ri-${t.error ? 'close-circle-line' : 'check-line'}`} />
              </div>
              <div className="tool-item-body">
                <div className="tool-item-name">{t.tool}</div>
                <div className="tool-item-meta">
                  {t.latencyMs !== undefined && <span>{(t.latencyMs / 1000).toFixed(1)}s</span>}
                  {t.error && <span className="tool-error-text">{t.error}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
