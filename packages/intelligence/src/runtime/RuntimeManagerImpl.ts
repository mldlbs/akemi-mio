import type { RuntimeState } from './RuntimeState'
import type { RuntimeTask, TaskId, RuntimeManager } from './RuntimeTask'
import type { AgentSupervisor } from './AgentSupervisor'
import { RuntimeTaskImpl } from './RuntimeTaskImpl'
import { transitionState } from './RuntimeState'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { RUNTIME_EVENT } from './RuntimeMessage'
import { RUNTIME_VALIDATOR_EVENT } from './RuntimeValidator'

let taskCounter = 0

/**
 * RuntimeManagerImpl — 管理所有活跃 RuntimeTask 实例。
 *
 * ChatExecutor 的唯一 Runtime 入口。v1 不支持多任务持久化，
 * 但接口已为未来扩展预留。
 */
export class RuntimeManagerImpl implements RuntimeManager {
  private tasks = new Map<TaskId, RuntimeTaskImpl>()
  private supervisorFactory: () => AgentSupervisor

  constructor(supervisorFactory: () => AgentSupervisor) {
    this.supervisorFactory = supervisorFactory
  }

  createTask(name: string, metadata?: Record<string, unknown>): RuntimeTaskImpl {
    const id = `task_${++taskCounter}_${Date.now().toString(36)}`
    const supervisor = this.supervisorFactory()
    supervisor.start()
    const task = new RuntimeTaskImpl(id, name, supervisor, metadata)
    this.tasks.set(id, task)
    eventBus.emit(RUNTIME_VALIDATOR_EVENT as any, {
      type: 'task.created',
      direction: 'event',
      taskId: id,
      name,
      timestamp: Date.now(),
    })
    return task
  }

  getTask(taskId: TaskId): RuntimeTaskImpl | undefined {
    return this.tasks.get(taskId)
  }

  listTasks(stateFilter?: RuntimeState): RuntimeTaskImpl[] {
    const all = Array.from(this.tasks.values())
    if (!stateFilter) return all
    return all.filter((t) => t.state === stateFilter)
  }

  cancelTask(taskId: TaskId, reason: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.cancel(reason)
    eventBus.emit(RUNTIME_VALIDATOR_EVENT as any, {
      type: 'task.cancelled',
      direction: 'event',
      taskId,
      name: task.name,
      timestamp: Date.now(),
    })
    this.tasks.delete(taskId)
  }
}
