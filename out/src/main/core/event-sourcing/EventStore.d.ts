import type { EventStoreEngine } from '../../core/EventBusTypes';
/**
 * EventStore — 事件持久化到 SQLite
 *
 * 实现 EventStoreEngine 接口，供 EventBus.enablePersistence() 使用。
 * 异步写入（避免阻塞 emit），定时裁剪旧事件。
 */
export declare class EventStore implements EventStoreEngine {
    private db;
    private initialized;
    init(): Promise<void>;
    append(event: {
        channel: string;
        payload: string;
        source: string | null;
        traceId: string | null;
        timestamp: number;
    }): Promise<void>;
    query(channel: string, sinceTimestamp: number, limit?: number): Promise<any[]>;
    prune(olderThan: number): Promise<number>;
}
