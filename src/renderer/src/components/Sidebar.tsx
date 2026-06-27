import { useMemo } from 'react'

interface SessionItem {
  id: string
  label: string
  messageCount: number
  lastActivityAt: number
  createdAt: number
}

interface SidebarProps {
  sessions: SessionItem[]
  activeSessionId: string
  onSelectChat: (id: string) => void
}

/** 按 lastActivityAt 分组为日期段 */
function groupSessions(sessions: SessionItem[]) {
  const dateGroupMap = new Map<string, SessionItem[]>()
  for (const s of sessions) {
    const d = new Date(s.lastActivityAt)
    const dateStr = d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    if (!dateGroupMap.has(dateStr)) {
      dateGroupMap.set(dateStr, [])
    }
    dateGroupMap.get(dateStr)!.push(s)
  }
  return Array.from(dateGroupMap.entries())
}

export function Sidebar({ sessions, activeSessionId, onSelectChat }: SidebarProps) {
  const groups = useMemo(() => groupSessions(sessions), [sessions])

  return (
    <aside className="sidebar">
      <div className="sidebar-content">
        {sessions.length === 0 ? (
          <div style={{ padding: 'var(--space-xl) var(--space-lg)', color: 'var(--text-muted)', fontSize: 'var(--fs-small)', textAlign: 'center' }}>
            暂无会话
          </div>
        ) : (
          groups.map(([date, items]) => (
            <div key={date}>
              <div className="sidebar-header">{date}</div>
              {items.map((s) => (
                <button
                  key={s.id}
                  className={`sidebar-item${s.id === activeSessionId ? ' active' : ''}`}
                  onClick={() => onSelectChat(s.id)}
                >
                  <i className="ri-chat-1-line" style={{ fontSize: 14, opacity: 0.6 }} />
                  <span>{s.label}</span>
                  <span className="sidebar-item-time">
                    {new Date(s.lastActivityAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
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
