import { getRawDb, markDirty } from './connection'

export type OutboxCategory = 'dialogue' | 'evolution' | 'insight' | 'creativity' | 'plan' | 'budget' | 'recovery' | 'stability' | 'system'

export interface OutboxRow {
  id?: number
  chatId: string
  bot?: 'chat' | 'push' | 'gen' | 'write'
  msgType: 'send' | 'edit' | 'reply' | 'action' | 'photo' | 'media_group'
  category?: OutboxCategory
  message: string
  targetMessageId?: number
  hash?: string
  status?: 'pending' | 'sent' | 'failed'
  retryCount?: number
  lastError?: string
  createdAt?: number
  updatedAt?: number
}

/** 写入一条 pending 消息到 outbox。自动去重：相同 hash 的 pending/sent 消息不会重复写入 */
export function insertOutbox(row: OutboxRow): number {
  const db = getRawDb()
  const now = Date.now()
  const hash = row.hash || simpleHash(`${row.chatId}:${row.msgType}:${row.message}`)

  // 去重：相同 hash 的 pending/sent 已存在则跳过
  if (outboxExists(hash)) return 0

  db.run(
    `INSERT INTO telegram_outbox (chat_id, bot, msg_type, category, message, target_message_id, hash, status, retry_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [row.chatId, row.bot || 'chat', row.msgType, row.category || 'dialogue', row.message, row.targetMessageId ?? null, hash, now],
  )
  markDirty()
  return (db.exec('SELECT last_insert_rowid()') as any)[0]?.values?.[0]?.[0] ?? 0
}

/** 拉取待发送消息（最多 limit 条） */
export function getPendingOutbox(limit = 10): OutboxRow[] {
  const db = getRawDb()
  const rows = db.exec(
    `SELECT id, chat_id, bot, msg_type, message, target_message_id, hash, status, retry_count, last_error, created_at, updated_at
     FROM telegram_outbox
     WHERE status = 'pending'
     ORDER BY id ASC
     LIMIT ?`,
    [limit],
  )
  if (!rows.length) return []
  return rows[0].values.map((r: any[]) => ({
    id: r[0],
    chatId: r[1],
    bot: r[2] || 'chat',
    msgType: r[3],
    message: r[4],
    targetMessageId: r[5],
    hash: r[6],
    status: r[7],
    retryCount: r[8],
    lastError: r[9],
    createdAt: r[10],
    updatedAt: r[11],
  }))
}

/** 标记为已发送 */
export function markOutboxSent(id: number): void {
  getRawDb().run(`UPDATE telegram_outbox SET status = 'sent', updated_at = ? WHERE id = ?`, [Date.now(), id])
  markDirty()
}

/** 标记失败：retryCount < 3 翻回 pending；>= 3 删除，返回 true 表示已放弃 */
export function markOutboxFailed(id: number, error: string): boolean {
  const db = getRawDb()
  const current = db.exec(`SELECT retry_count, msg_type, chat_id, message FROM telegram_outbox WHERE id = ?`, [id])
  const row = current?.[0]?.values?.[0]
  if (!row) return false
  const retryCount = row[0] ?? 0
  if (retryCount >= 3) {
    const msgType = row[1]
    const chatId = row[2]
    const lastMessage = row[3]
    db.run(`DELETE FROM telegram_outbox WHERE id = ?`, [id])
    // ★ 修复：edit 重试 3 次失败后降级为 send 新消息
    if (msgType === 'edit' && chatId && lastMessage) {
      db.run(
        `INSERT INTO telegram_outbox (chat_id, msg_type, category, message, hash, status, retry_count, created_at)
         VALUES (?, 'send', 'dialogue', ?, ?, 'pending', 0, ?)`,
        [chatId, lastMessage, simpleHash(`${chatId}:send:${lastMessage}:fallback`), Date.now()],
      )
    }
    markDirty()
    return true
  } else {
    db.run(`UPDATE telegram_outbox SET status = 'pending', retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?`, [
      error,
      Date.now(),
      id,
    ])
    markDirty()
    return false
  }
}

/** 幂等检查：相同 hash 的 pending/sent 消息是否已存在 */
export function outboxExists(hash: string): boolean {
  const rows = getRawDb().exec(`SELECT 1 FROM telegram_outbox WHERE hash = ? AND status IN ('pending', 'sent') LIMIT 1`, [hash])
  return rows.length > 0 && rows[0].values.length > 0
}

/** 清理过期 sent 消息（保留 24h）和放弃的 failed 消息（retry_count >= 3） */
export function cleanupOutbox(): number {
  const db = getRawDb()
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const result = db.exec(
    `DELETE FROM telegram_outbox WHERE (status = 'sent' AND created_at < ?) OR (status = 'failed' AND retry_count >= 3 AND created_at < ?)`,
    [cutoff, cutoff],
  )
  const deleted = result?.[0]?.values?.[0]?.[0] ?? 0
  if (deleted > 0) markDirty()
  return deleted
}

function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}
