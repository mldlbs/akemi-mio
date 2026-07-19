/**
 * CheckpointManager — Runtime v2 检查点管理器接口。
 *
 * 定义见 ADR-010 §2。负责 checkpoint 的创建、持久化、恢复和验证，
 * 但不解释组件内部状态。
 */

import type { Checkpoint, CheckpointId, ValidationResult, RestoreResult, StatefulComponent } from './CheckpointTypes'

/**
 * CheckpointManager 接口。
 *
 * 设计原则：
 * - Runtime 决定何时 checkpoint，CheckpointManager 决定如何保存
 * - CheckpointManager 不解析 componentStates 内部数据
 * - restore() 不保证调用方可以立即运行（失败须由调用方处理）
 */
export interface CheckpointManager {
  /**
   * 创建 checkpoint 数据结构。
   * 不持久化，只组装。调用方可修改后传给 save()。
   */
  create(context: CheckpointContext): Promise<Checkpoint>

  /**
   * 持久化保存 checkpoint。
   * 包含 schemaVersion 填充和兼容性校验。
   */
  save(checkpoint: Checkpoint): Promise<void>

  /**
   * 按 ID 加载 checkpoint。
   * 不验证版本兼容性（由 validate() 或 restore() 负责）。
   */
  load(id: CheckpointId): Promise<Checkpoint>

  /**
   * 验证 checkpoint 在当前 Runtime 是否可恢复。
   * 不执行实际恢复操作。
   */
  validate(checkpoint: Checkpoint): ValidationResult

  /**
   * 完整恢复流程：验证 → 重建 RuntimeTask → 恢复组件 → 标记可运行。
   * 返回 RestoreResult 说明成功/失败/降级情况。
   *
   * 事务语义：核心 restore 失败 → task 不进入 running 状态。
   */
  restore(checkpoint: Checkpoint, components?: StatefulComponent[]): Promise<RestoreResult>
}

/**
 * checkpoint 创建时需要的上下文。
 * 由 Runtime 在触发 checkpoint 时提供。
 */
export interface CheckpointContext {
  taskId: string
  taskName: string
  taskMetadata?: Record<string, unknown>
  taskCreatedAt: number

  executionState: {
    workerId: string
    goal: string
    step: number
    lastSafePoint: string
  }

  /** 可选的状态快照提供器 */
  componentSnapshots?: Array<{ name: string; snapshot: () => unknown }>
}
