import { useEffect, useState, type MouseEvent } from 'react'
import type { ToolEvent } from '../slots/types'
import { useAgentStore } from '../store/agentStore'

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState('00:00')
  useEffect(() => {
    let frame: number
    const tick = () => {
      const sec = Math.floor((Date.now() - startedAt) / 1000)
      const m = Math.floor(sec / 60)
      const s = sec % 60
      setElapsed(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [startedAt])
  return <span className="tool-elapsed">{elapsed}</span>
}

function CollapsibleJson({ data, max = 80 }: { data: Record<string, any>; max?: number }) {
  const raw = JSON.stringify(data)
  const [open, setOpen] = useState(false)
  if (raw.length <= max) return <div className="tool-item-args">{raw}</div>
  return (
    <div className="tool-item-args">
      <span className="tool-args-preview">{open ? raw : raw.slice(0, max) + '…'}</span>
      <button className="tool-args-toggle" onClick={() => setOpen(!open)}>
        {open ? '收起' : '展开'}
      </button>
    </div>
  )
}

function ToolIcon({ status, error, timeout, cancelled }: { status: string; error?: string; timeout?: boolean; cancelled?: boolean }) {
  if (status === 'running') {
    return <i className="ri-loader-4-line ri-spin" />
  }
  if (timeout) return <i className="ri-time-line" />
  if (cancelled) return <i className="ri-stop-circle-line" />
  if (error) return <i className="ri-close-circle-line" />
  return <i className="ri-check-line" />
}

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

  const handleCancel = (e: MouseEvent) => {
    e.stopPropagation()
    window.electronAPI.stopConversation().catch(() => {})
  }

  return (
    <div className="tool-slot tool-slot-content">
      {toolRunning.length > 0 && (
        <div className="tool-slot-section">
          <div className="tool-slot-heading">
            <span>执行中</span>
            <span className="tool-count-badge">{toolRunning.length}</span>
          </div>
          {toolRunning.map((t) => (
            <div key={t.id} className="tool-item tool-item-running">
              <div className="tool-item-icon">
                <ToolIcon status="running" />
              </div>
              <div className="tool-item-body">
                <div className="tool-item-name">{t.tool}</div>
                {t.args && Object.keys(t.args).length > 0 && <CollapsibleJson data={t.args} />}
                <div className="tool-item-meta">
                  <ElapsedTimer startedAt={t.startedAt ?? Date.now()} />
                </div>
              </div>
              <button className="tool-cancel-btn" onClick={handleCancel} title="取消此工具">
                <i className="ri-close-line" />
              </button>
            </div>
          ))}
        </div>
      )}

      {toolCompleted.length > 0 && (
        <div className="tool-slot-section">
          <div className="tool-slot-heading">
            <span>已执行</span>
            <span className="tool-count-badge">{toolCompleted.length}</span>
          </div>
          {toolCompleted.map((t) => {
            const isTimeout = t.timeout ?? false
            const isCancelled = t.cancelled ?? false
            const isError = !!t.error && !isTimeout && !isCancelled
            const cssClass = isTimeout
              ? 'tool-item-timedout'
              : isCancelled
                ? 'tool-item-cancelled'
                : isError
                  ? 'tool-item-failed'
                  : 'tool-item-done'

            return (
              <div key={t.id} className={`tool-item ${cssClass}`}>
                <div className="tool-item-icon">
                  <ToolIcon status="done" error={t.error} timeout={isTimeout} cancelled={isCancelled} />
                </div>
                <div className="tool-item-body">
                  <div className="tool-item-name">{t.tool}</div>
                  <div className="tool-item-meta">
                    {t.latencyMs !== undefined && <span className="tool-latency">{(t.latencyMs / 1000).toFixed(1)}s</span>}
                    {isTimeout && <span className="tool-error-text">超时</span>}
                    {isCancelled && <span className="tool-cancelled-text">已取消</span>}
                    {isError && <span className="tool-error-text">{t.error}</span>}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
