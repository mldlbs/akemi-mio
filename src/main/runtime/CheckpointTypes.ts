/**
 * Checkpoint — Runtime v2 检查点数据结构。
 *
 * 定义见 ADR-010 §1。只定义数据，不绑定存储。
 */

import type { RuntimeState } from './RuntimeState'

export type CheckpointId = string

// ════════════════════════════════════════
//  Core
// ════════════════════════════════════════

export interface Checkpoint {
  id: CheckpointId
  taskId: string

  // 三层版本（见 ADR-009 §4）
  schemaVersion: string
  runtimeCompatibility: {
    min: string
    max: string
  }

  // 恢复所需的核心状态
  taskState: TaskState
  executionState: ExecutionState

  // 可选的外部引用
  memoryReference?: MemoryReference

  // 组件级状态（版本化 payload，CheckpointManager 不解包）
  // key = domain component id, e.g. "workflow-runtime", "blog-session"
  componentStates?: Record<string, VersionedState>

  // 元数据
  createdAt: number
}

// ════════════════════════════════════════
//  TaskState — 不可变元数据
// ════════════════════════════════════════

export interface TaskState {
  name: string
  metadata?: Record<string, unknown>
  createdAt: number
}

// ════════════════════════════════════════
//  ExecutionState — Worker 执行位置
// ════════════════════════════════════════

export interface ExecutionState {
  workerId: string
  goal: string
  step: number
  lastSafePoint: SafePoint
  conversationContext: SerializedContext
  pendingToolCalls: ToolCallState[]
  pendingDecision?: { query: string; summary: string }
}

export interface ToolCallState {
  toolName: string
  args: unknown
  status: 'pending' | 'in_flight'
  retryCount: number
  createdAt: number
}

/** SerializedContext — 双模设计: inline | reference */
export type SerializedContext =
  | { type: 'inline'; messages: unknown[]; tokenEstimate: number }
  | { type: 'reference'; messageCount: number; lastSummary?: string; refId: string; tokenEstimate: number }

// ════════════════════════════════════════
//  MemoryReference
// ════════════════════════════════════════

export interface MemoryReference {
  sessionId?: string
  relevantEntryIds: string[]
  lastAccessTime: number
}

// ════════════════════════════════════════
//  VersionedState — 组件状态通用包装
// ════════════════════════════════════════

export interface VersionedState {
  component: string
  version: string
  data: unknown
  createdAt: number
}

// ════════════════════════════════════════
//  SafePoint
// ════════════════════════════════════════

export enum SafePoint {
  BeforeLLM = 'before_llm',
  AfterLLM = 'after_llm',
  AfterTool = 'after_tool',
}

// ════════════════════════════════════════
//  CheckpointableComponent — 组件快照/恢复接口
//
//  由 Domain Service 实现，例如 WorkflowRuntime、BlogSession。
//  Tool handler 不需要实现此接口。
// ════════════════════════════════════════

export interface CheckpointableComponent {
  /** 组件唯一标识，作为 componentStates 的 key */
  id: string

  /** 捕获当前组件状态 */
  snapshot(): VersionedState | Promise<VersionedState>

  /** 恢复到指定状态 */
  restore(state: VersionedState): Promise<void>
}

// ════════════════════════════════════════
//  ComponentDescriptor — 组件的延迟工厂描述符
//
//  registry stores descriptor, not instance.
//  restore() 每次创建独立实例。
// ════════════════════════════════════════

export interface ComponentDescriptor {
  id: string
  version: string
  create(): CheckpointableComponent
}

// ════════════════════════════════════════
//  Validation
// ════════════════════════════════════════

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

// ════════════════════════════════════════
//  RestoreResult — restore 操作的返回
//  ⚠ 保持最小化，避免过度设计
// ════════════════════════════════════════

export type RestoreStatus = 'ok' | 'failed' | 'degraded'

export interface RestoreResult {
  status: RestoreStatus
  taskId: string
  errors: string[]
  degradedComponents: string[]
}

// ════════════════════════════════════════
//  Recovery Plan — 组件 restore 与 scheduler resume 之间的桥梁
//
//  由 CheckpointableComponent.restore() 生成（Phase 1），
//  在 restore 成功后由 RecoveryActivator 消费（Phase 2）。
// ════════════════════════════════════════

export type WorkflowRecoveryAction = 'resume' | 'register-only' | 'skip'

export interface WorkflowRecoveryPlan {
  runId: string
  action: WorkflowRecoveryAction
  reason?: string
}

export interface WorkflowResumeResult {
  runId: string
  state: 'registered' | 'started' | 'skipped' | 'failed'
  reason?: string
}

/**
 * RecoveryActivator — Phase 2 激活接口。
 *
 * RuntimeRestoreService restore 成功后调用，触发 scheduler 恢复执行。
 * 由调用方（AgentService）注入，保持 RuntimeRestoreService 对 scheduler 无感知。
 */
export interface RecoveryActivator {
  activate(plans: WorkflowRecoveryPlan[]): Promise<void>
}
