import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { UiState, ActiveSlot } from './types'

interface SlotContextValue {
  uiState: UiState
  setActiveSlot: (slot: ActiveSlot) => void
  setActiveChatId: (id: string) => void
  toggleSidebar: () => void
  setCommandMode: (mode: boolean) => void
}

const SlotContext = createContext<SlotContextValue | null>(null)

export function SlotProvider({ children }: { children: ReactNode }) {
  const [uiState, setUiState] = useState<UiState>({
    activeChatId: '',
    sidebarOpen: true,
    activeSlot: 'chat',
    commandMode: false,
  })

  const setActiveSlot = useCallback((slot: ActiveSlot) => {
    setUiState((s) => ({ ...s, activeSlot: slot, commandMode: false }))
  }, [])

  const setActiveChatId = useCallback((id: string) => {
    setUiState((s) => ({ ...s, activeChatId: id }))
  }, [])

  const toggleSidebar = useCallback(() => {
    setUiState((s) => ({ ...s, sidebarOpen: !s.sidebarOpen }))
  }, [])

  const setCommandMode = useCallback((mode: boolean) => {
    setUiState((s) => ({ ...s, commandMode: mode }))
  }, [])

  return <SlotContext.Provider value={{ uiState, setActiveSlot, setActiveChatId, toggleSidebar, setCommandMode }}>{children}</SlotContext.Provider>
}

export function useSlots(): SlotContextValue {
  const ctx = useContext(SlotContext)
  if (!ctx) throw new Error('useSlots must be used within SlotProvider')
  return ctx
}
