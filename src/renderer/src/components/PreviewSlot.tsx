export function PreviewSlot() {
  return (
    <div className="preview-slot">
      <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 'var(--space-xxl) 0' }}>
        <div style={{ fontSize: 28, opacity: 0.2, marginBottom: 'var(--space-md)' }}>
          <i className="ri-eye-line" />
        </div>
        <div className="chat-empty-text">结果预览</div>
      </div>
    </div>
  )
}
