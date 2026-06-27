const HISTORY_ITEMS = [
  { label: '会话记录', time: '' },
]

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">Recent</div>
      <div className="sidebar-content">
        {HISTORY_ITEMS.length === 0 && (
          <div style={{ padding: 'var(--space-lg)', color: 'var(--text-muted)', fontSize: 'var(--fs-small)', textAlign: 'center' }}>
            暂无会话
          </div>
        )}
        {HISTORY_ITEMS.map((item, i) => (
          <button key={i} className="sidebar-item active">
            <i className="ri-chat-1-line" style={{ fontSize: 14, opacity: 0.6 }} />
            <span>{item.label}</span>
            {item.time && <span className="sidebar-item-time">{item.time}</span>}
          </button>
        ))}
      </div>
      <div style={{ padding: 'var(--space-sm)', borderTop: '1px solid var(--border-glass)' }}>
        <button className="sidebar-item" title="搜索">
          <i className="ri-search-line" style={{ fontSize: 14, opacity: 0.6 }} />
          <span>搜索</span>
        </button>
      </div>
    </aside>
  )
}
