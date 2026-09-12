import { log } from '@akemi-mio/core/logger/Logger'
import { getPendingOutbox, markOutboxSent, markOutboxFailed, cleanupOutbox } from '@akemi-mio/core/db/outbox'

/**
 * OutboxWorker — 从 telegram_outbox 拉取 pending 消息并投递到 Telegram 代理服务器。
 * 由 TaskRunner 定时触发，自带重试和退避机制。
 */
export class OutboxWorker {
  private baseUrl: string
  private cleanupCounter = 0

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  /** 单次 tick：扫描 pending 消息并发投递。每 60 次 tick 清理一次过期消息 */
  async tick(): Promise<{ success: boolean; summary?: string }> {
    const pending = getPendingOutbox(20)
    if (pending.length === 0) {
      // 定期清理过期消息
      this.cleanupCounter++
      if (this.cleanupCounter >= 60) {
        this.cleanupCounter = 0
        const deleted = cleanupOutbox()
        if (deleted > 0) log('INFO', 'outbox_cleanup', { deleted })
      }
      return { success: true, summary: 'no pending messages' }
    }

    let sent = 0
    let failed = 0

    for (const msg of pending) {
      try {
        await this.deliver(msg)
        markOutboxSent(msg.id!)
        sent++
      } catch (err: any) {
        const errMsg = err.message ?? String(err)
        const wasDropped = markOutboxFailed(msg.id!, errMsg)
        if (wasDropped && msg.msgType === 'edit') {
          log('WARN', 'outbox_edit_dropped_fallback_to_send', { id: msg.id, error: errMsg })
        } else {
          log('WARN', 'outbox_deliver_failed', { id: msg.id, msgType: msg.msgType, error: errMsg })
        }
        failed++
      }
    }

    return { success: failed === 0, summary: `sent=${sent} failed=${failed}` }
  }

  private async deliver(msg: {
    id?: number
    chatId: string
    bot?: string
    msgType: string
    message: string
    targetMessageId?: number | null
  }): Promise<void> {
    const bot = msg.bot || 'chat'
    // Telegram 单条消息上限 4096 字符，超出截断
    const truncated = msg.message.length > 4096 ? msg.message.slice(0, 4050) + '\n\n... [消息已截断]' : msg.message
    switch (msg.msgType) {
      case 'reply':
        await this.fetch('/reply', { chatId: Number(msg.chatId), text: truncated, bot })
        break
      case 'edit':
        await this.fetch('/edit', {
          chatId: Number(msg.chatId),
          messageId: msg.targetMessageId,
          text: truncated,
          bot,
        })
        break
      case 'send':
        await this.fetch('/send', { chatId: Number(msg.chatId), text: truncated, bot })
        break
      case 'action':
        await this.fetch('/action', { chatId: Number(msg.chatId), action: msg.message, bot })
        break
      case 'photo': {
        const parsed = tryParseJson(msg.message)
        await this.fetch('/photo', {
          chatId: Number(msg.chatId),
          photo: parsed?.photo || msg.message,
          caption: parsed?.caption,
          bot: msg.bot || 'gen',
        })
        break
      }
      case 'media_group': {
        const parsed = tryParseJson(msg.message)
        await this.fetch('/media_group', {
          chatId: Number(msg.chatId),
          media: parsed?.media || parsed || msg.message,
          caption: parsed?.caption,
          bot: msg.bot || 'gen',
        })
        break
      }
      default:
        throw new Error(`unknown msgType: ${msg.msgType}`)
    }
  }

  private async fetch(path: string, body: Record<string, any>): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    // ★ 修复：同时检查 HTTP 状态码和响应体 ok 字段
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data?.ok === false) {
      const errMsg = data?.error || `HTTP ${res.status}`
      throw new Error(errMsg)
    }
  }
}

/** 尝试解析 JSON 字符串，失败返回 null */
function tryParseJson(s: string): Record<string, any> | null {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
