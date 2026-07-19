/**
 * RuntimeCheckpointAdapter — Runtime ↔ Checkpoint 状态映射适配器。
 *
 * 职责：
 *   1. 从 Runtime 当前状态提取 CheckpointContext
 *   2. 接收 Checkpoint 并重建 Runtime 可用的 restore 计划
 *
 * 不做的：
 *   - 不调用 CheckpointManager（由 RuntimeManager 协调）
 *   - 不解释组件内部状态
 */

import type { Checkpoint, CheckpointContext, SafePoint, SerializedContext, ExecutionState, TaskState } from './CheckpointTypes'
import type { RuntimeTaskImpl } from './RuntimeTaskImpl'
import type { AgentSupervisor } from './AgentSupervisor'
import type { WorkerHandle } from './WorkerContract'
import { RuntimeState } from './RuntimeState'

// ════════════════════════════════════════
//  方向 A: Runtime → CheckpointContext
// ════════════════════════════════════════

export interface RuntimeSnapshot {
  taskId: string
  taskName: string
  taskMetadata?: Record<string, unknown>
  taskCreatedAt: number
  workers: WorkerSnapshot[]
}

export interface WorkerSnapshot {
  workerId: string
  goal: string
  step: number
  safePoint: SafePoint
  state: RuntimeState
  // 由 Runtime 外部提供（如 ConversationContext）
  conversationContext?: unknown
  pendingToolCalls?: unknown[]
  pendingDecision?: { query: string; summary: string }
  // 运行时配置（restore 时注入）
  maxTurns?: number
}

/**
 * 从 RuntimeTask 提取当前状态快照。
 *
 * 映射规则（见 runtime-state-mapping.md）：
 *   - mailBox pending commands → 仅保留 WAITING_SUPERVISOR 的 decision
 *   - abortController / onProgress / 回调 → 丢弃（不可恢复）
 *   - RuntimeState → SafePoint（复合映射：RUNNING → 最近经过的 SafePoint）
 */
export function snapshotRuntimeTask(task: RuntimeTaskImpl): RuntimeSnapshot {
  const status = task.getStatus()
  const workers: WorkerSnapshot[] = []

  for (const w of status.workers) {
    const safePoint = mapStateToSafePoint(w.state, w.step)
    workers.push({
      workerId: w.id,
      goal: w.goal,
      step: w.step,
      safePoint,
      state: w.state as RuntimeState,
      pendingDecision: w.state === RuntimeState.WAITING_SUPERVISOR
        ? { query: '(deferred)', summary: `Worker ${w.id} awaiting supervisor at step ${w.step}` }
        : undefined,
    })
  }

  return {
    taskId: task.id,
    taskName: task.name,
    taskMetadata: task.metadata,
    taskCreatedAt: task.createdAt,
    workers,
  }
}

/**
 * 将 RuntimeSnapshot 转换为 CheckpointManager.create() 所需的上下文。
 */
export function toCheckpointContext(
  snapshot: RuntimeSnapshot,
  extra?: {
    conversationContext?: unknown
    pendingToolCalls?: unknown[]
  },
): Parameters<import('./CheckpointManager').CheckpointManager['create']>[0] {
  const primary = snapshot.workers[0]
  return {
    taskId: snapshot.taskId,
    taskName: snapshot.taskName,
    taskMetadata: snapshot.taskMetadata,
    taskCreatedAt: snapshot.taskCreatedAt,
    executionState: {
      workerId: primary?.workerId ?? 'unknown',
      goal: primary?.goal ?? 'unknown',
      step: primary?.step ?? 0,
      lastSafePoint: primary?.safePoint ?? 'before_llm',
    },
    componentSnapshots: extra
      ? [{ name: 'conversation', snapshot: () => extra.conversationContext }]
      : undefined,
  }
}

// ════════════════════════════════════════
//  方向 B: Checkpoint → RestorePlan
// ════════════════════════════════════════

export interface RestorePlan {
  taskState: TaskState
  executionPlan: WorkerExecutionPlan[]
  resumeStrategy: 'continue' | 'retry_tool' | 'wait_supervisor' | 'complete'
}

export interface WorkerExecutionPlan {
  workerId: string
  goal: string
  step: number
  resumeFrom: SafePoint
  hasPendingDecision: boolean
}

/**
 * 从 Checkpoint 生成 RestorePlan。
 *
 * 决定从哪个 SafePoint 恢复、是否需要 supervisor 干预。
 */
export function planRestore(checkpoint: Checkpoint): RestorePlan {
  const ex = checkpoint.executionState
  const executionPlan: WorkerExecutionPlan[] = [
    {
      workerId: ex.workerId,
      goal: ex.goal,
      step: ex.step,
      resumeFrom: ex.lastSafePoint,
      hasPendingDecision: !!ex.pendingDecision,
    },
  ]

  let resumeStrategy: RestorePlan['resumeStrategy'] = 'continue'
  if (ex.pendingDecision) {
    resumeStrategy = 'wait_supervisor'
  } else if (ex.lastSafePoint === 'after_tool' && ex.pendingToolCalls.length > 0) {
    resumeStrategy = 'retry_tool'
  }

  return {
    taskState: checkpoint.taskState,
    executionPlan,
    resumeStrategy,
  }
}

// ════════════════════════════════════════
//  Helper: RuntimeState → SafePoint
// ════════════════════════════════════════

const STATE_TO_SAFEPOINT: Record<string, SafePoint> = {
  [RuntimeState.RUNNING]: 'before_llm',
  [RuntimeState.WAITING_TOOL]: 'after_tool',
  [RuntimeState.WAITING_SUPERVISOR]: 'after_llm',
  [RuntimeState.PAUSED]: 'before_llm',
  [RuntimeState.INTERRUPTED]: 'before_llm',
}

function mapStateToSafePoint(state: RuntimeState, _step: number): SafePoint {
  return (STATE_TO_SAFEPOINT[state] ?? 'before_llm') as SafePoint
}

export { mapStateToSafePoint }
