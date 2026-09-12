import type { AgentRuntimeState } from './AgentRuntimeState'
import type { AgentEvent } from './AgentEvent'
import type { SupervisorConfig, SpawnWorkerParams, SupervisorStatus, CompletedWorkerResult, SupervisorDecision } from './types'
import type { WorkerId, WorkerHandle } from './WorkerContract'

/**
 * AgentSupervisor — 监督式 Agent 编排的核心接口。
 *
 * 独立于 ChatExecutor/TaskExecutor 运行，管理一组 Worker Agent 的生命周期、
 * 事件监听、状态聚合、决策转发。
 *
 * 职责边界：
 *  - spawnWorker：创建受监督的 Worker Agent
 *  - decide：回复 WaitingSupervisor 状态 Worker 的决策请求
 *  - pause/resume/cancel：管控 Worker 生命周期
 *  - getStatus/collectCompleted：状态查询与结果聚合
 */
export interface AgentSupervisor {
  // ── 生命周期 ──

  /** 启动 Supervisor，开始监听 AgentEvent */
  start(config?: Partial<SupervisorConfig>): void

  /** 优雅停止：暂停所有 Worker 后 shutdown */
  stop(): Promise<void>

  /** 是否正在运行 */
  readonly isRunning: boolean

  /** 唯一标识 */
  readonly id: string

  // ── Worker 管理 ──

  /** 派发一个受监督的 Worker Agent */
  spawnWorker(params: SpawnWorkerParams): WorkerHandle

  /** 根据 ID 获取 Worker Handle */
  getWorker(workerId: WorkerId): WorkerHandle | undefined

  /** 终止指定 Worker */
  terminateWorker(workerId: WorkerId): void

  /** 列出所有 Worker（可按状态过滤） */
  listWorkers(stateFilter?: AgentRuntimeState): WorkerHandle[]

  // ── 干预 ──

  /** 向 WaitingSupervisor 状态的 Worker 发送决策 */
  decide(workerId: WorkerId, decision: SupervisorDecision): void

  /** 暂停一个运行中的 Worker */
  pauseWorker(workerId: WorkerId, reason: string): void

  /** 恢复一个已暂停的 Worker */
  resumeWorker(workerId: WorkerId): void

  // ── 查询 ──

  /** 所有 Worker 聚合状态摘要 */
  getStatus(): SupervisorStatus

  /** 收集已完成的 Worker 结果（非阻塞，drain 内部队列） */
  collectCompleted(): CompletedWorkerResult[]
}
