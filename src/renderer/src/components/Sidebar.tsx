import { useSessionStore } from '../store/sessionStore'
import { useHistoryViewStore } from '../store/historyViewStore'
import { useSlots } from '../slots/SlotContext'
import { useCallback, useMemo } from 'react'
import type { SessionItem } from '../slots/types'

const COLLAPSED_ICONS: Record<string, string> = {
  chat: 'ri-chat-1-line',
  writing: 'ri-quill-pen-line',
  image_gen: 'ri-image-ai-line',
  evolution: 'ri-robot-2-line',
  creativity: 'ri-lightbulb-line',
  dream: 'ri-moon-line',
}

const CATEGORY_LABELS: Record<string, string> = {
  chat: '对话',
  writing: '写作',
  image_gen: '生图',
  evolution: '进化',
  creativity: '创意',
  dream: '梦境',
}

const CATEGORY_ORDER = ['chat', 'writing', 'image_gen', 'evolution', 'creativity', 'dream'] as const

export function Sidebar() {
  const sessions = useSessionStore((s) => s.sessions)
  const sessionsLoading = useSessionStore((s) => s.sessionsLoading)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const { viewing, sessionId: historySessionId, openHistory, closeHistory } = useHistoryViewStore()
  const { uiState, setActiveSlot, toggleSidebar } = useSlots()
  const collapsed = !uiState.sidebarOpen

  const onHistoryClick = useCallback(
    (sessionId: string, label: string) => {
      if (!sessionId) return
      if (sessionId === activeSessionId && viewing) {
        closeHistory()
      } else if (sessionId !== activeSessionId) {
        openHistory(sessionId, label)
        setActiveSlot('chat')
      }
    },
    [activeSessionId, viewing, openHistory, closeHistory, setActiveSlot],
  )

  const sorted = useMemo(() => {
    return [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }, [sessions])

  const categorySet = useMemo(() => {
    const set = new Set<string>()
    for (const s of sessions) set.add(s.category)
    return set
  }, [sessions])

  const grouped = useMemo(() => {
    const map = new Map<string, SessionItem[]>()
    for (const cat of CATEGORY_ORDER) map.set(cat, [])
    for (const s of sorted) {
      const list = map.get(s.category)
      if (list) list.push(s)
    }
    return map
  }, [sorted])

  const hasSessions = useMemo(() => {
    for (const s of sessions) if (s) return true
    return false
  }, [sessions])

  function formatTime(ts: number): string {
    const now = Date.now()
    const diff = now - ts
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
    return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  if (sessionsLoading) {
    return (
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-content">
          {collapsed ? (
            <button className="sidebar-collapsed-icon" onClick={toggleSidebar} title="展开侧栏">
              <i className="ri-menu-unfold-line" />
            </button>
          ) : (
            <div className="sidebar-empty">
              <i className="ri-loader-4-line ri-spin" />
            </div>
          )}
        </div>
      </aside>
    )
  }

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <div className="sidebar-content">
          <button className="sidebar-collapsed-icon" onClick={toggleSidebar} title="展开侧栏">
            <i className="ri-menu-unfold-line" />
          </button>
          {Array.from(categorySet).map((cat) => (
            <button
              key={cat}
              className="sidebar-collapsed-icon"
              title={cat}
              onClick={() => {
                const first = sorted.find((s) => s.category === cat)
                if (first) onHistoryClick(first.id, first.label)
              }}
            >
              <i className={COLLAPSED_ICONS[cat] || 'ri-chat-1-line'} />
            </button>
          ))}
        </div>
      </aside>
    )
  }

  if (!hasSessions) {
    return (
      <aside className="sidebar">
        <div className="sidebar-content">
          <div className="sidebar-empty">暂无对话</div>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-content">
        {CATEGORY_ORDER.map((cat) => {
          const items = grouped.get(cat)
          if (!items || items.length === 0) return null
          return (
            <div key={cat} className="sidebar-section">
              <div className="sidebar-section-label">{CATEGORY_LABELS[cat] || cat}</div>
              {items.map((s) => (
                <button
                  key={s.id}
                  className={`sidebar-item${s.id === activeSessionId ? ' active' : ''}${s.id === historySessionId && viewing ? ' viewing-history' : ''}`}
                  onClick={() => onHistoryClick(s.id, s.label)}
                >
                  <span className="sidebar-item-label" title={s.label}>
                    {s.label}
                  </span>
                  {s.id === activeSessionId && <span className="sidebar-current-badge">当前</span>}
                  <span className="sidebar-item-time">{formatTime(s.lastActivityAt)}</span>
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
