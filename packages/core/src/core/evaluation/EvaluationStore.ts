/**
 * EvaluationStore — Append-only 持久化日志
 *
 * 职责极简：只负责 append / query / subscribe。
 * 不承担 Metrics、Aggregation、Evolution 等派生计算。
 *
 * ── 数据流 ──
 * Runtime → EvaluationEmitter → (EventBus) → EvaluationStore
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { EvaluationEvent, EvaluationRepository } from './types'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import * as schema from '@akemi-mio/core/db/schema'

/** 原始 SQLite 数据库回调类型 */
type RawDb = {
  run: (sql: string, params?: any[]) => void
  query: (sql: string, params?: any[]) => Record<string, any>[]
}

const BATCH_INTERVAL_MS = 1000
const MAX_BATCH_SIZE = 50
const DEFAULT_QUERY_LIMIT = 1000

/** 传给 query() options.limit 的哨兵值，表示"无限制查询"。
 *  Replay / Projection / Audit 路径使用此值确保完整性。 */
export const QUERY_NO_LIMIT = -1 as const

/** seq 分配的批次大小：每 N 事件更新一次 seq counter 的持久化记录 */
const SEQ_PERSIST_INTERVAL = 500

export class EvaluationStore implements EvaluationRepository {
  private db: SqliteRemoteDatabase<typeof schema> | null = null
  private raw: RawDb | null = null
  private dbReady = false
  private batch: EvaluationEvent[] = []
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private subscribers: Set<(event: EvaluationEvent) => void> = new Set()
  /** R2-A: 单调递增 seq 计数器。flush 时分配，非 append。 */
  private seqCounter = 0
  /** 是否支持 seq 列。首次 flush 失败时检测降级。 */
  private hasSeqColumn: boolean | null = null

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
    const { getEventDatabase } = await import('@akemi-mio/core/db/connection')
    const { getEventRawDb } = await import('@akemi-mio/core/db/connection')
    this.db = getEventDatabase() as any
    this.raw = {
      run: (s, p) => getEventRawDb().run(s, p),
      query: (s, p) => {
        const stmt = getEventRawDb().prepare(s)
        p && stmt.bind(p)
        const rows: any[] = []
        while (stmt.step()) rows.push(stmt.getAsObject())
        stmt.free()
        return rows
      },
    }
    this.dbReady = true
    // R2-A: 从 DB 恢复 seq counter
    try {
      const rows = this.raw.query('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM evaluation_events')
      this.seqCounter = Number(rows[0]?.max_seq ?? 0)
    } catch {
      this.seqCounter = 0
    }
    log('INFO', 'evaluation_store_ready', { seqCounter: this.seqCounter })
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
      await this.doInsert(events)
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
    await this.doInsert(events)
  }

  /** 统一插入逻辑：检测 seq 列支持并在降级时静默重试。 */
  private async doInsert(events: EvaluationEvent[]): Promise<void> {
    if (this.hasSeqColumn === false) {
      this.rawInsert(events, false)
      return
    }

    try {
      this.rawInsert(events, true)
      this.seqCounter += events.length
      this.hasSeqColumn = true
    } catch (err: any) {
      const msg = err.message ?? ''
      const cause = err.cause?.message ?? err.cause?.toString?.() ?? ''
      const noSeqCol = msg.includes('has no column named seq') || cause.includes('has no column named seq')
      if (this.hasSeqColumn === null && noSeqCol) {
        this.hasSeqColumn = false
        this.rawInsert(events, false)
      } else {
        throw err
      }
    }
  }

  /** 使用原始 SQL 批量插入（绕过 drizzle ORM 的静态列列表）。 */
  private rawInsert(events: EvaluationEvent[], withSeq: boolean): void {
    if (!this.raw) return
    const cols = withSeq
      ? '(id, timestamp, trace_id, session_id, source, type, payload, parent_event_id, seq)'
      : '(id, timestamp, trace_id, session_id, source, type, payload, parent_event_id)'
    const placeholders = events.map((_, i) => {
      const base = i * (withSeq ? 9 : 8)
      if (withSeq) return `(${Array.from({ length: 9 }, (_, j) => `?`).join(', ')})`
      return `(${Array.from({ length: 8 }, (_, j) => `?`).join(', ')})`
    })

    const params: any[] = []
    for (const e of events) {
      params.push(e.id, e.timestamp, e.traceId, e.sessionId, e.source, e.type, JSON.stringify(e.payload), e.parentEventId ?? null)
      if (withSeq) {
        this.seqCounter++
        params.push(this.seqCounter)
      }
    }

    this.raw.run(`INSERT INTO evaluation_events ${cols} VALUES ${placeholders.join(', ')}`, params)
  }

  async query(range: { since: number; until?: number; type?: string }, options?: { limit?: number }): Promise<EvaluationEvent[]> {
    return this.queryInternal(range, options, false)
  }

  async queryStrict(range: { since: number; until?: number; type?: string }, options?: { limit?: number }): Promise<EvaluationEvent[]> {
    return this.queryInternal(range, options, true)
  }

  private async queryInternal(
    range: { since: number; until?: number; type?: string },
    options?: { limit?: number },
    strict = false,
  ): Promise<EvaluationEvent[]> {
    if (!this.dbReady) {
      if (strict) throw new Error('evaluation store not initialized')
      return []
    }

    try {
      await this.forceFlush()

      if (!this.raw) {
        if (strict) throw new Error('evaluation store raw database unavailable')
        return []
      }

      const limit = options?.limit ?? DEFAULT_QUERY_LIMIT

      // QUERY_NO_LIMIT 用于 Replay / Projection / Audit 路径
      const noLimit = limit === QUERY_NO_LIMIT

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
      sql += ' ORDER BY timestamp ASC'

      if (!noLimit) {
        sql += ' LIMIT ?'
        params.push(limit + 1) // +1 to detect silent truncation
      }

      const rows = this.raw.query(sql, params)

      if (!noLimit && rows.length > limit) {
        log('WARN', 'evaluation_store_query_truncated', { limit, actual: rows.length, since: range.since })
        rows.pop()
      }

      return rows.map(this.deserialize)
    } catch (error) {
      if (strict) throw error
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

  /**
   * 分页读取 trace 事件。
   * 与 getTrace 共享相同的复合索引 (trace_id, timestamp)。
   */
  async getTraceEvents(traceId: string, options?: { limit?: number; offset?: number }): Promise<EvaluationEvent[]> {
    if (!this.dbReady) return []
    await this.forceFlush()
    try {
      const limit = options?.limit ?? 1000
      const offset = options?.offset ?? 0
      const rows =
        this.raw?.query('SELECT * FROM evaluation_events WHERE trace_id = ? ORDER BY timestamp ASC LIMIT ? OFFSET ?', [
          traceId,
          limit,
          offset,
        ]) ?? []
      return rows.map(this.deserialize)
    } catch {
      return []
    }
  }

  // ── Subscribe (EventStream) ──

  /** R2-A: 基于 seq 的游标查询。用于 Replay / Projection / Audit 的有界迭代。
   *  不调用 forceFlush（预期调用者在需要读后写一致性时自行处理）。 */
  async queryBySeq(afterSeq: number, limit: number = 1000): Promise<EvaluationEvent[]> {
    if (!this.dbReady) return []
    try {
      const rows = this.raw?.query('SELECT * FROM evaluation_events WHERE seq > ? ORDER BY seq ASC LIMIT ?', [afterSeq, limit]) ?? []
      return rows.map(this.deserialize)
    } catch {
      return []
    }
  }

  /** 返回当前最大 seq 值（用于 checkpoint）。 */
  getCurrentSeq(): number {
    return this.seqCounter
  }

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
      seq: row.seq !== undefined ? Number(row.seq) : undefined,
    }
  }
}
