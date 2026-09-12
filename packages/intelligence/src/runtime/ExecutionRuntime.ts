/**
 * ExecutionRuntime — 统一任务执行运行时
 *
 * 核心职责：
 * 1. 所有任务（Chat / Evolution / Background / Research）穿过此层
 * 2. 驱动状态机：Understand → Plan → Allocate → Execute → Observe → Reflect → Learn → Idle
 * 3. 强制目标对齐、预算检查、能力检查、权限检查
 * 4. LLM 降级为「文本生成器」— 不再授予工具调用决策权
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { AsyncLock } from '@akemi-mio/core/utils/AsyncLock'
import type { LlmService, ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import type { ServerManager } from '@akemi-mio/intelligence-mcp/ServerManager'
import type { Message } from '@akemi-mio/intelligence/agent/context'
import type { RuntimeTask, RuntimeResult, RuntimePhase, ResourceLimits, ToolExecution, FeedbackEvent, RuntimeConfig } from './types'
import { PHASE_TRANSITIONS, DEFAULT_RUNTIME_CONFIG } from './types'
import type { ResourceBudget } from '@akemi-mio/core/core/ResourceBudget'
import type { GoalEngine } from '../cognitive/GoalEngine'
import { BudgetExceededError } from '@akemi-mio/core/core/ResourceBudget'
import { estimateTokens } from '@akemi-mio/intelligence/agent/context'

/**
 * Runtime 上下文 — 一次执行的生命周期状态
 */
class RuntimeContext {
  readonly task: RuntimeTask
  readonly limits: ResourceLimits
  readonly createdAt: number
  phase: RuntimePhase = 'idle' as RuntimePhase
  messages: Message[] = []
  toolExecutions: ToolExecution[] = []
  llmCallsUsed = 0
  toolCallsUsed = 0
  cpuMsUsed = 0
  phaseTiming: Partial<Record<RuntimePhase, number>> = {}
  private phaseStart = 0
  aborted = false

  constructor(task: RuntimeTask, limits: ResourceLimits) {
    this.task = task
    this.limits = limits
    this.createdAt = Date.now()
  }

  transitionPhase(to: RuntimePhase): boolean {
    const allowed = PHASE_TRANSITIONS[this.phase]
    if (!allowed?.includes(to)) {
      log('WARN', 'runtime_invalid_phase_transition', { from: this.phase, to: this.phase })
      return false
    }
    if (this.phaseStart > 0 && this.phase !== to) {
      this.phaseTiming[this.phase] = (this.phaseTiming[this.phase] || 0) + (Date.now() - this.phaseStart)
    }
    this.phase = to
    this.phaseStart = Date.now()
    return true
  }

  get elapsedMs(): number {
    return Date.now() - this.createdAt
  }

  get tokenCost(): number {
    return this.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  }

  get toolSuccessRate(): number {
    if (this.toolExecutions.length === 0) return 1
    const ok = this.toolExecutions.filter((t) => t.result.success).length
    return ok / this.toolExecutions.length
  }
}

export type GoalChecker = (task: RuntimeTask) => Promise<{ allowed: boolean; reason?: string }>
export type BudgetChecker = (task: RuntimeTask) => Promise<{ allowed: boolean; reason?: string }>
export type CapabilityChecker = (tool: string, args: Record<string, unknown>) => Promise<{ allowed: boolean; reason?: string }>
export type FeedbackHandler = (event: FeedbackEvent) => Promise<void>

/**
 * ExecutionRuntime — 统一执行运行时
 */
export class ExecutionRuntime {
  private config: RuntimeConfig
  private llmService: LlmService
  private mcpManager: ServerManager
  private resourceBudget: ResourceBudget | null = null
  private goalEngine: GoalEngine | null = null
  private feedbackHandlers: FeedbackHandler[] = []
  private lock = new AsyncLock()
  private runningTasks = new Map<string, RuntimeContext>()

  private goalChecker: GoalChecker | null = null
  private budgetChecker: BudgetChecker | null = null
  private capabilityChecker: CapabilityChecker | null = null

  constructor(llmService: LlmService, mcpManager: ServerManager, config?: Partial<RuntimeConfig>) {
    this.llmService = llmService
    this.mcpManager = mcpManager
    this.config = { ...DEFAULT_RUNTIME_CONFIG, ...config }
  }

  // ==================== 依赖注入 ====================

  setResourceBudget(budget: ResourceBudget): void {
    this.resourceBudget = budget
  }

  setGoalEngine(engine: GoalEngine): void {
    this.goalEngine = engine
  }

  setGoalChecker(checker: GoalChecker): void {
    this.goalChecker = checker
  }

  setBudgetChecker(checker: BudgetChecker): void {
    this.budgetChecker = checker
  }

  setCapabilityChecker(checker: CapabilityChecker): void {
    this.capabilityChecker = checker
  }

  onFeedback(handler: FeedbackHandler): void {
    this.feedbackHandlers.push(handler)
  }

  // ==================== 任务执行入口 ====================

