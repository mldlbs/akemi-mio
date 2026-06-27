export function ToolSlot() {
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
