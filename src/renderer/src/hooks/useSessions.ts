import { useEffect, useRef } from 'react'
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

  // message:new 只添加消息，不重新拉全量 sessions 列表
  // 除非是新会话（activeSessionId 不同）才更新
  const lastMsgRef = useRef(0)
  useIPCEvent<MessageItem>(window.electronAPI.onMessageNew as any, (msg) => {
    if (!msg.sessionId) return
    // 防止重复消息（IPC 可能多发）
    if (msg.createdAt <= lastMsgRef.current) return
    lastMsgRef.current = msg.createdAt

    if (msg.sessionId !== store.activeSessionId) {
      if (msg.category !== 'evolution') {
        store.setSkipDbLoad(true)
        store.setActiveSessionId(msg.sessionId)
        // 切到新会话时才重新拉 sessions
        window.electronAPI
          .getSessions()
          .then((s) => store.setSessions(s))
          .catch(() => {})
      }
    } else {
      // 同一会话只添加消息，不刷新 sessions
      store.addHistoryMessage(msg)
    }
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