  async execute(task: RuntimeTask): Promise<RuntimeResult> {
    const limits = this.config.defaultResourceLimits[task.source]
    const ctx = new RuntimeContext(task, limits)
    this.runningTasks.set(task.id, ctx)

    try {
      // Phase 1: ALLOCATE
      ctx.transitionPhase('allocate' as RuntimePhase)
      const allocation = await this.allocate(ctx)
      if (!allocation.allowed) {
        const result = this.makeResult(ctx, false, allocation.reason || '任务被拒绝')
        this.emitFeedback(ctx, result, !!allocation.budgetRejected, !!allocation.goalRejected)
        return result
      }

      // 任务执行主循环
      return await this.executeLoop(ctx)
    } catch (err: any) {
      log('ERROR', 'runtime_execution_failed', { taskId: task.id, error: err.message })
      const result = this.makeResult(ctx, false, err.message)
      this.emitFeedback(ctx, result, false, false)
      return result
    } finally {
      this.runningTasks.delete(task.id)
    }
  }

  /**
   * 执行主循环 — 可能多轮迭代（LLM → Tool → LLM → Tool → ...）
   */
  private async executeLoop(ctx: RuntimeContext): Promise<RuntimeResult> {
    const maxIterations = Math.min(ctx.limits.maxToolCalls, 50)

    for (let iter = 0; iter < maxIterations; iter++) {
      if (ctx.aborted) break

      // 时间限制检查
      if (ctx.elapsedMs >= ctx.limits.maxTimeMs) {
        return this.makeResult(ctx, false, '执行时间超限')
      }

      // UPDATE messages — 将执行结果注入为 tool 消息
      ctx.transitionPhase('understand' as RuntimePhase)
      this.injectObservationResults(ctx)

      // PLAN — 调用 LLM
      ctx.transitionPhase('plan' as RuntimePhase)
      const plan = await this.plan(ctx)
      if (!plan.success) {
        const reply = ctx.messages.filter((m) => m.role === 'assistant').pop()?.content
        return this.makeResult(ctx, true, undefined, reply ?? undefined)
      }

      // 没有工具调用 → LLM 纯文本回复，执行完成
      if (!plan.toolCalls || plan.toolCalls.length === 0) {
        ctx.transitionPhase('reflect' as RuntimePhase)
        ctx.transitionPhase('learn' as RuntimePhase)
        ctx.transitionPhase('idle' as RuntimePhase)

        const result = this.makeResult(ctx, true, undefined, plan.reply ?? undefined)
        this.emitFeedback(ctx, result, false, false)
        return result
      }

      // 执行工具
      ctx.transitionPhase('execute' as RuntimePhase)
      for (const tc of plan.toolCalls) {
        if (ctx.aborted) break
        if (ctx.toolCallsUsed >= ctx.limits.maxToolCalls) break

        // 能力检查
        if (this.config.enableCapabilityCheck) {
          const capOk = await this.checkCapability(tc.name, tc.arguments)
          if (!capOk.allowed) {
            ctx.toolExecutions.push({
              call: tc,
              result: { success: false, content: '', error: `能力限制: ${capOk.reason}`, latencyMs: 0 },
            })
            continue
          }
        }

        await this.executeTool(ctx, tc)
      }
    }

    // 达到最大迭代次数退出
    ctx.transitionPhase('reflect' as RuntimePhase)
    ctx.transitionPhase('idle' as RuntimePhase)
    const result = this.makeResult(ctx, true)
    this.emitFeedback(ctx, result, false, false)
    return result
  }

  hasRunningTasks(): boolean {
    return this.runningTasks.size > 0
  }

  abortTask(taskId: string): void {
    const ctx = this.runningTasks.get(taskId)
    if (ctx) {
      ctx.aborted = true
      log('INFO', 'runtime_task_aborted', { taskId })
    }
  }

  getConfig(): RuntimeConfig {
    return { ...this.config }
  }

