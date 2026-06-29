import { log } from '../../logger/Logger';
/**
 * EventStore — 事件持久化到 SQLite
 *
 * 实现 EventStoreEngine 接口，供 EventBus.enablePersistence() 使用。
 * 异步写入（避免阻塞 emit），定时裁剪旧事件。
 */
export class EventStore {
    constructor() {
        this.initialized = false;
    }
    async init() {
        if (this.initialized)
            return;
        const { getDatabase } = await import('../../db/connection');
        this.db = getDatabase();
        this.initialized = true;
        log('INFO', 'event_store_ready');
    }
    async append(event) {
        if (!this.initialized)
            return;
        try {
            const { events } = await import('../../db/schema');
            const { getDatabase } = await import('../../db/connection');
            const db = getDatabase();
            await db.insert(events).values({
                channel: event.channel,
                payload: event.payload,
                source: event.source,
                traceId: event.traceId,
                timestamp: event.timestamp,
            });
        }
        catch (err) {
            log('WARN', 'event_store_append_failed', { channel: event.channel, error: err.message });
        }
    }
    async query(channel, sinceTimestamp, limit = 100) {
        if (!this.initialized)
            return [];
        try {
            const { events } = await import('../../db/schema');
            const { getDatabase } = await import('../../db/connection');
            const db = getDatabase();
            const rows = (await db
                .select()
                .from(events)
                .orderBy((e) => e.timestamp)
                .limit(limit));
            return rows.filter((e) => e.channel === channel && e.timestamp >= sinceTimestamp);
        }
        catch {
            return [];
        }
    }
    async prune(olderThan) {
        if (!this.initialized)
            return 0;
        try {
            const { events } = await import('../../db/schema');
            const { getDatabase } = await import('../../db/connection');
            const db = getDatabase();
            const all = await db.select().from(events).all();
            const toDelete = all.filter((e) => e.timestamp < olderThan).map((e) => e.id);
            const deleted = toDelete.length > 0
                ? await db
                    .delete(events)
                    .where(toDelete.length > 0 ? `id IN (${toDelete.join(',')})` : undefined)
                    .run()
                : { changes: 0 };
            const count = typeof deleted?.changes === 'number' ? deleted.changes : 0;
            if (count > 0)
                log('INFO', 'event_store_pruned', { count, olderThan: new Date(olderThan).toISOString() });
            return count;
        }
        catch {
            return 0;
        }
    }
}
