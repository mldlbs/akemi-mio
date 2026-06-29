import { useState, useEffect, useCallback, useRef } from 'react'
import { useIPCEvent } from './useIPCEvent'
import type { SessionItem, MessageItem } from '../slots/types'

const EMPTY: MessageItem[] = []

export function useSessions() {
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [activeSessionId, setActiveSessionId] = useState<string>('')
  const [historyMessages, setHistoryMessages] = useState<MessageItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const skipDbLoadRef = useRef(false)

  useEffect(() => {
    window.electronAPI
      .getSessions()
      .then((s) => {
        setSessions(s as SessionItem[])
        if (s.length > 0) {
          setActiveSessionId((prev) => prev || s[0].id)
        }
      })
      .catch(() => {})
      .finally(() => setSessionsLoading(false))
  }, [])

  // DB 加载只用于 mount/handleSelectChat，onMessageNew 触发的切换跳过
  useEffect(() => {
    if (!activeSessionId) return
    if (skipDbLoadRef.current) {
      skipDbLoadRef.current = false
      return
    }
    setHistoryLoading(true)
    window.electronAPI
      .getMessagesBySession(activeSessionId)
      .then((msgs) => setHistoryMessages(msgs as MessageItem[]))
      .catch(() => setHistoryMessages([]))
      .finally(() => setHistoryLoading(false))
  }, [activeSessionId])

  useIPCEvent<MessageItem>(window.electronAPI.onMessageNew as any, (msg) => {
    if (!msg.sessionId) return
    if (msg.sessionId !== activeSessionId) {
      // 进化消息不强制切换会话，避免打扰用户
      if (msg.category !== 'evolution') {
        skipDbLoadRef.current = true
        setActiveSessionId(msg.sessionId)
      }
    }
    setHistoryMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]))
    window.electronAPI
      .getSessions()
      .then((s) => setSessions(s as SessionItem[]))
      .catch(() => {})
  })

  const handleSelectChat = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    setHistoryMessages([])
  }, [])

  return { sessions, sessionsLoading, activeSessionId, historyMessages, historyLoading, handleSelectChat } as const
}
