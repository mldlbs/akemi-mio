import type { EventStoreEngine } from '../../core/EventBusTypes'
import { log } from '../../logger/Logger'

/**
 * EventStore — 事件持久化到 SQLite
 *
 * 实现 EventStoreEngine 接口，供 EventBus.enablePersistence() 使用。
 * 异步写入（避免阻塞 emit），定时裁剪旧事件。
 */
export class EventStore implements EventStoreEngine {
  private db: any
  private initialized = false

  async init(): Promise<void> {
    if (this.initialized) return
    const { getDb } = await import('../../db/connection')
    this.db = getDb()
    this.initialized = true
    log('INFO', 'event_store_ready')
  }

  async append(event: {
    channel: string
    payload: string
    source: string | null
    traceId: string | null
    timestamp: number
  }): Promise<void> {
    if (!this.initialized) return
    try {
      const { events } = await import('../../db/schema')
      const { getDb } = await import('../../db/connection')
      const db = getDb()
      await db.insert(events).values({
        channel: event.channel,
        payload: event.payload,
        source: event.source,
        traceId: event.traceId,
        timestamp: event.timestamp,
      })
    } catch (err: any) {
      log('WARN', 'event_store_append_failed', { channel: event.channel, error: err.message })
    }
  }

  async query(channel: string, sinceTimestamp: number, limit = 100): Promise<any[]> {
    if (!this.initialized) return []
    try {
      const { events } = await import('../../db/schema')
      const { getDb } = await import('../../db/connection')
      const db = getDb()
      return await db
        .select()
        .from(events)
        .where((e: any) => e.channel === channel && e.timestamp >= sinceTimestamp)
        .orderBy((e: any) => e.timestamp)
        .limit(limit)
    } catch {
      return []
    }
  }

  async prune(olderThan: number): Promise<number> {
    if (!this.initialized) return 0
    try {
      const { events } = await import('../../db/schema')
      const { getDb } = await import('../../db/connection')
      const db = getDb()
      const deleted = await db
        .delete(events)
        .where((e: any) => e.timestamp < olderThan)
        .run()
      const count = deleted?.changes ?? 0
      if (count > 0) log('INFO', 'event_store_pruned', { count, olderThan: new Date(olderThan).toISOString() })
      return count
    } catch {
      return 0
    }
  }
}
