export class StateManager {
    constructor() {
        this.state = {};
        this.listeners = new Set();
        this.sliceListeners = new Map();
        /** 批量更新队列 */
        this.batchQueue = [];
        this.batchScheduled = false;
        this.batchTimeout = null;
    }
    get() {
        return { ...this.state };
    }
    update(partial) {
        const prev = { ...this.state };
        this.state = { ...this.state, ...partial };
        this.pushToRenderer?.(partial);
        // 全量通知
        for (const listener of this.listeners) {
            listener(this.state);
        }
        // 切片通知 — 只通知变化的 key
        for (const key of Object.keys(partial)) {
            if (partial[key] !== prev[key]) {
                const slisteners = this.sliceListeners.get(key);
                if (slisteners) {
                    for (const sl of slisteners) {
                        sl(this.state[key], key);
                    }
                }
            }
        }
    }
    /**
     * 批量更新 — 收集多个 partial 后在下一个微任务中一次性 flush
     * 避免高频更新引起中间态重复渲染
     */
    batch(partial) {
        this.batchQueue.push(partial);
        if (!this.batchScheduled) {
            this.batchScheduled = true;
            // 使用微任务 + 兜底 setTimeout 确保最终能 flush
            Promise.resolve().then(() => this.flushBatch());
            this.batchTimeout = setTimeout(() => this.flushBatch(), 50);
        }
    }
    flushBatch() {
        if (this.batchQueue.length === 0)
            return;
        this.batchScheduled = false;
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
            this.batchTimeout = null;
        }
        // 合并所有 partial
        const merged = {};
        for (const p of this.batchQueue) {
            Object.assign(merged, p);
        }
        this.batchQueue = [];
        this.update(merged);
    }
    /**
     * 订阅指定状态切片 — 只在 key 值变化时触发
     */
    subscribeSlice(key, callback) {
        if (!this.sliceListeners.has(key)) {
            this.sliceListeners.set(key, new Set());
        }
        this.sliceListeners.get(key).add(callback);
        return () => {
            this.sliceListeners.get(key)?.delete(callback);
        };
    }
    subscribe(callback) {
        this.listeners.add(callback);
        return () => {
            this.listeners.delete(callback);
        };
    }
    setPushToRenderer(fn) {
        this.pushToRenderer = fn;
    }
}
