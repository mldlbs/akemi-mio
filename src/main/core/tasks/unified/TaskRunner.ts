import type { BackgroundTaskType, TaskExecutionResult, TaskExecutor } from './TaskTypes'
import { TaskStore } from './TaskStore'
import { log } from '../../../logger/Logger'
import { eventBus } from '../../../core/EventBus'

export interface RegisteredTask {
  type: BackgroundTaskType
  executor: TaskExecutor
  intervalMs: number
  /** 冷却时间（毫秒），失败后等待 */
  cooldownMs: number
  /** 最大失败次数触发冷却 */
  maxFailures: number
  /** 指数退避基础延时 */
  retryBaseMs: number
}

/**
 * 统一后台任务执行编排器。
 * 内置：冷却管理、指数退避、最小间隔、事件发射。
 */
export class TaskRunner {
  private tasks = new Map<BackgroundTaskType, RegisteredTask>()
  private timers = new Map<BackgroundTaskType, ReturnType<typeof setInterval>>()
  private abortControllers = new Map<BackgroundTaskType, AbortController>()
  private store: TaskStore
  private started = false

  constructor(taskStore?: TaskStore) {
    this.store = taskStore ?? new TaskStore()
  }

  register(
    type: BackgroundTaskType,
    executor: TaskExecutor,
    intervalMs: number,
    options?: {
      cooldownMs?: number
      maxFailures?: number
      retryBaseMs?: number
    },
  ): void {
    this.tasks.set(type, {
      type,
      executor,
      intervalMs,
      cooldownMs: options?.cooldownMs ?? intervalMs,
      maxFailures: options?.maxFailures ?? 3,
      retryBaseMs: options?.retryBaseMs ?? 1000,
    })
    // 如果 runner 已启动，注册后立即启动定时器
    if (this.started) {
      this.startTimer(type)
    }
  }

  private startTimer(type: BackgroundTaskType): void {
    if (this.timers.has(type)) return
    const task = this.tasks.get(type)
    if (!task) return
    const timer = setInterval(() => this.tick(type), task.intervalMs)
    this.timers.set(type, timer)
    log('INFO', 'task_runner_started', { type, interval_ms: task.intervalMs })
  }

  start(): void {
    if (this.started) return
    this.started = true
    for (const [type] of this.tasks) {
      this.startTimer(type)
    }
  }

  stop(): void {
    for (const [type, timer] of this.timers) {
      clearInterval(timer)
      this.abortControllers.get(type)?.abort()
      log('INFO', 'task_runner_stopped', { type })
    }
    this.timers.clear()
    this.abortControllers.clear()
  }

  stopType(type: BackgroundTaskType): void {
    const timer = this.timers.get(type)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(type)
    }
    this.abortControllers.get(type)?.abort()
    this.abortControllers.delete(type)
  }

  async triggerNow(type: BackgroundTaskType): Promise<void> {
    return this.tick(type)
  }

  getState(type: BackgroundTaskType) {
    return this.store.get(type)
  }

  has(type: BackgroundTaskType): boolean {
    return this.tasks.has(type)
  }

  private async tick(type: BackgroundTaskType): Promise<void> {
    const task = this.tasks.get(type)
    if (!task) return

    const state = this.store.get(type)

    if (state.status === 'cooldown') {
      if (Date.now() < state.cooldownUntil) return
      this.store.update(type, { status: 'idle', consecutiveFailures: 0, cooldownUntil: 0 })
    }

    if (state.status === 'running') return
    if (state.lastRunAt > 0 && Date.now() - state.lastRunAt < task.intervalMs * 0.5) return

    const ac = new AbortController()
    this.abortControllers.set(type, ac)

    this.store.update(type, { status: 'running', lastRunAt: Date.now() })
    eventBus.emit(`${type}.started` as any, { timestamp: Date.now() })

    let result: TaskExecutionResult
    try {
      result = await task.executor({ state, signal: ac.signal })
    } catch (err: any) {
      result = { success: false, summary: err.message }
    }

    if (result.success) {
      this.store.update(type, { status: 'idle', consecutiveFailures: 0 })
      if (type !== 'telegram.outbox') {
        log('INFO', 'task_runner_completed', { type, summary: result.summary?.slice(0, 100) })
      }
    } else {
      const failures = state.consecutiveFailures + 1
      if (failures >= task.maxFailures) {
        this.store.update(type, {
          status: 'cooldown',
          consecutiveFailures: failures,
          cooldownUntil: Date.now() + task.cooldownMs,
        })
        log('WARN', 'task_runner_cooldown', { type, failures, cooldownMs: task.cooldownMs })
      } else {
        this.store.update(type, { status: 'idle', consecutiveFailures: failures })
      }
      log('WARN', 'task_runner_failed', { type, summary: result.summary?.slice(0, 100) })
    }

    eventBus.emit(`${type}.completed` as any, {
      success: result.success,
      summary: result.summary,
      timestamp: Date.now(),
    })

    this.abortControllers.delete(type)
  }
}
