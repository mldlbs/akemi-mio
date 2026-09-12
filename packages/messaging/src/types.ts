export type ChannelName = 'telegram'

export interface MediaRef {
  id: string
  mimeType?: string
  name?: string
  url?: string
}

export interface ExternalMessage {
  id: string
  channel: ChannelName
  userId: string
  timestamp: number
  content: {
    type: 'text' | 'image' | 'voice' | 'file' | 'command'
    text?: string
    command?: string
    args?: string[]
    media?: MediaRef
  }
  context: {
    chatId: string
    replyTo?: string
    threadId?: string
  }
  metadata: {
    telegramMessageId: number
    raw?: unknown
  }
}

export interface InteractionRequest {
  type: 'conversation' | 'command'
  command?: string
  args?: string[]
}

export interface AuthorizationRequest {
  type: 'authorization'
  command: 'approve'
  args: string[]
}

export interface NotificationEvent {
  trigger:
    | 'task_stuck'
    | 'evolution_complete'
    | 'security_alert'
    | 'memory_update'
    | 'budget_exhausted'
    | 'budget_restored'
    | 'plan_update'
    | 'recovery_update'
    | 'stability_alert'
    | 'system_update'
  confidence: number
  urgency: 'low' | 'medium' | 'high'
  requireAction: boolean
  title: string
  body: string
  actions?: Array<{ label: string; command: string }>
  context: { chatId: string; threadId?: string }
}

export interface AgentResponse {
  id: string
  status: 'thinking' | 'working' | 'waiting' | 'completed' | 'failed'
  progress?: number
  message: string
  context: { chatId: string; threadId?: string }
}

export interface ChatResult {
  reply?: string
  error?: string
}

/** Adapter contract for telegram-side notification rendering (provided by host). */
export interface TelegramRenderer {
  renderNotification(event: NotificationEvent): {
    chatId: string
    bot?: 'chat' | 'push' | 'gen' | 'write'
    msgType: 'send' | 'edit' | 'reply' | 'action' | 'photo' | 'media_group'
    message: string
  }
}

/** Outbox writer contract (provided by host — avoids cross-package import of db/outbox). */
export type OutboxInsert = (row: {
  chatId: string
  bot?: 'chat' | 'push' | 'gen' | 'write'
  msgType: 'send' | 'edit' | 'reply' | 'action' | 'photo' | 'media_group'
  category?: string
  message: string
}) => number

/** Minimal agent-service surface needed by the gateway. */
export interface AgentServicePort {
  processExternalMessage(message: ExternalMessage): Promise<ChatResult> | ChatResult
  clearContext(): void
}
