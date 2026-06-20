import type { BackgroundTaskState, BackgroundTaskType } from './TaskTypes'

/**
 * 统一任务状态持久化。
 * 替代 CreativityService/InsightService 各自的 setInterval 调度状态。
 */
export class TaskStore {
  private data = new Map<string, BackgroundTaskState>()

  get(type: BackgroundTaskType): BackgroundTaskState {
    if (!this.data.has(type)) {
      this.data.set(type, {
        type,
        status: 'idle',
        lastRunAt: 0,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        metadata: {},
      })
    }
    return this.data.get(type)!
  }

  update(type: BackgroundTaskType, partial: Partial<BackgroundTaskState>): void {
    const current = this.get(type)
    this.data.set(type, { ...current, ...partial })
  }

  reset(type: BackgroundTaskType): void {
    this.data.delete(type)
  }
}
