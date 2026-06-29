import { EventEmitter } from 'events';
import { PRIORITY_ORDER } from './EventBusTypes';
/**
 * 订阅追踪器 — 收集所有 EventBus 订阅的清理函数，统一 dispose
 */
export class SubscriptionTracker {
    constructor() {
        this.disposers = new Set();
    }
    add(disposer) {
        this.disposers.add(disposer);
    }
    dispose() {
        for (const fn of this.disposers) {
            try {
                fn();
            }
            catch {
                // 静默处理单个清理的异常
            }
        }
        this.disposers.clear();
    }
    get count() {
        return this.disposers.size;
    }
}
export class EventBus {
    constructor() {
        this.emitter = new EventEmitter();
        /** priority-ordered listeners per event */
        this.priorityListeners = new Map();
        /** 记录每个事件的订阅来源（label → disposer），用于诊断 */
        this.subscriptionLabels = new Map();
        this.store = null;
    }
    static getInstance() {
        if (!EventBus.instance) {
            EventBus.instance = new EventBus();
            EventBus.instance.emitter.setMaxListeners(EventBus.MAX_LISTENERS);
        }
        return EventBus.instance;
    }
    /** Enable event persistence. Call once at boot before any subscribers. */
    enablePersistence(store) {
        this.store = store;
    }
    on(event, listener, labelOrOpts) {
        const opts = typeof labelOrOpts === 'string' ? { label: labelOrOpts } : (labelOrOpts ?? {});
        const priority = opts.priority ?? 'normal';
        // Track label for diagnostics
        if (opts.label) {
            if (!this.subscriptionLabels.has(event))
                this.subscriptionLabels.set(event, new Set());
            this.subscriptionLabels.get(event).add(opts.label);
        }
        // Store in priority bucket (not in base emitter — avoid double-fire on emit)
        if (!this.priorityListeners.has(event))
            this.priorityListeners.set(event, new Map());
        const buckets = this.priorityListeners.get(event);
        if (!buckets.has(priority))
            buckets.set(priority, []);
        buckets.get(priority).push({ listener, label: opts.label, filter: opts.filter });
        const disposer = () => {
            const b = this.priorityListeners.get(event)?.get(priority);
            if (b) {
                const idx = b.findIndex((s) => s.listener === listener);
                if (idx >= 0)
                    b.splice(idx, 1);
            }
        };
        return disposer;
    }
    /** Register subscription with auto-cleanup via tracker */
    track(event, listener, tracker, labelOrOpts) {
        const disposer = this.on(event, listener, labelOrOpts);
        tracker.add(disposer);
    }
    off(event, listener) {
        for (const buckets of this.priorityListeners.get(event)?.values() ?? []) {
            const idx = buckets.findIndex((s) => s.listener === listener);
            if (idx >= 0)
                buckets.splice(idx, 1);
        }
    }
    once(event, listener) {
        this.emitter.once(event, listener);
        return () => {
            this.emitter.off(event, listener);
        };
    }
    emit(event, payload, meta) {
        // Persist if store configured
        if (this.store) {
            this.store
                .append({
                channel: event,
                payload: JSON.stringify(payload),
                source: meta?.source ?? null,
                traceId: meta?.traceId ?? null,
                timestamp: Date.now(),
            })
                .catch(() => { });
        }
        // Fire in priority order with optional filter
        const buckets = this.priorityListeners.get(event);
        if (buckets && buckets.size > 0) {
            for (const p of PRIORITY_ORDER) {
                const listeners = buckets.get(p);
                if (!listeners)
                    continue;
                for (const stored of listeners) {
                    if (stored.filter?.sources && meta?.source && !stored.filter.sources.includes(meta.source))
                        continue;
                    try {
                        stored.listener(payload);
                    }
                    catch (err) {
                        console.error(`[EventBus] ${event} handler error (${stored.label || 'unlabeled'}):`, err);
                    }
                }
            }
        }
        // Fallback: fire via base emitter for listeners registered outside priority buckets (once())
        try {
            this.emitter.emit(event, payload);
        }
        catch (err) {
            console.error(`[EventBus] emit ${event} failed:`, err);
        }
    }
    removeAll(event) {
        if (event) {
            this.emitter.removeAllListeners(event);
            this.subscriptionLabels.delete(event);
            this.priorityListeners.delete(event);
        }
        else {
            this.emitter.removeAllListeners();
            this.subscriptionLabels.clear();
            this.priorityListeners.clear();
        }
    }
    listenerCount(event) {
        // priority buckets + base emitter, deduplicated
        const priorityCount = Array.from(this.priorityListeners.get(event)?.values() ?? []).reduce((sum, list) => sum + list.length, 0);
        return Math.max(priorityCount, this.emitter.listenerCount(event));
    }
    /** 诊断：当前所有活跃订阅概况 */
    getStats() {
        const stats = {};
        const events = new Set([...this.emitter.eventNames().map(String), ...this.priorityListeners.keys()]);
        for (const event of events) {
            const priorityCount = Array.from(this.priorityListeners.get(event)?.values() ?? []).reduce((sum, list) => sum + list.length, 0);
            const count = Math.max(priorityCount, this.emitter.listenerCount(event));
            const labels = Array.from(this.subscriptionLabels.get(event) || []);
            const buckets = {};
            for (const [p, listeners] of this.priorityListeners.get(event) ?? [])
                buckets[p] = listeners.length;
            stats[event] = { count, labels, priorityBuckets: buckets };
        }
        return stats;
    }
}
EventBus.MAX_LISTENERS = 50;
export const eventBus = EventBus.getInstance();
