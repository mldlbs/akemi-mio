/**
 * @deprecated 未在任何地方使用。TaskScheduler + TaskRegistry 是现用的执行路径。
 * 保留以供参考，未来的工作流执行器不应基于此实现。
 */
import { TaskRegistry } from './tasks/TaskRegistry'
import { type Task, type TaskExecutionContext } from './tasks/types'
import { ResourceBudget, BudgetExceededError } from './ResourceBudget'

export interface WorkerSlot {
  name: string
  busy: boolean
  currentTaskId: string | null
  startedAt: number | null
}

export class WorkerManager {
  private registry: TaskRegistry
  private slots: WorkerSlot[] = []
  private services: Record<string, unknown> = {}
  private budget: ResourceBudget | null = null
  private emitFn: (event: string, payload: any) => void
  private logFn: (level: string, msg: string, meta?: Record<string, any>) => void

  constructor(
    registry: TaskRegistry,
    options?: {
      maxConcurrency?: number
      emit?: (event: string, payload: any) => void
      log?: (level: string, msg: string, meta?: Record<string, any>) => void
      budget?: ResourceBudget
    },
  ) {
    this.registry = registry
    this.emitFn = options?.emit ?? (() => {})
    this.logFn = options?.log ?? (() => {})
    this.budget = options?.budget ?? null
    const maxSlots = options?.maxConcurrency ?? 4
    for (let i = 0; i < maxSlots; i++) {
      this.slots.push({
        name: `slot_${i}`,
        busy: false,
        currentTaskId: null,
        startedAt: null,
      })
    }
  }

  setServices(svcs: Record<string, unknown>): void {
    this.services = svcs
  }

  setBudget(budget: ResourceBudget): void {
    this.budget = budget
  }

  async execute<I, O>(task: Task<I, O>): Promise<O> {
    // Hard Budget: consume 会抛出 BudgetExceededError
    if (this.budget) {
      this.budget.consumeToolLoopTurn()
    }
    const slot = await this.acquireSlot(task.id)
    try {
      slot.busy = true
      slot.currentTaskId = task.id
      slot.startedAt = Date.now()

      const handler = this.registry.getHandler(task.type)
      if (!handler) {
        throw new Error(`No handler for task type "${task.type}"`)
      }

      const context: TaskExecutionContext = {
        signal: new AbortController().signal,
        services: this.services,
        emit: (event, payload) => this.emitFn(event, payload),
        log: (level, msg, meta) => this.logFn(level, msg, meta),
      }

      return await handler(task, context)
    } finally {
      this.budget?.startRequest()
      slot.busy = false
      slot.currentTaskId = null
      slot.startedAt = null
    }
  }

  getBusyCount(): number {
    return this.slots.filter((s) => s.busy).length
  }

  getAvailableSlots(): number {
    return this.slots.filter((s) => !s.busy).length
  }

  listSlots(): WorkerSlot[] {
    return this.slots.map((s) => ({ ...s }))
  }

  private async acquireSlot(taskId: string): Promise<WorkerSlot> {
    const free = this.slots.find((s) => !s.busy)
    if (free) return free

    return new Promise((resolve) => {
      const check = () => {
        const slot = this.slots.find((s) => !s.busy)
        if (slot) return resolve(slot)
        setTimeout(check, 100)
      }
      check()
    })
  }
}
