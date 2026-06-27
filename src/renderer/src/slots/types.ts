export type ActiveSlot = 'chat' | 'tool' | 'preview'

export interface UiState {
  sidebarOpen: boolean
  activeSlot: ActiveSlot
}

export interface MessageItem {
  id: string
  source: 'electron' | 'telegram'
  role: 'user' | 'assistant'
  content: string
  sessionId?: string
  createdAt: number
}

export interface SessionItem {
  id: string
  label: string
  messageCount: number
  lastActivityAt: number
  createdAt: number
}

export interface ToolEvent {
  id: string
  tool: string
  args?: Record<string, any>
  result?: string
  error?: string
  latencyMs?: number
}
