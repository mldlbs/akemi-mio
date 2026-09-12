import type { RuntimeState } from './RuntimeState'
import type { RuntimeCommand, RuntimeEvent } from './RuntimeMessage'
import type { SupervisorConfig, SpawnWorkerParams, SupervisorStatus, CompletedWorkerResult } from './SupervisorTypes'
import type { WorkerId, WorkerHandle } from './WorkerContract'

/**
 * AgentSupervisor — Runtime 的监督式编排组件。
 *
 * 职责：
 *  - 接收 Worker 发出的 RuntimeEvent
 *  - 向 Worker 发送 RuntimeCommand（继续/暂停/取消/重定向）
 *  - Worker 生命周期管理
 *  - 状态聚合查询
 *
 * 不做的事：
 *  - 不介入 ChatExecutor 的 tool loop
 *  - 不直接操作 Worker 内部状态
 *  - 不暴露 Worker Mailbox
 */
export interface AgentSupervisor {
  // ── 生命周期 ──

  start(config?: Partial<SupervisorConfig>): void
  stop(): Promise<void>
  readonly isRunning: boolean
  readonly id: string

  // ── Worker 管理 ──

  /** 派发一个受监督的 Worker。返回 WorkerHandle */
  spawnWorker(params: SpawnWorkerParams): WorkerHandle

  getWorker(workerId: WorkerId): WorkerHandle | undefined
  terminateWorker(workerId: WorkerId): void
  listWorkers(stateFilter?: RuntimeState): WorkerHandle[]

  // ── 查询 ──

  getStatus(): SupervisorStatus
  /** 收集已完成的 Worker 结果（drain） */
  collectCompleted(): CompletedWorkerResult[]
  /** 非破坏性读取已完成结果（不 drain），用于并行多步骤轮询 */
  peekCompleted(): CompletedWorkerResult[]
}
