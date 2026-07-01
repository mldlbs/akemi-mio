import { useSessionStore } from '../store/sessionStore'
import { useSlots } from '../slots/SlotContext'
import { useCallback, useMemo } from 'react'
import type { SessionItem } from '../slots/types'

const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  chat: { label: '聊天', icon: 'ri-chat-1-line' },
  writing: { label: '写作', icon: 'ri-quill-pen-line' },
  image_gen: { label: '生图', icon: 'ri-image-ai-line' },
  evolution: { label: '进化', icon: 'ri-robot-2-line' },
  creativity: { label: '创造力', icon: 'ri-lightbulb-line' },
  dream: { label: '梦境', icon: 'ri-moon-line' },
}

const CATEGORY_ORDER = ['chat', 'writing', 'image_gen', 'evolution', 'creativity', 'dream'] as const

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

export function Sidebar() {
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const handleSelectChat = useSessionStore((s) => s.selectChat)
  const { setActiveSlot } = useSlots()

  const onSelectChat = useCallback(
    (sessionId: string) => {
      handleSelectChat(sessionId)
      setActiveSlot('chat')
    },
    [handleSelectChat, setActiveSlot],
  )

  const grouped = useMemo(() => {
    const map = new Map<string, SessionItem[]>()
    for (const s of sessions) {
      const cat = CATEGORY_META[s.category] ? s.category : 'chat'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(s)
    }
    return map
  }, [sessions])

  const panels = useMemo(() => {
    const cats = Array.from(grouped.keys()).sort((a, b) => CATEGORY_ORDER.indexOf(a as any) - CATEGORY_ORDER.indexOf(b as any))
    return cats.map((cat) => ({
      cat,
      meta: CATEGORY_META[cat] || { label: cat, icon: 'ri-chat-1-line' },
      groups: groupSessions(grouped.get(cat)!.sort((a, b) => b.lastActivityAt - a.lastActivityAt)),
    }))
  }, [grouped])

  if (sessions.length === 0) {
    return (
      <aside className="sidebar">
        <div className="sidebar-content">
          <div className="sidebar-empty">暂无会话 · 输入文字或点击麦克风开始</div>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-content">
        {panels.map(({ cat, meta, groups }) => (
          <div key={cat} className="sidebar-panel">
            <div className="sidebar-panel-header">
              <i className={meta.icon} />
              <span>{meta.label}</span>
            </div>
            {groups.map(([date, items]) => (
              <div key={date}>
                <div className="sidebar-date-header">{date}</div>
                {items.map((s) => (
                  <button
                    key={s.id}
                    className={`sidebar-item${s.id === activeSessionId ? ' active' : ''}`}
                    onClick={() => onSelectChat(s.id)}
                  >
                    <span title={s.label}>{s.label}</span>
                    <span className="sidebar-item-time">
                      {new Date(s.lastActivityAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}
