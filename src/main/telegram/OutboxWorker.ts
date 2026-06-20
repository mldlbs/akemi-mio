import { log } from '../logger/Logger'
import { getPendingOutbox, markOutboxSent, markOutboxFailed, cleanupOutbox } from '../db/outbox'

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
        markOutboxFailed(msg.id!, errMsg)
        failed++
        log('WARN', 'outbox_deliver_failed', { id: msg.id, msgType: msg.msgType, error: errMsg })
      }
    }

    return { success: failed === 0, summary: `sent=${sent} failed=${failed}` }
  }

  private async deliver(msg: {
    id?: number
    chatId: string
    msgType: string
    message: string
    targetMessageId?: number | null
  }): Promise<void> {
    switch (msg.msgType) {
      case 'reply':
        await this.fetch('/reply', { chatId: Number(msg.chatId), text: msg.message })
        break
      case 'edit':
        await this.fetch('/edit', {
          chatId: Number(msg.chatId),
          messageId: msg.targetMessageId,
          text: msg.message,
        })
        break
      case 'send':
        await this.fetch('/send', { chatId: Number(msg.chatId), text: msg.message })
        break
      case 'action':
        await this.fetch('/action', { chatId: Number(msg.chatId), action: msg.message })
        break
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
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
  }
}
