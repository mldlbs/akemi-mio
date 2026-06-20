import { log } from '../logger/Logger'

export type InitPriority = 'critical' | 'normal' | 'background'

export interface InitTask {
  name: string
  priority: InitPriority
  fn: () => Promise<void> | void
  delayMs?: number
  timeoutMs?: number
}

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed'

interface TaskRecord {
  task: InitTask
  status: TaskStatus
  error?: string
  startedAt?: number
  completedAt?: number
}

/**
 * 延迟初始化调度器 — 按优先级分阶段启动非关键服务
 * 替代 LazyInitScheduler（重构保留原行为）
 *
 * 关键(critical) → 立即（微任务）
 * 普通(normal) → 下一帧（setImmediate/setTimeout 0）
 * 背景(background) → 延迟 3s 后启动
 */
export class LazyServiceGroup {
  private tasks: TaskRecord[] = []
  private _started = false
  private _completed = false
  private timers: Set<ReturnType<typeof setTimeout>> = new Set()
  private completedCount = 0
  private failedCount = 0

  add(task: InitTask): this {
    this.tasks.push({ task, status: 'pending' })
    return this
  }

  addMany(tasks: InitTask[]): this {
    for (const t of tasks) this.add(t)
    return this
  }

  start(): void {
    if (this._started) return
    this._started = true
    log('INFO', 'lazy_init_start', { total: this.tasks.length })

    for (const record of this.tasks) {
      this.scheduleTask(record)
    }
  }

  private scheduleTask(record: TaskRecord): void {
    const { task } = record
    let delay = task.delayMs ?? 0

    if (task.priority === 'background' && task.delayMs === undefined) {
      delay = 3000
    }

    const timer = setTimeout(async () => {
      this.timers.delete(timer)
      if (record.status !== 'pending') return

      record.status = 'running'
      record.startedAt = Date.now()
      log('INFO', 'lazy_init_starting', { name: task.name, priority: task.priority, delay })

      try {
        const timeoutMs = task.timeoutMs ?? (task.priority === 'background' ? 30000 : 10000)
        await this.withTimeout(task.fn(), timeoutMs, task.name)
        record.status = 'completed'
        record.completedAt = Date.now()
        this.completedCount++
        log('INFO', 'lazy_init_completed', {
          name: task.name,
          took_ms: record.completedAt - record.startedAt,
        })
      } catch (err) {
        record.status = 'failed'
        record.error = String(err)
        this.failedCount++
        log('WARN', 'lazy_init_failed', { name: task.name, error: String(err) })
      }

      this.checkAllDone()
    }, delay)

    this.timers.add(timer)
  }

  private async withTimeout<T>(promise: Promise<T> | T, timeoutMs: number, name: string): Promise<T> {
    if (promise instanceof Promise) {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`lazy init timeout "${name}" after ${timeoutMs}ms`)), timeoutMs),
        ),
      ])
    }
    return promise
  }

  private checkAllDone(): void {
    const allDone = this.tasks.every((t) => t.status === 'completed' || t.status === 'failed')
    if (allDone) {
      this._completed = true
      log('INFO', 'lazy_init_all_done', {
        total: this.tasks.length,
        completed: this.completedCount,
        failed: this.failedCount,
      })
    }
  }

  getStatus(): {
    started: boolean
    completed: boolean
    total: number
    done: number
    failed: number
    tasks: { name: string; status: TaskStatus; error?: string }[]
  } {
    return {
      started: this._started,
      completed: this._completed,
      total: this.tasks.length,
      done: this.completedCount,
      failed: this.failedCount,
      tasks: this.tasks.map((r) => ({ name: r.task.name, status: r.status, error: r.error })),
    }
  }

  cancel(): void {
    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.timers.clear()
    for (const record of this.tasks) {
      if (record.status === 'pending') {
        record.status = 'failed'
        record.error = 'cancelled'
      }
    }
    this._completed = true
    log('INFO', 'lazy_init_cancelled', { remaining: this.timers.size })
  }

  get isCompleted(): boolean {
    return this._completed
  }
}
