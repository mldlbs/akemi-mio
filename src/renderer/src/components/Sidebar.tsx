import { useMemo } from 'react'
import type { SessionItem } from '../slots/types'

interface SidebarProps {
  sessions: SessionItem[]
  activeSessionId: string
  onSelectChat: (id: string) => void
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a),
    db = new Date(b)
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
}

function formatGroupLabel(timestamp: number): string {
  const now = Date.now()
  if (isSameDay(timestamp, now)) return '今天'
  if (isSameDay(timestamp, now - 86400000)) return '昨天'
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

/** 按 lastActivityAt 分组为日期段 */
function groupSessions(sessions: SessionItem[]) {
  const dateGroupMap = new Map<string, SessionItem[]>()
  for (const s of sessions) {
    const label = formatGroupLabel(s.lastActivityAt)
    if (!dateGroupMap.has(label)) {
      dateGroupMap.set(label, [])
    }
    dateGroupMap.get(label)!.push(s)
  }
  return Array.from(dateGroupMap.entries())
}

export function Sidebar({ sessions, activeSessionId, onSelectChat }: SidebarProps) {
  const groups = useMemo(() => groupSessions(sessions), [sessions])

  return (
    <aside className="sidebar">
      <div className="sidebar-content">
        {sessions.length === 0 ? (
          <div className="sidebar-empty">暂无会话 · 输入文字或点击麦克风开始</div>
        ) : (
          groups.map(([date, items]) => (
            <div key={date}>
              <div className="sidebar-date-header">{date}</div>
              {items.map((s) => (
                <button
                  key={s.id}
                  className={`sidebar-item${s.id === activeSessionId ? ' active' : ''}`}
                  onClick={() => onSelectChat(s.id)}
                >
                  <i className="ri-chat-1-line sidebar-icon" />
                  <span title={s.label}>{s.label}</span>
                  <span className="sidebar-item-time">
                    {new Date(s.lastActivityAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
