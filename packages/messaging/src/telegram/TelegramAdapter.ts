import type { AuthorizationRequest, ExternalMessage, InteractionRequest, NotificationEvent } from '@akemi-mio/messaging'

export interface TelegramInboundMessage {
  messageId?: number
  chatId: number | string
  text?: string
  command?: string
  from: string
  userId?: number | string
  timestamp: number
  replyTo?: number
  threadId?: number | string
  bot?: string
}

export class TelegramAdapter {
  readonly channel = 'telegram' as const

  normalizeInbound(raw: TelegramInboundMessage): ExternalMessage | null {
    const text = raw.text?.trim() || (raw.command ? `/${raw.command}` : '')
    if (!text) return null
    const command = text.startsWith('/') ? text.slice(1).split(/\s+/, 1)[0] : undefined

    return {
      id: `telegram:${raw.messageId ?? raw.chatId}:${raw.timestamp}`,
      channel: 'telegram',
      userId: String(raw.userId ?? raw.from),
      timestamp: raw.timestamp,
      content: command ? { type: 'command', text, command, args: text.split(/\s+/).slice(1) } : { type: 'text', text },
      context: {
        chatId: String(raw.chatId),
        replyTo: raw.replyTo ? String(raw.replyTo) : undefined,
        threadId: raw.threadId ? String(raw.threadId) : undefined,
      },
      metadata: {
        telegramMessageId: raw.messageId ?? 0,
        raw,
      },
    }
  }

  toInteractionRequest(raw: TelegramInboundMessage): InteractionRequest | AuthorizationRequest | null {
    const inbound = this.normalizeInbound(raw)
    if (!inbound || inbound.content.type !== 'command' || !inbound.content.command) return null
    if (inbound.content.command === 'approve') {
      return { type: 'authorization', command: 'approve', args: inbound.content.args ?? [] }
    }
    return { type: 'command', command: inbound.content.command, args: inbound.content.args ?? [] }
  }

  renderNotification(event: NotificationEvent) {
    return {
      bot: 'push' as const,
      msgType: 'reply' as const,
      chatId: event.context.chatId,
      message: `${event.urgency === 'high' ? '[HIGH]' : '[INFO]'} ${event.title}\n\n${event.body}${formatActions(event.actions)}`,
    }
  }
}

function formatActions(actions?: Array<{ label: string; command: string }>): string {
  if (!actions?.length) return ''
  return `\n\n${actions.map((action) => `- ${action.label}: ${action.command}`).join('\n')}`
}
