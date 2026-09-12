import type { AgentRuntimeState } from './AgentRuntimeState'

/**
 * Supervisor Agent Event — 监督式 Worker → Supervisor 统一通信协议。
 *
 * 所有事件通过单一 EventBus 事件名 'supervisor.agent.event' 传输。
 * Supervisor 订阅一次，按 type discriminator 分发。
 */
export type AgentEvent =
  ProgressEvent | MessageEvent | ToolEvent | CompleteEvent | ErrorEvent | NeedDecisionEvent | StateChangeEvent | LogEvent

/** EventBus 事件名常量 */
export const SUPERVISOR_EVENT = 'supervisor.agent.event'

// ── 单事件类型 ──

export interface ProgressEvent {
  type: 'agent.progress'
  workerId: string
  step: number
  description: string
  state: AgentRuntimeState
  timestamp: number
}

export interface MessageEvent {
  type: 'agent.message'
  workerId: string
  content: string
  payload?: Record<string, unknown>
  timestamp: number
}

export interface ToolEvent {
  type: 'agent.tool'
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
  workerId: string
  summary: string
  result?: string
  timestamp: number
}

export interface ErrorEvent {
  type: 'agent.error'
  workerId: string
  error: string
  fatal: boolean
  step: number
  timestamp: number
}

export interface NeedDecisionEvent {
  type: 'agent.need_decision'
  workerId: string
  query: string
  context: {
    step: number
    lastToolResults: Array<{ name: string; success: boolean; summary: string }>
    conversationLength: number
  }
  timestamp: number
}

export interface StateChangeEvent {
  type: 'agent.state_changed'
  workerId: string
  from: AgentRuntimeState
  to: AgentRuntimeState
  reason: string
  timestamp: number
}

export interface LogEvent {
  type: 'agent.log'
  workerId: string
  level: 'info' | 'warn' | 'debug'
  message: string
  data?: Record<string, unknown>
  timestamp: number
}
