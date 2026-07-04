import { create } from 'zustand'
import type { SessionItem, MessageItem } from '../slots/types'

interface SessionState {
  sessions: SessionItem[]
  sessionsLoading: boolean
  activeSessionId: string
  historyMessages: MessageItem[]
  historyLoading: boolean
  skipDbLoad: boolean
}

interface SessionActions {
  setSessions: (sessions: SessionItem[]) => void
  setActiveSessionId: (id: string) => void
  setHistoryMessages: (messages: MessageItem[]) => void
  addHistoryMessage: (message: MessageItem) => void
  clearHistoryMessages: () => void
  setSessionsLoading: (loading: boolean) => void
  setHistoryLoading: (loading: boolean) => void
  setSkipDbLoad: (skip: boolean) => void
  selectChat: (sessionId: string) => void
}

type SessionStore = SessionState & SessionActions

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  sessionsLoading: true,
  activeSessionId: '',
  historyMessages: [],
  historyLoading: false,
  skipDbLoad: false,

  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setHistoryMessages: (historyMessages) => set({ historyMessages }),
  addHistoryMessage: (message) =>
    set((state) => ({
      historyMessages: state.historyMessages.some((m) => m.id === message.id) ? state.historyMessages : [...state.historyMessages, message],
    })),
  clearHistoryMessages: () => set({ historyMessages: [] }),
  setSessionsLoading: (sessionsLoading) => set({ sessionsLoading }),
  setHistoryLoading: (historyLoading) => set({ historyLoading }),
  setSkipDbLoad: (skipDbLoad) => set({ skipDbLoad }),
  selectChat: (sessionId) => set({ activeSessionId: sessionId, historyMessages: [] }),
}))
