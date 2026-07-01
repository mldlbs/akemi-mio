import { useEffect } from 'react'
import { useIPCEvent } from './useIPCEvent'
import { useSessionStore } from '../store/sessionStore'
import type { MessageItem } from '../slots/types'

const EMPTY: MessageItem[] = []

export function useSessions() {
  const store = useSessionStore()

  useEffect(() => {
    window.electronAPI
      .getSessions()
      .then((s) => {
        store.setSessions(s)
        if (s.length > 0 && !store.activeSessionId) {
          store.setActiveSessionId(s[0].id)
        }
      })
      .catch(() => {})
      .finally(() => store.setSessionsLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // DB 加载只用于 mount/handleSelectChat，onMessageNew 触发的切换跳过
  useEffect(() => {
    if (!store.activeSessionId) return
    if (store.skipDbLoad) {
      store.setSkipDbLoad(false)
      return
    }
    store.setHistoryLoading(true)
    window.electronAPI
      .getMessagesBySession(store.activeSessionId)
      .then((msgs) => store.setHistoryMessages(msgs))
      .catch(() => store.setHistoryMessages(EMPTY))
      .finally(() => store.setHistoryLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.activeSessionId])

  useIPCEvent<MessageItem>(window.electronAPI.onMessageNew as any, (msg) => {
    if (!msg.sessionId) return
    if (msg.sessionId !== store.activeSessionId) {
      if (msg.category !== 'evolution') {
        store.setSkipDbLoad(true)
        store.setActiveSessionId(msg.sessionId)
      }
    }
    store.addHistoryMessage(msg)
    window.electronAPI
      .getSessions()
      .then((s) => store.setSessions(s))
      .catch(() => {})
  })

  const handleSelectChat = (sessionId: string) => {
    store.selectChat(sessionId)
  }

  return {
    sessions: store.sessions,
    sessionsLoading: store.sessionsLoading,
    activeSessionId: store.activeSessionId,
    historyMessages: store.historyMessages,
    historyLoading: store.historyLoading,
    handleSelectChat,
  } as const
}
