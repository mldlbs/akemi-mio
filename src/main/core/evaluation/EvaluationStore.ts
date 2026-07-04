/**
 * EvaluationStore — Append-only 持久化日志
 *
 * 职责极简：只负责 append / query / subscribe。
 * 不承担 Metrics、Aggregation、Evolution 等派生计算。
 *
 * ── 数据流 ──
 * Runtime → EvaluationEmitter → (EventBus) → EvaluationStore
 */

import { log } from '../../logger/Logger'
import type { EvaluationEvent, EvaluationRepository } from './types'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import * as schema from '../../db/schema'

/** 原始 SQLite 数据库回调类型 */
type RawDb = {
  run: (sql: string, params?: any[]) => void
  query: (sql: string, params?: any[]) => Record<string, any>[]
}

const BATCH_INTERVAL_MS = 1000
const MAX_BATCH_SIZE = 50

export class EvaluationStore implements EvaluationRepository {
  private db: SqliteRemoteDatabase<typeof schema> | null = null
  private raw: RawDb | null = null
  private dbReady = false
  private batch: EvaluationEvent[] = []
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private subscribers: Set<(event: EvaluationEvent) => void> = new Set()

  constructor(externalDb?: SqliteRemoteDatabase<typeof schema>, rawDb?: RawDb) {
    if (externalDb) {
      this.db = externalDb
      this.raw = rawDb ?? null
      this.dbReady = true
    }
  }

  /** 注入原始 sqlite 引用（用于直接查询，绕过 drizzle-proxy 的 where 兼容性问题） */
  setRawDb(rawDb: RawDb): void {
    this.raw = rawDb
  }

  async init(): Promise<void> {
    if (this.dbReady) return
    const { getDatabase } = await import('../../db/connection')
    const { getRawDb } = await import('../../db/connection')
    this.db = getDatabase()
    this.raw = {
      run: (s, p) => getRawDb().run(s, p),
      query: (s, p) => {
        const stmt = getRawDb().prepare(s)
        p && stmt.bind(p)
        const rows: any[] = []
        while (stmt.step()) rows.push(stmt.getAsObject())
        stmt.free()
        return rows
      },
    }
    this.dbReady = true
    log('INFO', 'evaluation_store_ready')
  }

  // ── Append ──

  append(event: EvaluationEvent): void {
    this.batch.push(event)
    this.notifySubscribers(event)
    if (this.batch.length >= MAX_BATCH_SIZE) {
      this.flush()
    } else if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flush(), BATCH_INTERVAL_MS)
    }
  }

  private async flush(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    const events = this.batch.splice(0)
    if (events.length === 0) return
    if (!this.dbReady || !this.db) return
    try {
      await this.db.insert(schema.evaluationEvents).values(
        events.map((e) => ({
          id: e.id,
          timestamp: e.timestamp,
          traceId: e.traceId,
          sessionId: e.sessionId,
          source: e.source,
          type: e.type,
          payload: JSON.stringify(e.payload),
          parentEventId: e.parentEventId,
        })),
      )
    } catch (err: any) {
      log('WARN', 'evaluation_store_flush_failed', { count: events.length, error: err.message })
    }
  }

  // ── Query ──

  /** 强制刷入未持久化事件 */
  async forceFlush(): Promise<void> {
    if (this.batch.length === 0) return
    // 绕过 flush 的 try/catch 以暴露真实错误
    if (!this.dbReady || !this.db) return
    const events = this.batch.splice(0)
    await this.db.insert(schema.evaluationEvents).values(
      events.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        traceId: e.traceId,
        sessionId: e.sessionId,
        source: e.source,
        type: e.type,
        payload: JSON.stringify(e.payload),
        parentEventId: e.parentEventId,
      })),
    )
  }

  async query(range: { since: number; until?: number; type?: string }): Promise<EvaluationEvent[]> {
    if (!this.dbReady) return []
    await this.forceFlush()
    try {
      let sql = 'SELECT * FROM evaluation_events WHERE timestamp >= ?'
      const params: any[] = [range.since]
      if (range.until) {
        sql += ' AND timestamp <= ?'
        params.push(range.until)
      }
      if (range.type) {
        sql += ' AND type = ?'
        params.push(range.type)
      }
      sql += ' ORDER BY timestamp ASC LIMIT 1000'
      const rows = this.raw?.query(sql, params) ?? []
      return rows.map(this.deserialize)
    } catch {
      return []
    }
  }

  async getTrace(traceId: string): Promise<EvaluationEvent[]> {
    if (!this.dbReady) return []
    await this.forceFlush()
    try {
      const rows = this.raw?.query('SELECT * FROM evaluation_events WHERE trace_id = ? ORDER BY timestamp ASC', [traceId]) ?? []
      return rows.map(this.deserialize)
    } catch {
      return []
    }
  }

  // ── Subscribe (EventStream) ──

  subscribe(handler: (event: EvaluationEvent) => void): () => void {
    this.subscribers.add(handler)
    return () => this.subscribers.delete(handler)
  }

  private notifySubscribers(event: EvaluationEvent): void {
    for (const handler of this.subscribers) {
      try {
        handler(event)
      } catch {
        // subscriber error should not break the pipeline
      }
    }
  }

  // ── Shutdown ──

  async shutdown(): Promise<void> {
    await this.flush()
    this.subscribers.clear()
  }

  // ── Internal ──

  private deserialize(row: any): EvaluationEvent {
    return {
      id: row.id,
      timestamp: Number(row.timestamp) || 0,
      traceId: row.trace_id ?? row.traceId ?? '',
      sessionId: row.session_id ?? row.sessionId ?? '',
      source: row.source,
      type: row.type,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      parentEventId: row.parent_event_id ?? row.parentEventId ?? undefined,
    }
  }
}
