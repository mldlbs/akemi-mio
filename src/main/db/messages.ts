import { getRawDb, markDirty } from './connection'
import { log } from '../logger/Logger'

export interface StoredMessage {
  id: string
  source: 'electron' | 'telegram'
  role: 'user' | 'assistant'
  content: string
  telegramChatId?: number | null
  telegramUserId?: number | null
  telegramFrom?: string | null
  telegramMessageId?: number | null
  createdAt: number
}

export function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function insertMessage(msg: StoredMessage): void {
  try {
    const db = getRawDb()
    db.run(
      `INSERT INTO messages (id, source, role, content, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.source,
        msg.role,
        msg.content,
        msg.telegramChatId ?? null,
        msg.telegramUserId ?? null,
        msg.telegramFrom ?? null,
        msg.telegramMessageId ?? null,
        msg.createdAt,
      ],
    )
    markDirty()
  } catch (err) {
    log('ERROR', 'db_insert_message_failed', { error: String(err) })
  }
}

interface StoredMessageRow {
  id: string
  source: string
  role: string
  content: string
  telegram_chat_id: number | null
  telegram_user_id: number | null
  telegram_from: string | null
  telegram_message_id: number | null
  created_at: number
}

export function getRecentMessages(limit = 100): StoredMessage[] {
  try {
    const db = getRawDb()
    const rows = db.exec(
      `SELECT id, source, role, content, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at
       FROM messages ORDER BY created_at ASC LIMIT ?`,
      [limit],
    )
    if (!rows.length || !rows[0].values.length) return []
    const cols = rows[0].columns
    return rows[0].values.map((row: any[]) => {
      const obj: Record<string, any> = {}
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
      return rowToMessage(obj as StoredMessageRow)
    })
  } catch (err) {
    log('ERROR', 'db_get_messages_failed', { error: String(err) })
    return []
  }
}

function rowToMessage(row: StoredMessageRow): StoredMessage {
  return {
    id: row.id,
    source: row.source as 'electron' | 'telegram',
    role: row.role as 'user' | 'assistant',
    content: row.content,
    telegramChatId: row.telegram_chat_id,
    telegramUserId: row.telegram_user_id,
    telegramFrom: row.telegram_from,
    telegramMessageId: row.telegram_message_id,
    createdAt: row.created_at,
  }
}
