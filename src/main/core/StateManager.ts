type Listener = (state: UIState) => void

export interface UIState {
  asr?: string
  ttsPlaying?: boolean
  recording?: boolean
  error?: string
  model?: string
  sessionHealth?: string
}

/**
 * 类型安全的状态切片订阅 — 只在指定 key 变化时触发
 */
type SliceKey = keyof UIState
type SliceListener = (value: any, key: SliceKey) => void

export class StateManager {
  private state: UIState = {}
  private listeners: Set<Listener> = new Set()
  private sliceListeners = new Map<SliceKey, Set<SliceListener>>()
  private pushToRenderer?: (state: Partial<UIState>) => void

  /** 批量更新队列 */
  private batchQueue: Partial<UIState>[] = []
  private batchScheduled = false
  private batchTimeout: ReturnType<typeof setTimeout> | null = null

  get(): UIState {
    return { ...this.state }
  }

  update(partial: Partial<UIState>): void {
    const prev = { ...this.state }
    this.state = { ...this.state, ...partial }
    this.pushToRenderer?.(partial)

    // 全量通知
    for (const listener of this.listeners) {
      listener(this.state)
    }

    // 切片通知 — 只通知变化的 key
    for (const key of Object.keys(partial) as SliceKey[]) {
      if (partial[key] !== prev[key]) {
        const slisteners = this.sliceListeners.get(key)
        if (slisteners) {
          for (const sl of slisteners) {
            sl(this.state[key], key)
          }
        }
      }
    }
  }

  /**
   * 批量更新 — 收集多个 partial 后在下一个微任务中一次性 flush
   * 避免高频更新引起中间态重复渲染
   */
  batch(partial: Partial<UIState>): void {
    this.batchQueue.push(partial)
    if (!this.batchScheduled) {
      this.batchScheduled = true
      // 使用微任务 + 兜底 setTimeout 确保最终能 flush
      Promise.resolve().then(() => this.flushBatch())
      this.batchTimeout = setTimeout(() => this.flushBatch(), 50)
    }
  }

  private flushBatch(): void {
    if (this.batchQueue.length === 0) return
    this.batchScheduled = false
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout)
      this.batchTimeout = null
    }
    // 合并所有 partial
    const merged: Partial<UIState> = {}
    for (const p of this.batchQueue) {
      Object.assign(merged, p)
    }
    this.batchQueue = []
    this.update(merged)
  }

  /**
   * 订阅指定状态切片 — 只在 key 值变化时触发
   */
  subscribeSlice(key: SliceKey, callback: SliceListener): () => void {
    if (!this.sliceListeners.has(key)) {
      this.sliceListeners.set(key, new Set())
    }
    this.sliceListeners.get(key)!.add(callback as any)
    return () => {
      this.sliceListeners.get(key)?.delete(callback as any)
    }
  }

  subscribe(callback: Listener): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  setPushToRenderer(fn: (state: Partial<UIState>) => void): void {
    this.pushToRenderer = fn
  }
}
