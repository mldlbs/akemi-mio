export type ActiveSlot = 'chat' | 'tool' | 'preview' | null

export interface UiState {
  activeChatId: string
  sidebarOpen: boolean
  activeSlot: ActiveSlot
  commandMode: boolean
}

export interface SlotRegistry {
  tool?: React.ReactNode
  preview?: React.ReactNode
}
