/**
 * TaskExecutor — Evolution Runtime 独立执行器
 *
 * 专用于 SelfEvolutionService.runSelfTask 的后台执行循环。
 * - 30 轮 toolLoop 上限
 * - 每次 LLM 调用前检查/消耗 evolution budget (max 50)
 * - AbortSignal 支持暂停/取消（Pause/Resume 模式）
 * - 无 TTS、无 forceContinue、无 subAgent 监控
 */

import { log } from '../logger/Logger'
import type { LlmService } from '../llm/LlmService'
import { Message } from './context'
import { eventBus } from '../core/EventBus'
import { Guardrail } from './Guardrail'
import { ToolScheduler } from './ToolScheduler'
import type { PlanManagerLike } from '../evolution/types'
import { ResourceBudget } from '../core/ResourceBudget'
import { RunContext, RunState } from './runstate'
import type { ProceduralMemory } from './ProceduralMemory'
import type { FailureAnalyzer } from './FailureAnalyzer'
import { runObserve } from './ObserveStage'
import { runThink } from './ThinkStage'
import { runReflect } from './ReflectStage'
import { ExecutionGovernor } from './ExecutionGovernor'

const MAX_TURNS = 30

export interface SavedTaskState {
  messages: Message[]
  step: number
  consecutiveTimeouts: number
}

export class TaskExecutor {
  private llmService: LlmService
  private toolScheduler: ToolScheduler
  private guardrail: Guardrail
  private planManager: PlanManagerLike
  private resourceBudget: ResourceBudget

  /** Pause/resume state */
  private _pauseRequested = false
  private _resumeState: SavedTaskState | null = null

  /** OTPAR */
  private proceduralMemory: ProceduralMemory | null = null
  private failureAnalyzer: FailureAnalyzer | null = null
  private thinkStageCount = 0
  private executionGovernor = new ExecutionGovernor()

  constructor(
    llmService: LlmService,
    toolScheduler: ToolScheduler,
    guardrail: Guardrail,
    planManager: PlanManagerLike,
    resourceBudget: ResourceBudget,
  ) {
    this.llmService = llmService
    this.toolScheduler = toolScheduler
    this.guardrail = guardrail
    this.planManager = planManager
    this.resourceBudget = resourceBudget
  }

  /** Request graceful pause — current LLM call is aborted, state is saved for resume */
  pause(): void {
    this._pauseRequested = true
  }

  /** Consume saved state (returns null if none) */
  consumeSavedState(): SavedTaskState | null {
    const state = this._resumeState
    this._resumeState = null
    return state
  }

  /** Whether saved state exists (for pause detection) */
  hasSavedState(): boolean {
    return this._resumeState !== null
  }

  async run(messages: Message[], ctx: RunContext, abortSignal?: AbortSignal): Promise<string> {
    // Resume path: restore saved messages from a prior pause
    if (this._resumeState) {
      messages.splice(0, messages.length, ...this._resumeState.messages)
      this._resumeState = null
    }

    ctx.transition(RunState.RUNNING)

    try {
      for (let i = 0; i < MAX_TURNS; i++) {
        ctx.step = i

        if (ctx.interruptFlag || abortSignal?.aborted) {
          log('INFO', 'task_executor_interrupted', { step: i, reason: ctx.interruptReason })
          return ''
        }

        // Check for graceful pause request (Chat preempted)
        if (this._pauseRequested) {
          this._resumeState = {
            messages: messages.map((m) => ({ ...m })),
            step: i,
            consecutiveTimeouts: ctx.consecutiveTimeouts,
          }
          this._pauseRequested = false
          log('INFO', 'task_executor_paused', { step: i })
          return ''
        }

        // Evolution budget check (soft)
        const budgetCheck = this.resourceBudget.checkLlmCall('evolution')
        if (budgetCheck) {
          log('WARN', 'task_executor_budget_exhausted', { check: budgetCheck, step: i })
          return ''
        }

        const onChunk = (t: string) => {
          if (!ctx.interruptFlag) {
            eventBus.emit('agent.progress' as any, { requestId: ctx.runId, token: t })
          }
        }

        this.resourceBudget.consumeLlmCall('evolution')
        const result = await this.llmService.chatWithTools(messages, ctx.runId, 120000, onChunk)

        if (result.error) {
          if (result.error === 'TIMEOUT') {
            ctx.consecutiveTimeouts++
            if (ctx.consecutiveTimeouts >= 3) break
            messages.push({ role: 'user', content: '【系统提示】超时，请缩短输出量从断点继续。' })
            continue
          }
          log('WARN', 'task_executor_llm_error', { error: result.error, step: i })
          continue
        }

        if (result.toolCalls && result.toolCalls.length > 0) {
          ctx.consecutiveTimeouts = 0
          if (ctx.interruptFlag) return ''

          // ── [OBSERVE] 查询流程记忆和失败模式 ──
          runObserve(result.toolCalls, messages, ctx, {
            proceduralMemory: this.proceduralMemory,
            failureAnalyzer: this.failureAnalyzer,
          })
          // ── [THINK] 大量静默工具调用时注入策略提示 ──
          if (this.thinkStageCount < 2) {
            const thinkResult = runThink(result.toolCalls, result.reply, messages, ctx)
            if (thinkResult.injected) {
              this.thinkStageCount++
              continue
            }
          }

          ctx.transition(RunState.WAIT_TOOL)
          eventBus.emit('agent.progress' as any, { requestId: ctx.runId, step: i + 1, toolNames: result.toolCalls.map((t) => t.name) })

          const toolResults = await this.toolScheduler.executeAll(result.toolCalls, ctx.abortController.signal)
          for (const tr of toolResults) {
            let c = tr.content || tr.error || ''
            if (c.length > 8000) c = c.slice(0, 8000) + `\n... [已截断，原长 ${c.length} 字符]`
            messages.push({ role: 'tool', tool_call_id: tr.id, content: c })
          }

          // ── [REFLECT] 同步执行反馈 ──
          runReflect(toolResults, result.toolCalls, messages, ctx)

          const gr = this.guardrail.apply(toolResults, result.toolCalls, messages, ctx)
          // ── [DECIDE] ExecutionGovernor 强制决策门 ──
          const gd = this.executionGovernor.evaluate(toolResults, result.toolCalls, ctx)
          if (gd.action === 'stop') {
            log('WARN', 'task_governor_stop', { step: i, reason: gd.reason })
            if (gd.message) messages.push({ role: 'user', content: gd.message })
            ctx.transition(RunState.COMPLETED)
            return gd.reason
          }
          if (gd.action === 'shift') {
            log('WARN', 'task_governor_shift', { step: i, reason: gd.reason })
            if (gd.message) messages.push({ role: 'user', content: gd.message })
            ctx.transition(RunState.RUNNING)
            continue
          }
          if (gr.workflowActivation) {
            log('INFO', 'task_executor_workflow_activation', { hasModule: !!gr.workflowActivation.moduleContent })
          }

          ctx.transition(RunState.RUNNING)
          continue
        }

        ctx.transition(RunState.COMPLETED)
        return result.reply || ''
      }
    } finally {
      if (ctx.state !== RunState.COMPLETED && ctx.state !== RunState.FAILED && ctx.state !== RunState.CANCELLED) {
        ctx.transition(RunState.COMPLETED)
      }
    }

    return '操作次数过多，请重新尝试'
  }
}
