/**
 * SubAgentPoolAdapter — 将 SubAgentPool 接口映射到 RuntimeManager。
 *
 * 目标：在不修改调用者（ChatExecutor、AgentPoolTools、WorkflowScheduler）
 * 的情况下，将 `spawn()` `spawnTask()` `collectCompleted()` 等委托给 Runtime。
 *
 * spawnSkillAgent 仍委托给原生 SubAgentPool（ScopedAgent 是不同抽象，不在 v1 Runtime 覆盖范围）。
 */

import type { ServerManager } from '../mcp/ServerManager'
import { log } from '../logger/Logger'
import { RuntimeManagerImpl } from '../runtime/RuntimeManagerImpl'
import { SupervisedAgentSupervisorImpl } from '../runtime/SupervisedAgentSupervisorImpl'
import { RuntimeTaskImpl } from '../runtime/RuntimeTaskImpl'
import type {
  SubAgentResult,
  SpawnTaskOptions,
  SubAgentStatus,
} from './SubAgentPool'

export class SubAgentPoolAdapter {
  private runtimeManager: RuntimeManagerImpl
  private defaultTask: RuntimeTaskImpl | null = null

  constructor(mcpManager: ServerManager, chatKey: string, codeKey: string) {
    this.runtimeManager = new RuntimeManagerImpl(
      () => new SupervisedAgentSupervisorImpl(mcpManager, chatKey, codeKey),
    )
  }

  /** 确保有默认 Task */
  private ensureTask(): RuntimeTask {
    if (!this.defaultTask) {
      this.defaultTask = this.runtimeManager.createTask('default')
    }
    return this.defaultTask
  }

  /** 派发一个后台子 Agent，立即返回 ID */
  spawn(goal: string, parentGoal?: string, options?: SpawnTaskOptions): string {
    const task = this.ensureTask()
    const wh = task.spawnWorker({
      goal,
      parentGoal,
      maxTurns: options?.maxTurns,
      llmTimeoutMs: options?.llmTimeoutMs,
      allowedToolNames: options?.allowedToolNames,
    })
    log('INFO', 'adapter_spawn', { id: wh.id, goal: goal.slice(0, 60) })
    return wh.id
  }

  /** 派发多个并行任务 */
  spawnBatch(tasks: { goal: string }[], parentGoal?: string): string[] {
    return tasks.map((t) => this.spawn(t.goal, parentGoal))
  }

  /** 派发一个可等待的子任务 */
  async spawnTask(goal: string, systemPrompt?: string, options?: SpawnTaskOptions): Promise<SubAgentResult> {
    const task = this.ensureTask()
    const wh = task.spawnWorker({
      goal,
      systemPrompt,
      maxTurns: options?.maxTurns,
      llmTimeoutMs: options?.llmTimeoutMs,
      allowedToolNames: options?.allowedToolNames,
    })
    await wh.start()
    const result = wh.getResult()
    return result ?? {
      id: wh.id,
      goal,
      status: 'completed' as SubAgentStatus,
      summary: '(no result)',
      startedAt: Date.now(),
      completedAt: Date.now(),
    }
  }

  /** 收集所有已完成但未被消费的结果 */
  collectCompleted(): SubAgentResult[] {
    if (!this.defaultTask) return []
    const completed = this.defaultTask.collectCompleted()
    return completed.map((c) => ({
      id: c.id,
      goal: c.goal,
      status: c.state === 'cancelled' ? 'interrupted' as SubAgentStatus : c.state as SubAgentStatus,
      summary: c.summary,
      error: c.error,
      startedAt: 0,
      completedAt: Date.now(),
    }))
  }

  /** 当前运行中的任务列表 */
  listRunning(): { id: string; goal: string; elapsed: number }[] {
    if (!this.defaultTask) return []
    const status = this.defaultTask.getStatus()
    return status.workers.map((w) => ({
      id: w.id,
      goal: w.goal,
      elapsed: w.elapsedMs,
    }))
  }

  /** 打断一个子任务 */
  interrupt(id: string): boolean {
    if (!this.defaultTask) return false
    this.defaultTask.terminateWorker(id)
    return true
  }

  /** 打断全部运行中的子任务 */
  interruptAll(): number {
    if (!this.defaultTask) return 0
    const count = this.defaultTask.getStatus().running
    this.defaultTask.cancel('adapter_interrupt_all')
    return count
  }

  setKeys(_chatKey: string, _codeKey: string): void {
    // Runtime SupervisedAgentSupervisorImpl 在构造时已注入 key，运行时不需要更新
  }
}
