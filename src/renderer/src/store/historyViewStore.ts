import { create } from 'zustand'
import type { MessageItem } from '../slots/types'

interface HistoryViewState {
  viewing: boolean
  sessionId: string | null
  sessionLabel: string
  messages: MessageItem[]
  loading: boolean
  error: string | null
}

interface HistoryViewActions {
  openHistory: (sessionId: string, label: string) => void
  closeHistory: () => void
  setMessages: (messages: MessageItem[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

type HistoryViewStore = HistoryViewState & HistoryViewActions

export const useHistoryViewStore = create<HistoryViewStore>((set) => ({
  viewing: false,
  sessionId: null,
  sessionLabel: '',
  messages: [],
  loading: false,
  error: null,

  openHistory: (sessionId, label) => {
    set({ viewing: true, sessionId, sessionLabel: label, messages: [], loading: true, error: null })
    window.electronAPI
      .getMessagesBySession(sessionId)
      .then((msgs) => set({ messages: msgs, loading: false }))
      .catch(() => set({ error: '加载失败', loading: false }))
  },

  closeHistory: () => {
    set({ viewing: false, sessionId: null, sessionLabel: '', messages: [], loading: false, error: null })
  },

  setMessages: (messages) => set({ messages }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}))
