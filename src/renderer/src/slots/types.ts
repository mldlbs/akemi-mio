export type ActiveSlot = 'chat' | 'tool' | 'preview' | 'workflow' | 'otpar' | 'devplan'

export interface UiState {
  sidebarOpen: boolean
  activeSlot: ActiveSlot
}

export interface MessageItem {
  id: string
  source: 'electron' | 'telegram'
  role: 'user' | 'assistant'
  content: string
  category: string
  sessionId?: string
  createdAt: number
}

export interface SessionItem {
  id: string
  source: 'electron' | 'telegram'
  category: string
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
  timeout?: boolean
  cancelled?: boolean
}
