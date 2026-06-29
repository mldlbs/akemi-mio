type Listener = (state: UIState) => void;
export interface UIState {
    asr?: string;
    ttsPlaying?: boolean;
    recording?: boolean;
    error?: string;
    model?: string;
    sessionHealth?: string;
}
/**
 * 类型安全的状态切片订阅 — 只在指定 key 变化时触发
 */
type SliceKey = keyof UIState;
type SliceListener = (value: any, key: SliceKey) => void;
export declare class StateManager {
    private state;
    private listeners;
    private sliceListeners;
    private pushToRenderer?;
    /** 批量更新队列 */
    private batchQueue;
    private batchScheduled;
    private batchTimeout;
    get(): UIState;
    update(partial: Partial<UIState>): void;
    /**
     * 批量更新 — 收集多个 partial 后在下一个微任务中一次性 flush
     * 避免高频更新引起中间态重复渲染
     */
    batch(partial: Partial<UIState>): void;
    private flushBatch;
    /**
     * 订阅指定状态切片 — 只在 key 值变化时触发
     */
    subscribeSlice(key: SliceKey, callback: SliceListener): () => void;
    subscribe(callback: Listener): () => void;
    setPushToRenderer(fn: (state: Partial<UIState>) => void): void;
}
export {};
