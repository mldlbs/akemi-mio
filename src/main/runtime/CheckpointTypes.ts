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
  componentStates?: {
    workflow?: VersionedState
    tools?: VersionedState
  }

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
//  StatefulComponent — 组件快照/恢复接口
// ════════════════════════════════════════

export interface StatefulComponent {
  snapshot(): VersionedState | Promise<VersionedState>
  restore(state: VersionedState): Promise<void>
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
