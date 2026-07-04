import { getRawDb, markDirty } from './connection'
import { log } from '../logger/Logger'

export interface StoredMessage {
  id: string
  source: 'electron' | 'telegram'
  role: 'user' | 'assistant'
  content: string
  category: string
  sessionId?: string
  telegramChatId?: number | null
  telegramUserId?: number | null
  telegramFrom?: string | null
  telegramMessageId?: number | null
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

export function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function createSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

export function insertMessage(msg: StoredMessage): void {
  try {
    const db = getRawDb()
    db.run(
      `INSERT INTO messages (id, source, role, content, category, session_id, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.source,
        msg.role,
        msg.content,
        msg.category,
        msg.sessionId ?? null,
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
  category: string
  session_id: string | null
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
      `SELECT id, source, role, content, category, session_id, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at
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

export function getSessions(): SessionItem[] {
  try {
    const db = getRawDb()
    const rows = db.exec(
      `SELECT session_id,
              (SELECT content FROM messages AS sub WHERE sub.session_id = m.session_id AND sub.role = 'user' ORDER BY sub.created_at ASC LIMIT 1) AS label,
              (SELECT source FROM messages AS sub2 WHERE sub2.session_id = m.session_id ORDER BY sub2.created_at ASC LIMIT 1) AS source,
              COALESCE(
                (SELECT category FROM messages AS sub3 WHERE sub3.session_id = m.session_id AND sub3.category != 'chat' ORDER BY sub3.created_at ASC LIMIT 1),
                (SELECT category FROM messages AS sub4 WHERE sub4.session_id = m.session_id ORDER BY sub4.created_at ASC LIMIT 1)
              ) AS category,
              COUNT(*) AS message_count,
              MAX(created_at) AS last_activity_at,
              MIN(created_at) AS created_at
       FROM messages m
       WHERE session_id IS NOT NULL
       GROUP BY session_id
       ORDER BY last_activity_at DESC`,
    )
    if (!rows.length || !rows[0].values.length) return []
    const cols = rows[0].columns
    return rows[0].values.map((row: any[]) => {
      const obj: Record<string, any> = {}
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
      return {
        id: obj.session_id as string,
        source: (obj.source as string) === 'telegram' ? 'telegram' : 'electron',
        category: (obj.category as string) || 'chat',
        label: (obj.label as string)?.slice(0, 40) || '新对话',
        messageCount: obj.message_count as number,
        lastActivityAt: obj.last_activity_at as number,
        createdAt: obj.created_at as number,
      }
    })
  } catch (err) {
    log('ERROR', 'db_get_sessions_failed', { error: String(err) })
    return []
  }
}

export function getMessagesBySession(sessionId: string): StoredMessage[] {
  try {
    const db = getRawDb()
    const rows = db.exec(
      `SELECT id, source, role, content, category, session_id, telegram_chat_id, telegram_user_id, telegram_from, telegram_message_id, created_at
       FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
      [sessionId],
    )
    if (!rows.length || !rows[0].values.length) return []
    const cols = rows[0].columns
    return rows[0].values.map((row: any[]) => {
      const obj: Record<string, any> = {}
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i]
      return rowToMessage(obj as StoredMessageRow)
    })
  } catch (err) {
    log('ERROR', 'db_get_messages_by_session_failed', { error: String(err), sessionId })
    return []
  }
}

/** 获取最后一条消息的 session_id（用于自动分组） */
export function getLastSessionId(): string | null {
  try {
    const db = getRawDb()
    const rows = db.exec(`SELECT session_id FROM messages ORDER BY created_at DESC LIMIT 1`)
    if (!rows.length || !rows[0].values.length) return null
    return (rows[0].values[0] as any[])[0] as string | null
  } catch {
    return null
  }
}

/** 获取最后一条消息的时间戳 */
export function getLastMessageTime(): number | null {
  try {
    const db = getRawDb()
    const rows = db.exec(`SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1`)
    if (!rows.length || !rows[0].values.length) return null
    return (rows[0].values[0] as any[])[0] as number
  } catch {
    return null
  }
}

export { createSessionId }

function rowToMessage(row: StoredMessageRow): StoredMessage {
  return {
    id: row.id,
    source: row.source as 'electron' | 'telegram',
    role: row.role as 'user' | 'assistant',
    content: row.content,
    category: row.category || 'chat',
    sessionId: row.session_id ?? undefined,
    telegramChatId: row.telegram_chat_id,
    telegramUserId: row.telegram_user_id,
    telegramFrom: row.telegram_from,
    telegramMessageId: row.telegram_message_id,
    createdAt: row.created_at,
  }
}
