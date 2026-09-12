import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { UiState, ActiveSlot } from './types'

interface SlotContextValue {
  uiState: UiState
  setActiveSlot: (slot: ActiveSlot) => void
  toggleSidebar: () => void
  toggleRightPanel: () => void
}

const SlotContext = createContext<SlotContextValue | null>(null)

export function SlotProvider({ children }: { children: ReactNode }) {
  const [uiState, setUiState] = useState<UiState>({
    sidebarOpen: true,
    rightPanelOpen: false,
    activeSlot: 'chat',
  })

  const setActiveSlot = useCallback((slot: ActiveSlot) => {
    setUiState((s) => ({ ...s, activeSlot: slot }))
  }, [])

  const toggleSidebar = useCallback(() => {
    setUiState((s) => ({ ...s, sidebarOpen: !s.sidebarOpen }))
  }, [])

  const toggleRightPanel = useCallback(() => {
    setUiState((s) => ({ ...s, rightPanelOpen: !s.rightPanelOpen }))
  }, [])

  return <SlotContext.Provider value={{ uiState, setActiveSlot, toggleRightPanel, toggleSidebar }}>{children}</SlotContext.Provider>
}

export function useSlots(): SlotContextValue {
  const ctx = useContext(SlotContext)
  if (!ctx) throw new Error('useSlots must be used within SlotProvider')
  return ctx
}
