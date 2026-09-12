import type { RuntimeState } from './RuntimeState'

// ════════════════════════════════════════════════════════════
// RuntimeMessage — Runtime 的唯一消息总线协议
//
// RuntimeEvent  (上行): Worker → 任意消费者（Supervisor / Logger / Replay / UI / Metrics）
// RuntimeCommand(下行): Supervisor → Worker
//
// 核心原则：
//   1. Worker 永远不知道谁消费 RuntimeEvent。它只关心 emit() 什么内容。
//   2. 协议采用追加式演进（Additive Evolution）。
//      新消息可以新增，但不允许修改已有消息的语义或字段含义。
//      这是 RuntimeMessage 唯一不变的冻结规则。
// ════════════════════════════════════════════════════════════

// ── 消息鉴别 ──

export type RuntimeMessageDirection = 'event' | 'command'

// ── 消息联合 ──

export type RuntimeMessage = RuntimeEvent | RuntimeCommand

// ════════════════════════════════════════════════════════════
// RuntimeEvent — Worker → Supervisor（上行）
// ════════════════════════════════════════════════════════════

export type RuntimeEvent =
  | ProgressEvent
  | MessageEvent
  | ToolEvent
  | CompleteEvent
  | ErrorEvent
  | NeedDecisionEvent
  | StateChangeEvent
  | IllegalTransitionEvent
  | LogEvent

/** EventBus 事件名常量 */
export const RUNTIME_EVENT = 'runtime.agent.event'

// ── 上行事件类型 ──

export interface ProgressEvent {
  type: 'agent.progress'
  direction: 'event'
  workerId: string
  step: number
  description: string
  state: RuntimeState
  timestamp: number
}

export interface MessageEvent {
  type: 'agent.message'
  direction: 'event'
  workerId: string
  content: string
  summary: string
  metadata?: Record<string, unknown>
  timestamp: number
}

export interface ToolEvent {
  type: 'agent.tool'
  direction: 'event'
  workerId: string
  subType: 'invoked' | 'completed' | 'failed'
  toolName: string
  argsPreview: string
  result?: string
  error?: string
  timestamp: number
}

export interface CompleteEvent {
  type: 'agent.complete'
  direction: 'event'
  workerId: string
  summary: string
  result?: string
  timestamp: number
}

export interface ErrorEvent {
  type: 'agent.error'
  direction: 'event'
  workerId: string
  error: string
  fatal: boolean
  step: number
  timestamp: number
}

export interface NeedDecisionEvent {
  type: 'agent.need_decision'
  direction: 'event'
  workerId: string
  /** Worker 用自然语言描述需要决策的问题 */
  query: string
  /** 当前状态摘要（非内部结构） */
  summary: string
  /** Supervisor 可选的上下文引用来决策 */
  metadata?: Record<string, unknown>
  timestamp: number
}

export interface IllegalTransitionEvent {
  type: 'agent.illegal_transition'
  direction: 'event'
  workerId: string
  taskId: string
  from: RuntimeState
  to: RuntimeState
  reason: string
  timestamp: number
}

export interface StateChangeEvent {
  type: 'agent.state_changed'
  direction: 'event'
  workerId: string
  from: RuntimeState
  to: RuntimeState
  reason: string
  timestamp: number
}

export interface LogEvent {
  type: 'agent.log'
  direction: 'event'
  workerId: string
  level: 'info' | 'warn' | 'debug'
  message: string
  data?: Record<string, unknown>
  timestamp: number
}

/** 仅限 RuntimeValidator 消费的任务级事件（由 RuntimeManagerImpl 发射） */
export interface TaskLifecycleEvent {
  type: 'task.created' | 'task.completed' | 'task.failed' | 'task.cancelled'
  direction: 'event'
  taskId: string
  name: string
  timestamp: number
  metadata?: Record<string, unknown>
}

// ════════════════════════════════════════════════════════════
// RuntimeCommand — Supervisor → Worker（下行）
// ════════════════════════════════════════════════════════════

export type RuntimeCommand =
  | { action: 'continue'; direction: 'command'; message?: string; guidance?: string }
  | { action: 'pause'; direction: 'command'; reason: string }
  | { action: 'resume'; direction: 'command' }
  | { action: 'cancel'; direction: 'command'; reason: string }
  | { action: 'redirect'; direction: 'command'; newGoal: string; reason: string }
