export interface AgentIngressContext {
  channel?: 'telegram'
  chatId?: string
  userId?: string
  messageId?: number
  replyTo?: string
  threadId?: string
  raw?: unknown
  telegramChatId?: number
  telegramUserId?: number
  telegramFrom?: string
  telegramMessageId?: number
}
