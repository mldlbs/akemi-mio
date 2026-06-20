import { eventBus } from './EventBus'
import { log } from '../logger/Logger'

export interface ScheduledTask {
  id: string
  pluginName: string
  type: 'once' | 'interval' | 'cron'
  handler: () => string | Promise<string>
  cancelled: boolean
}

let taskIdCounter = 0

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>()
  private timers = new Map<string, ReturnType<typeof setInterval>>()

  private nextId(): string {
    return `sched_${Date.now()}_${++taskIdCounter}`
  }

  once(delayMs: number, handler: () => string | Promise<string>, pluginName = '@system'): string {
    const id = this.nextId()
    const task: ScheduledTask = { id, pluginName, type: 'once', handler, cancelled: false }
    this.tasks.set(id, task)

    const timer = setTimeout(async () => {
      if (task.cancelled) return
      await this.executeTask(task)
      this.tasks.delete(id)
    }, delayMs)

    this.timers.set(id, timer)
    return id
  }

  interval(intervalMs: number, handler: () => string | Promise<string>, pluginName = '@system'): string {
    const id = this.nextId()
    const task: ScheduledTask = { id, pluginName, type: 'interval', handler, cancelled: false }
    this.tasks.set(id, task)

    const timer = setInterval(async () => {
      if (task.cancelled) return
      await this.executeTask(task)
    }, intervalMs)

    this.timers.set(id, timer)
    return id
  }

  cron(
    minute: number | '*',
    hour: number | '*',
    handler: () => string | Promise<string>,
    pluginName = '@system'
  ): string {
    const id = this.nextId()
    const task: ScheduledTask = { id, pluginName, type: 'cron', handler, cancelled: false }
    this.tasks.set(id, task)

    const tick = () => {
      if (task.cancelled) return
      const now = new Date()
      if (minute !== '*' && now.getMinutes() !== minute) return
      if (hour !== '*' && now.getHours() !== hour) return
      this.executeTask(task)
    }

    const timer = setInterval(tick, 30000)
    this.timers.set(id, timer)
    return id
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false
    task.cancelled = true
    const timer = this.timers.get(id)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(id)
    }
    this.tasks.delete(id)
    return true
  }

  cancelAll(pluginName: string): number {
    let count = 0
    for (const [id, task] of this.tasks) {
      if (task.pluginName === pluginName) {
        this.cancel(id)
        count++
      }
    }
    return count
  }

  list(): ScheduledTask[] {
    return Array.from(this.tasks.values())
  }

  count(): number {
    return this.tasks.size
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    eventBus.emit('scheduler.tick', { taskId: task.id, cron: task.type })
    try {
      const result = await task.handler()
      eventBus.emit('scheduler.task.completed', { taskId: task.id, result })
      log('INFO', 'scheduler_task_done', { task_id: task.id, plugin: task.pluginName })
    } catch (err: any) {
      eventBus.emit('scheduler.task.failed', { taskId: task.id, error: err.message })
      log('WARN', 'scheduler_task_error', { task_id: task.id, plugin: task.pluginName, error: err.message })
    }
  }

  shutdown(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
    this.tasks.clear()
  }
}

export const scheduler = new Scheduler()
