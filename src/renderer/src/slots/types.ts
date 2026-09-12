export type ActiveSlot = 'chat' | 'tool' | 'preview' | 'workflow' | 'otpar' | 'devplan' | 'blog'

export interface UiState {
  sidebarOpen: boolean
  rightPanelOpen: boolean
  activeSlot: ActiveSlot
}

// 说明：source 在后端是数据库自由字符串列（IPC 契约声明为 string），
// 已知取值为 'electron' | 'telegram'，但不可假定只有这两种 ——
// 原先写成字面量联合与传输层契约不符，导致每个消费点都要靠断言绕过。
export interface MessageItem {
  id: string
  source: string
  // 同理：role 在库里也是自由字符串（已知 'user' | 'assistant'，另有 'system' 等）。
  // 全仓没有对 role 的穷尽 switch，宽化为 string 不影响任何判定分支。
  role: string
  content: string
  category: string
  sessionId?: string
  createdAt: number
}

export interface SessionItem {
  id: string
  source: string
  category: string
  label: string
  messageCount: number
  lastActivityAt: number
  createdAt: number
}

export interface ToolIPCEvent {
  id: string
  tool: string
  args?: Record<string, any>
  result?: string
  error?: string
  latencyMs?: number
}
