import type { RuntimeState } from './RuntimeState'
import type { RuntimeCommand } from './RuntimeMessage'
import type { AgentSupervisor } from './AgentSupervisor'
import type { WorkerId, WorkerHandle } from './WorkerContract'
import type { SupervisorStatus, CompletedWorkerResult, SpawnWorkerParams } from './SupervisorTypes'

/**
 * RuntimeTaskImpl — 运行时任务实例。
 *
 * 封装一个 Supervisor + Worker 池，对外屏蔽 Supervisor 引用。
 */
export class RuntimeTaskImpl {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly metadata?: Record<string, unknown>

  private supervisor: AgentSupervisor

  constructor(id: string, name: string, supervisor: AgentSupervisor, metadata?: Record<string, unknown>) {
    this.id = id
    this.name = name
    this.supervisor = supervisor
    this.createdAt = Date.now()
    this.metadata = metadata
  }

  get state(): RuntimeState {
    const s = this.supervisor.getStatus()
    const total = s.workerCount
    if (total === 0) return 'ready' as RuntimeState
    if (s.failed === total) return 'failed' as RuntimeState
    if (s.completed === total) return 'completed' as RuntimeState
    if (s.paused === total) return 'paused' as RuntimeState
    return 'running' as RuntimeState
  }

  spawnWorker(params: SpawnWorkerParams): WorkerHandle {
    return this.supervisor.spawnWorker(params)
  }

  getWorker(workerId: WorkerId): WorkerHandle | undefined {
    return this.supervisor.getWorker(workerId)
  }

  listWorkers(stateFilter?: RuntimeState): WorkerHandle[] {
    return this.supervisor.listWorkers(stateFilter)
  }

  terminateWorker(workerId: WorkerId): void {
    this.supervisor.terminateWorker(workerId)
  }

  /** 向 WaitingSupervisor 状态 Worker 响应决策 */
  respondToDecision(workerId: WorkerId, command: RuntimeCommand): void {
    const worker = this.supervisor.getWorker(workerId)
    if (!worker) return
    worker.send(command)
  }

  pause(reason: string): void {
    for (const w of this.supervisor.listWorkers()) {
      w.send({ action: 'pause', reason, direction: 'command' })
    }
  }

  resume(): void {
    for (const w of this.supervisor.listWorkers()) {
      w.send({ action: 'resume', direction: 'command' })
    }
  }

  cancel(reason: string): void {
    for (const w of this.supervisor.listWorkers()) {
      w.send({ action: 'cancel', reason, direction: 'command' })
    }
  }

  getStatus(): SupervisorStatus {
    return this.supervisor.getStatus()
  }

  collectCompleted(): CompletedWorkerResult[] {
    return this.supervisor.collectCompleted()
  }

  peekCompleted(): CompletedWorkerResult[] {
    return this.supervisor.peekCompleted()
  }
}
