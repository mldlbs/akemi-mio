import type { RuntimeState } from './RuntimeState'
import type { WorkerId } from './WorkerContract'

// ── Supervisor 配置 ──

export interface SupervisorConfig {
  /** 最大并发 Worker 数 */
  maxWorkers: number
  /** Worker 默认 maxTurns */
  defaultMaxTurns: number
  /** Worker 默认 LLM 超时 (ms) */
  defaultLlmTimeoutMs: number
  /** 是否由 Supervisor 自主响应 NeedDecision */
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
    state: RuntimeState
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
