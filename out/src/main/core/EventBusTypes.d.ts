import type { EventName, Listener } from './EventBus';
export type Priority = 'high' | 'normal' | 'low';
export declare const PRIORITY_ORDER: Priority[];
export interface SubscriptionFilter {
    sources?: string[];
}
export interface OnOptions {
    label?: string;
    priority?: Priority;
    filter?: SubscriptionFilter;
}
export interface EventMeta {
    source?: string;
    traceId?: string;
}
export interface PersistedEvent {
    id: string;
    channel: string;
    payload: string;
    source: string | null;
    traceId: string | null;
    timestamp: number;
}
export interface StoredListener<E extends EventName> {
    listener: Listener<E>;
    label?: string;
    filter?: SubscriptionFilter;
}
/**
 * Interface for event persistence backends.
 * Implemented by EventStore (SQLite) or in-memory versions for tests.
 */
export interface EventStoreEngine {
    append(event: {
        channel: string;
        payload: string;
        source: string | null;
        traceId: string | null;
        timestamp: number;
    }): Promise<void>;
    query(channel: string, sinceTimestamp: number, limit?: number): Promise<PersistedEvent[]>;
    prune(olderThan: number): Promise<number>;
}
export type { EventName, EventPayload } from './EventBus';
