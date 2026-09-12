import type { AgentRuntimeState } from './AgentRuntimeState'
import type { WorkerId, WorkerHandle } from './WorkerContract'

// ── Supervisor 决策 —— Supervisor → Worker（通过 Mailbox） ──

export type SupervisorDecision =
  | { action: 'continue'; message?: string; guidance?: string }
  | { action: 'pause'; reason: string }
  | { action: 'resume' }
  | { action: 'cancel'; reason: string }
  | { action: 'redirect'; newGoal: string; reason: string }

// ── Supervisor 配置 ──

export interface SupervisorConfig {
  /** 最大并发 Worker 数 */
  maxWorkers: number
  /** Worker 默认 maxTurns */
  defaultMaxTurns: number
  /** Worker 默认 LLM 超时 (ms) */
  defaultLlmTimeoutMs: number
  /** 是否由 Supervisor 自主响应 NeedDecision（否 → 转发给 ChatExecutor LLM） */
  autonomousDecisions: boolean
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  maxWorkers: 5,
  defaultMaxTurns: 15,
  defaultLlmTimeoutMs: 120_000,
  autonomousDecisions: false,
}

// ── Spawn 参数 ──

export interface SpawnWorkerParams {
  goal: string
  systemPrompt?: string
  parentGoal?: string
  maxTurns?: number
  llmTimeoutMs?: number
  allowedToolNames?: string[]
  /** 设定后 Supervisor 可自主回应 NeedDecision（绕过 ChatExecutor 转发） */
  supervisorLlmConfig?: { chatKey: string; codeKey: string }
}

// ── 聚合状态 ──

export interface SupervisorStatus {
  workerCount: number
  running: number
  waitingTool: number
  waitingSupervisor: number
  paused: number
  completed: number
  failed: number
  workers: Array<{
    id: WorkerId
    goal: string
    state: AgentRuntimeState
    step: number
    elapsedMs: number
  }>
}

export interface CompletedWorkerResult {
  id: WorkerId
  goal: string
  summary: string
  state: 'completed' | 'failed' | 'cancelled'
  error?: string
  durationMs: number
}

// ── Worker 运行时配置（SupervisedWorkerAgent 构造参数） ──

export interface WorkerRuntimeConfig {
  goal: string
  parentGoal?: string
  systemPrompt?: string
  maxTurns: number
  llmTimeoutMs: number
  allowedToolNames?: string[]
  mcpManager: import('@akemi-mio/intelligence-mcp/ServerManager').ServerManager
  chatKey: string
  codeKey: string
  eventBus: import('@akemi-mio/core/core/EventBus').EventBus
  supervisorId: string
}
