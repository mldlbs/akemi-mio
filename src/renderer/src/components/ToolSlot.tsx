interface ToolEvent {
  id: string
  tool: string
  args?: Record<string, any>
  result?: string
  error?: string
  latencyMs?: number
}

interface ToolSlotProps {
  running?: ToolEvent[]
  completed?: ToolEvent[]
}

export function ToolSlot({ running = [], completed = [] }: ToolSlotProps) {
  const allEmpty = running.length === 0 && completed.length === 0

  if (allEmpty) {
    return (
      <div className="tool-slot">
        <div style={{ fontSize: 28, opacity: 0.2 }}>
          <i className="ri-tools-line" />
        </div>
        <div className="chat-empty-text" style={{ color: 'var(--text-muted)' }}>
          工具面板
        </div>
      </div>
    )
  }

  return (
    <div className="tool-slot" style={{ justifyContent: 'flex-start', paddingTop: 'var(--space-xl)' }}>
      {running.length > 0 && (
        <div style={{ width: '100%', maxWidth: 600, margin: '0 auto' }}>
          <div style={{ fontSize: 'var(--fs-small)', fontWeight: 500, color: 'var(--text-muted)', marginBottom: 'var(--space-sm)' }}>
            执行中
          </div>
          {running.map((t) => (
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
      {completed.length > 0 && (
        <div style={{ width: '100%', maxWidth: 600, margin: '0 auto', marginTop: running.length > 0 ? 'var(--space-lg)' : 0 }}>
          <div style={{ fontSize: 'var(--fs-small)', fontWeight: 500, color: 'var(--text-muted)', marginBottom: 'var(--space-sm)' }}>
            已执行
          </div>
          {completed.map((t) => (
            <div key={t.id} className={`tool-item ${t.error ? 'tool-item-failed' : 'tool-item-done'}`}>
              <div className="tool-item-icon">
                <i className={`ri-${t.error ? 'close-circle-line' : 'check-line'}`} />
              </div>
              <div className="tool-item-body">
                <div className="tool-item-name">{t.tool}</div>
                <div className="tool-item-meta">
                  {t.latencyMs !== undefined && <span>{(t.latencyMs / 1000).toFixed(1)}s</span>}
                  {t.error && <span style={{ color: 'oklch(0.6 0.18 30)', marginLeft: 8 }}>{t.error}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
