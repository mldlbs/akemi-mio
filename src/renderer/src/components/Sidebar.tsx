import { useMemo } from 'react'
import type { MessageItem } from './ChatBubble'

interface SidebarProps {
  historyMessages: MessageItem[]
  activeChatId: string
  onSelectChat: (id: string) => void
}

/** 按用户消息分组为会话列表 */
function buildSessionGroups(messages: MessageItem[]) {
  const dateGroupMap = new Map<string, { label: string; firstMsgId: string; time: string }[]>()

  for (const m of messages) {
    if (m.role !== 'user') continue
    const d = new Date(m.createdAt)
    const dateStr = d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    const timeStr = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

    if (!dateGroupMap.has(dateStr)) {
      dateGroupMap.set(dateStr, [])
    }
    const list = dateGroupMap.get(dateStr)!
    if (list.length === 0 || list[list.length - 1].firstMsgId !== m.id) {
      list.push({ label: m.content.slice(0, 30), firstMsgId: m.id, time: timeStr })
    }
  }

  return Array.from(dateGroupMap.entries()).map(([date, sessions]) => ({ date, sessions }))
}

export function Sidebar({ historyMessages, activeChatId, onSelectChat }: SidebarProps) {
  const groups = useMemo(() => buildSessionGroups(historyMessages), [historyMessages])

  return (
    <aside className="sidebar">
      <div className="sidebar-content">
        {groups.length === 0 ? (
          <div style={{ padding: 'var(--space-xl) var(--space-lg)', color: 'var(--text-muted)', fontSize: 'var(--fs-small)', textAlign: 'center' }}>
            暂无会话
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.date}>
              <div className="sidebar-header">{g.date}</div>
              {g.sessions.map((s) => (
                <button
                  key={s.firstMsgId}
                  className={`sidebar-item${s.firstMsgId === activeChatId ? ' active' : ''}`}
                  onClick={() => onSelectChat(s.firstMsgId)}
                >
                  <i className="ri-chat-1-line" style={{ fontSize: 14, opacity: 0.6 }} />
                  <span>{s.label}</span>
                  <span className="sidebar-item-time">{s.time}</span>
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