  updateConfig(patch: Partial<RuntimeConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  // ==================== 内部阶段 ====================

  private async allocate(
    ctx: RuntimeContext,
  ): Promise<{ allowed: boolean; reason?: string; budgetRejected?: boolean; goalRejected?: boolean }> {
    if (this.config.enableGoalCheck) {
      if (this.goalChecker) {
        const result = await this.goalChecker(ctx.task)
        if (!result.allowed) return { allowed: false, reason: result.reason, goalRejected: true }
      } else if (this.goalEngine) {
        const goals = this.goalEngine.getActiveGoals()
        if (goals.length > 0 && ctx.task.source === 'evolution') {
          const hasMatch = ctx.task.goalId ? goals.some((g) => g.id === ctx.task.goalId) : true
          if (!hasMatch) {
            return { allowed: false, reason: '当前无匹配的活跃目标', goalRejected: true }
          }
        }
      }
    }

    if (this.config.enableBudgetCheck) {
      if (this.budgetChecker) {
        const result = await this.budgetChecker(ctx.task)
        if (!result.allowed) return { allowed: false, reason: result.reason, budgetRejected: true }
      } else if (this.resourceBudget) {
        const check = this.resourceBudget.checkLlmCall(ctx.task.source as any)
        if (check) return { allowed: false, reason: `预算不足: ${check}`, budgetRejected: true }
        const toolCheck = this.resourceBudget.checkToolLoopTurn()
        if (toolCheck) return { allowed: false, reason: `工具配额不足: ${toolCheck}`, budgetRejected: true }
      }
    }

    return { allowed: true }
  }

  private async plan(ctx: RuntimeContext): Promise<{ success: boolean; reply?: string; toolCalls?: ToolCallInfo[]; error?: string }> {
    try {
      if (this.resourceBudget) {
        try {
          this.resourceBudget.consumeLlmCall(ctx.task.source as any)
        } catch (err) {
          if (err instanceof BudgetExceededError) return { success: false, error: 'LLM 预算耗尽' }
          throw err
        }
      }

      ctx.llmCallsUsed++

      if (ctx.elapsedMs >= ctx.limits.maxTimeMs) return { success: false, error: '执行时间超限' }

      const onChunk = () => {}
      const allowedTools = ctx.task.llmAllowedTools
      const result = await this.llmService.chatWithTools(
        ctx.messages,
        `runtime_${ctx.task.id}`,
        Math.min(120000, ctx.limits.maxTimeMs - ctx.elapsedMs),
        onChunk,
        undefined,
        allowedTools,
      )

      if (result.error) return { success: false, error: result.error }

      return { success: true, reply: result.reply, toolCalls: result.toolCalls }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  private async executeTool(ctx: RuntimeContext, call: ToolCallInfo): Promise<void> {
    const t0 = Date.now()
    try {
      if (this.resourceBudget) {
        try {
          this.resourceBudget.consumeToolLoopTurn()
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            ctx.toolExecutions.push({ call, result: { success: false, content: '', error: 'ToolLoop 预算耗尽', latencyMs: 0 } })
            return
          }
          throw err
        }
      }

      ctx.toolCallsUsed++
      const content = await this.mcpManager.callTool(call.name, call.arguments)
      ctx.toolExecutions.push({ call, result: { success: true, content, latencyMs: Date.now() - t0 } })
      eventBus.emit('agent.tool.completed', { tool: call.name, result: content, requestId: ctx.task.id })
    } catch (err: any) {
      ctx.toolExecutions.push({ call, result: { success: false, content: '', error: err.message, latencyMs: Date.now() - t0 } })
      eventBus.emit('agent.tool.failed', { tool: call.name, error: err.message, requestId: ctx.task.id })
    }
  }

  private async checkCapability(tool: string, args: Record<string, unknown>): Promise<{ allowed: boolean; reason?: string }> {
    if (this.capabilityChecker) return this.capabilityChecker(tool, args)
    return { allowed: true }
  }

  private injectObservationResults(ctx: RuntimeContext): void {
    for (const te of ctx.toolExecutions) {
      const existingIndex = ctx.messages.findIndex((m) => m.role === 'tool' && m.tool_call_id === te.call.id)
      if (existingIndex < 0) {
        let c = te.result.content || te.result.error || ''
        if (c.length > 8000) c = c.slice(0, 8000) + `\n... [已截断，原长 ${c.length} 字符]`
        ctx.messages.push({ role: 'tool', tool_call_id: te.call.id, content: c })
      }
    }
  }

  private makeResult(ctx: RuntimeContext, success: boolean, error?: string, reply?: string): RuntimeResult {
    ctx.transitionPhase('idle' as RuntimePhase)
    return {
      success,
      taskId: ctx.task.id,
      reply: reply || (success ? this.buildFinalReply(ctx) : undefined),
      toolExecutions: ctx.toolExecutions,
      phaseTiming: ctx.phaseTiming,
      totalMs: ctx.elapsedMs,
      tokenCost: ctx.tokenCost,
      error,
    }
  }

  private buildFinalReply(ctx: RuntimeContext): string {
    const ok = ctx.toolExecutions.filter((t) => t.result.success).length
    const total = ctx.toolExecutions.length
    if (total === 0) return '操作已完成。'
    if (ok === total) return `已完成 ${total} 个操作。`
    return `已完成 ${ok}/${total} 个操作，${total - ok} 个失败。`
  }

  private emitFeedback(ctx: RuntimeContext, result: RuntimeResult, budgetRejected: boolean, goalRejected: boolean): void {
    if (!this.config.enableFeedback) return

    const failurePattern = ctx.toolExecutions
      .filter((t) => !t.result.success)
      .map((t) => `${t.call.name}: ${t.result.error}`)
      .join('; ')

    const event: FeedbackEvent = {
      taskId: ctx.task.id,
      source: ctx.task.source,
      phase: ctx.phase,
      result,
      goalId: ctx.task.goalId,
      toolSuccessRate: ctx.toolSuccessRate,
      budgetRejected,
      goalRejected,
      failurePattern: failurePattern || undefined,
      timestamp: Date.now(),
    }

    for (const handler of this.feedbackHandlers) {
      handler(event).catch((err) => log('WARN', 'runtime_feedback_handler_error', { error: err.message }))
    }
  }

  getDiagnostics(): Record<string, unknown> {
    return { runningTasks: this.runningTasks.size, config: this.config }
  }
}
