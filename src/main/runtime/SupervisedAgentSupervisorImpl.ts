import { eventBus, EventBus } from '../core/EventBus'
import type { ServerManager } from '../mcp/ServerManager'
import { log } from '../logger/Logger'
import type { AgentSupervisor } from './AgentSupervisor'
import type { WorkerId, WorkerHandle } from './WorkerContract'
import type { RuntimeEvent } from './RuntimeMessage'
import { RUNTIME_EVENT, type RuntimeCommand } from './RuntimeMessage'
import { RuntimeState } from './RuntimeState'
import { SupervisedWorkerAgent } from './SupervisedWorkerAgent'
import { LlmService } from '../llm/LlmService'
import type {
  SupervisorConfig,
  SpawnWorkerParams,
  SupervisorStatus,
  CompletedWorkerResult,
} from './SupervisorTypes'
import { DEFAULT_SUPERVISOR_CONFIG } from './SupervisorTypes'

let supervisorCounter = 0

interface WorkerEntry {
  handle: WorkerHandle
  agent: SupervisedWorkerAgent
}

/**
 * SupervisedAgentSupervisorImpl — AgentSupervisor 的具体实现。
 *
 * 职责：
 *   1. 接收 RuntimeEvent（订阅 EventBus）
 *   2. 管理 Worker 生命周期（spawn / cancel / list / status）
 *   3. 收集完成结果
 *
 * 不做：
 *   - 不自动决策（autonomousDecisions 为 false 时）
 *   - 不直接操作 Worker 内部状态
 */
export class SupervisedAgentSupervisorImpl implements AgentSupervisor {
  readonly id: string
  private workers = new Map<WorkerId, WorkerEntry>()
  private completedResults: CompletedWorkerResult[] = []
  private config: SupervisorConfig = { ...DEFAULT_SUPERVISOR_CONFIG }
  private _isRunning = false
  private mcpManager: ServerManager
  private chatKey: string
  private codeKey: string
  private llmOverride?: LlmService

  constructor(mcpManager: ServerManager, chatKey: string, codeKey: string, llmOverride?: LlmService) {
    this.id = `sup_${++supervisorCounter}`
    this.mcpManager = mcpManager
    this.chatKey = chatKey
    this.codeKey = codeKey
    this.llmOverride = llmOverride
  }

  start(config?: Partial<SupervisorConfig>): void {
    if (this._isRunning) return
    if (config) this.config = { ...this.config, ...config }
    this._isRunning = true
    log('INFO', 'supervisor_started', { id: this.id, config: this.config })
  }

  async stop(): Promise<void> {
    if (!this._isRunning) return
    for (const [, entry] of this.workers) {
      entry.handle.send({ action: 'pause', reason: 'supervisor_shutdown', direction: 'command' })
      entry.agent.cancel()
    }
    this.workers.clear()
    this._isRunning = false
    log('INFO', 'supervisor_stopped', { id: this.id })
  }

  get isRunning(): boolean {
    return this._isRunning
  }

  // ── Worker 管理 ──

  spawnWorker(params: SpawnWorkerParams): WorkerHandle {
    const id = `w_${this.id}_${this.workers.size + 1}_${Date.now().toString(36)}`
    const agent = new SupervisedWorkerAgent(
      id,
      params.goal,
      this.mcpManager,
      this.chatKey,
      this.codeKey,
      {
        systemPrompt: params.systemPrompt,
        maxTurns: params.maxTurns ?? this.config.defaultMaxTurns,
        llmTimeoutMs: params.llmTimeoutMs ?? this.config.defaultLlmTimeoutMs,
        allowedToolNames: params.allowedToolNames,
        onProgress: (msg) => log('INFO', 'worker_progress', { id, msg }),
        llmOverride: this.llmOverride,
      },
    )

    const handle: WorkerHandle = {
      id: agent.id,
      goal: agent.goal,
      get state() { return agent.state },
      get step() { return agent.step },
      start: () => agent.run(params.parentGoal).then((r) => this.onWorkerComplete(agent, r)),
      send: (cmd: RuntimeCommand) => agent.send(cmd),
      cancel: () => agent.cancel(),
      getResult: () => null,
    }

    this.workers.set(id, { handle, agent })

    agent.run(params.parentGoal).then((r) => this.onWorkerComplete(agent, r))

    log('INFO', 'supervisor_worker_spawned', { id, goal: params.goal.slice(0, 60) })
    return handle
  }

  getWorker(workerId: WorkerId): WorkerHandle | undefined {
    return this.workers.get(workerId)?.handle
  }

  terminateWorker(workerId: WorkerId): void {
    const entry = this.workers.get(workerId)
    if (!entry) return
    entry.agent.cancel()
    this.completedResults.push({
      id: workerId,
      goal: entry.agent.goal,
      summary: '(terminated)',
      state: 'cancelled',
      durationMs: Date.now() - entry.agent.startedAt,
    })
    this.workers.delete(workerId)
  }

  listWorkers(stateFilter?: RuntimeState): WorkerHandle[] {
    const all = Array.from(this.workers.values()).map((e) => e.handle)
    if (!stateFilter) return all
    return all.filter((h) => h.state === stateFilter)
  }

  // ── 查询 ──

  getStatus(): SupervisorStatus {
    const all = Array.from(this.workers.values()).map((e) => e.agent)
    const now = Date.now()
    return {
      workerCount: all.length,
      running: all.filter((a) => a.state === RuntimeState.RUNNING).length,
      waitingTool: all.filter((a) => a.state === RuntimeState.WAITING_TOOL).length,
      waitingSupervisor: all.filter((a) => a.state === RuntimeState.WAITING_SUPERVISOR).length,
      paused: all.filter((a) => a.state === RuntimeState.PAUSED).length,
      completed: all.filter((a) => a.state === RuntimeState.COMPLETED).length,
      failed: all.filter((a) => a.state === RuntimeState.FAILED).length,
      workers: all.map((a) => ({
        id: a.id,
        goal: a.goal.slice(0, 60),
        state: a.state,
        step: a.step,
        elapsedMs: now - a.startedAt,
      })),
    }
  }

  collectCompleted(): CompletedWorkerResult[] {
    const results = [...this.completedResults]
    this.completedResults = []
    return results
  }

  /** 非破坏性读取已完成结果（不 drain）— 用于并行多步骤轮询场景 */
  peekCompleted(): CompletedWorkerResult[] {
    return [...this.completedResults]
  }

  // ── 内部 ──

  private onWorkerComplete(agent: SupervisedWorkerAgent, result: { status: string; summary: string; error?: string }): void {
    this.workers.delete(agent.id)
    const stateMap: Record<string, 'completed' | 'failed' | 'cancelled'> = {
      completed: 'completed',
      failed: 'failed',
      interrupted: 'cancelled',
    }
    this.completedResults.push({
      id: agent.id,
      goal: agent.goal,
      summary: result.summary,
      state: stateMap[result.status] || 'completed',
      error: result.error,
      durationMs: agent.completedAt ? agent.completedAt - agent.startedAt : 0,
    })
  }
}
