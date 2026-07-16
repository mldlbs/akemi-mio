/**
 * RuntimeTask — 运行时任务实例。
 *
 * 一个 RuntimeTask = 一个 Supervisor + 一个 Worker 池。
 *
 * 五层模型：
 *   ChatExecutor（用户交互层）
 *     → RuntimeManager（未来，多 Task 管理）
 *       → RuntimeTask（任务生命周期）
 *         → Supervisor（Worker 协调）
 *           → Worker（具体执行）
 *             → Tool Runtime（工具调用）
 *
 * RuntimeTask 是整个 Runtime 架构的"锚对象"：
 *   - 查询任务 → 查 RuntimeTask
 *   - 取消任务 → 取消 RuntimeTask
 *   - 保存 Checkpoint → 保存 RuntimeTask
 *   - 恢复任务 → 恢复 RuntimeTask
 *
 * v1 不做持久化，但有这个对象后 Future 不需要再调整核心接口。
 */

import type { RuntimeState } from './RuntimeState'
import type { AgentSupervisor } from './AgentSupervisor'
import type { WorkerId, WorkerHandle } from './WorkerContract'
import type { SupervisorStatus, CompletedWorkerResult, SpawnWorkerParams } from './SupervisorTypes'

export type TaskId = string

/** 运行时任务实例 */
export interface RuntimeTask {
  /** 唯一标识 */
  readonly id: TaskId
  /** 任务名称/描述 */
  readonly name: string
  /** 任务生命周期状态 */
  readonly state: RuntimeState
  /** 创建时间戳 */
  readonly createdAt: number
  /** 可选外部元数据 */
  readonly metadata?: Record<string, unknown>

  // ── Supervisor 访问 ──
  // RuntimeTask 拥有 Supervisor，外部不应直接持有 Supervisor 引用。
  // 所有 Worker 操作通过 RuntimeTask 接口完成。

  /** 派发一个受监督的 Worker */
  spawnWorker(params: SpawnWorkerParams): WorkerHandle

  /** 获取 Worker */
  getWorker(workerId: WorkerId): WorkerHandle | undefined

  /** 列出所有 Worker */
  listWorkers(stateFilter?: RuntimeState): WorkerHandle[]

  /** 终止指定 Worker */
  terminateWorker(workerId: WorkerId): void

  // ── 任务级控制 ──

  /** 暂停所有 Worker */
  pause(reason: string): void

  /** 恢复所有 Worker */
  resume(): void

  /** 取消整个任务 */
  cancel(reason: string): void

  // ── 查询 ──

  /** Worker 聚合状态 */
  getStatus(): SupervisorStatus

  /** 收集已完成的 Worker 结果 */
  collectCompleted(): CompletedWorkerResult[]
}

// ── RuntimeManager（Runtime 入口层） ──

/**
 * RuntimeManager — 管理所有活跃 RuntimeTask 实例。
 *
 * ChatExecutor 通过 RuntimeManager 提交任务，不直接接触 Task/Supervisor。
 * v1 默认只有一个 Task，但接口作为统一入口存在。
 */
export interface RuntimeManager {
  createTask(name: string, metadata?: Record<string, unknown>): RuntimeTask
  getTask(taskId: TaskId): RuntimeTask | undefined
  listTasks(stateFilter?: RuntimeState): RuntimeTask[]
  cancelTask(taskId: TaskId, reason: string): void
}
