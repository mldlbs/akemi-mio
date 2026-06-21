/**
 * ChatExecutor — Chat Runtime 独立执行器
 *
 * 拥有自己的 ConversationContext、自己的 toolLoop。
 * 不与其他 Runtime 共享执行上下文。
 * P0 优先级，不受 Budget 限流（但有安全兜底 300 轮）。
 */

import { BrowserWindow } from 'electron'
import { log, createRequestId } from '../logger/Logger'
import type { LlmService } from '../llm/LlmService'
import type { TtsService } from '../tts/TtsService'
import { ConversationContext, Message, buildSystemPrompt, trimOrphanedToolCallsFrom } from './context'
import type { MemoryService } from '../memory/MemoryService'
import { ChatResult } from '../llm/types'
import { eventBus } from '../core/EventBus'
import type { PlanManagerLike } from '../evolution/types'
import { SubAgentPool } from './SubAgentPool'
import { ReflectLoop } from './ReflectLoop'
import { Guardrail } from './Guardrail'
import { GoalGuardrail } from '../governance/GoalGuardrail'
import { ToolScheduler, type ToolResult } from './ToolScheduler'
import type { TokenAccount } from '../cognitive/TokenEconomy'
import { SkillManager } from '../skill'
import { createMessageId, insertMessage, type StoredMessage } from '../db/messages'
import { RunState, RunContext } from './runstate'
import { SessionRecoveryManager } from './SessionRecoveryManager'
import { classify as classifyError } from './ErrorClassifier'
import { evaluateMilestone } from './CheckpointScheduler'
import { ResourceBudget } from '../core/ResourceBudget'
import type { ProceduralMemory } from './ProceduralMemory'
import type { FailureAnalyzer } from './FailureAnalyzer'
import { runObserve } from './ObserveStage'
import { runThink } from './ThinkStage'
import { runReflect } from './ReflectStage'

export class ChatExecutor {
  private llmService: LlmService
  private ttsService: TtsService
  private mainWindow: BrowserWindow | null
  private context: ConversationContext
  private toolScheduler: ToolScheduler
  private guardrail: Guardrail
  private planManager: PlanManagerLike
  private resourceBudget: ResourceBudget
  private memoryService: MemoryService | null
  private skillManager: SkillManager | null
  private recoveryManager: SessionRecoveryManager | null
  private tokenAccount: TokenAccount | null
  private subAgentPool: SubAgentPool
  private reflectLoop: ReflectLoop
  private goalGuardrail: GoalGuardrail
  private sessionPlanIds: Set<string> = new Set()
  private errorClassifier: { classify: (error: string) => any }
  private consecutiveRetryableErrors = 0
  private consecutiveInvalidRequest = 0
  private lastCheckpointStep = -1
  private lastCheckpointTime = 0
  private activeWorkflowModule: string | null = null
  private runContext: RunContext | null = null
  private identityContext = ''
  private proceduralMemory: ProceduralMemory | null = null
  private failureAnalyzer: FailureAnalyzer | null = null
  private thinkStageCount = 0

  constructor(
    llmService: LlmService,
    ttsService: TtsService,
    mainWindow: BrowserWindow | null,
    toolScheduler: ToolScheduler,
    guardrail: Guardrail,
    goalGuardrail: GoalGuardrail,
    planManager: PlanManagerLike,
    resourceBudget: ResourceBudget,
    memoryService: MemoryService | null,
    skillManager: SkillManager | null,
    recoveryManager: SessionRecoveryManager | null,
    tokenAccount: TokenAccount | null,
    subAgentPool: SubAgentPool,
    reflectLoop: ReflectLoop,
  ) {
    this.llmService = llmService
    this.ttsService = ttsService
    this.mainWindow = mainWindow
    this.context = new ConversationContext()
    this.toolScheduler = toolScheduler
    this.guardrail = guardrail
    this.planManager = planManager
    this.resourceBudget = resourceBudget
    this.memoryService = memoryService
    this.skillManager = skillManager
    this.recoveryManager = recoveryManager
    this.tokenAccount = tokenAccount
    this.subAgentPool = subAgentPool
    this.reflectLoop = reflectLoop
    this.goalGuardrail = goalGuardrail
    this.errorClassifier = { classify: classifyError }
  }

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  updateDeps(deps: {
    memoryService?: MemoryService | null
    skillManager?: SkillManager | null
    recoveryManager?: SessionRecoveryManager | null
    tokenAccount?: TokenAccount | null
    mainWindow?: BrowserWindow | null
    identityContext?: string
    proceduralMemory?: ProceduralMemory | null
    failureAnalyzer?: FailureAnalyzer | null
  }): void {
    if (deps.memoryService !== undefined) this.memoryService = deps.memoryService
    if (deps.skillManager !== undefined) this.skillManager = deps.skillManager
    if (deps.recoveryManager !== undefined) this.recoveryManager = deps.recoveryManager
    if (deps.tokenAccount !== undefined) this.tokenAccount = deps.tokenAccount
    if (deps.mainWindow !== undefined) this.mainWindow = deps.mainWindow
    if (deps.identityContext !== undefined) this.identityContext = deps.identityContext
    if (deps.proceduralMemory !== undefined) this.proceduralMemory = deps.proceduralMemory
    if (deps.failureAnalyzer !== undefined) this.failureAnalyzer = deps.failureAnalyzer
  }

  getContext(): ConversationContext {
    return this.context
  }
  getSessionPlanIds(): Set<string> {
    return this.sessionPlanIds
  }
  setSessionPlanIds(ids: Set<string>): void {
    this.sessionPlanIds = ids
  }
  isBusy(): boolean {
    return this.runContext?.running ?? false
  }

  private refreshMemory(): void {
    if (!this.memoryService) return
    const memCtx = this.memoryService.getFormattedContext()
    const reflectCtx = this.reflectLoop.getFormattedContext()
    const skillModules = this.skillManager?.getEnabledPromptModules() || []
    const extraModules = skillModules.length > 0 ? skillModules : undefined
    const wfModule = this.activeWorkflowModule
    const allExtraModules = wfModule ? [wfModule, ...(extraModules || [])] : extraModules
    if (memCtx || reflectCtx || allExtraModules || this.identityContext) {
      this.context = new ConversationContext(memCtx, 2000, allExtraModules, undefined, reflectCtx, this.identityContext || undefined)
    }
  }

  private persistAssistantMessage(reply: string, source: string): void {
    const msg: StoredMessage = {
      id: createMessageId(),
      source: source as any,
      role: 'assistant',
      content: reply,
      createdAt: Date.now(),
    }
    insertMessage(msg)
    this.mainWindow?.webContents.send('message:new', msg)
  }

  async run(
    text: string,
    requestId?: string,
    source: 'electron' | 'telegram' = 'electron',
    extra?: { telegramChatId?: number; telegramUserId?: number; telegramFrom?: string; telegramMessageId?: number },
  ): Promise<ChatResult> {
    const rid = requestId || createRequestId()
    const t0 = Date.now()
    this.memoryService?.recordInteraction()
    this.memoryService?.setLastUserText(text)
    // 先刷新 memory（可能重建 context），再加用户消息，确保消息不丢失
    this.refreshMemory()
    this.context.addUser(text)
    eventBus.emit('agent.input.received', { text, requestId: rid, source })
    const userMsg: StoredMessage = {
      id: createMessageId(),
      source,
      role: 'user',
      content: text,
      telegramChatId: extra?.telegramChatId ?? null,
      telegramUserId: extra?.telegramUserId ?? null,
      telegramFrom: extra?.telegramFrom ?? null,
      telegramMessageId: extra?.telegramMessageId ?? null,
      createdAt: Date.now(),
    }
    insertMessage(userMsg)
    this.mainWindow?.webContents.send('message:new', userMsg)

    try {
      const messages: Message[] = this.context.getMessages()
      const ctx = new RunContext(rid)
      this.runContext = ctx
      const reply = await this.toolLoop(messages, ctx, rid, source)
      if (!reply) return { error: 'NO_REPLY' }
      this.context.addAssistant(reply)
      eventBus.emit('agent.response.generated', { text: reply, requestId: rid, source })
      log('PERF', 'round_trip', { request_id: rid, duration_ms: Date.now() - t0, reply_len: reply.length })
      this.ttsService.flushBuffer()
      if (reply) {
        const assistMsg: StoredMessage = {
          id: createMessageId(),
          source,
          role: 'assistant',
          content: reply,
          createdAt: Date.now(),
        }
        insertMessage(assistMsg)
        this.mainWindow?.webContents.send('message:new', assistMsg)
      }
      this.reflectLoop.trigger({ requestId: rid, userMessage: text, replyLength: reply.length, durationMs: Date.now() - t0 })
      return { reply }
    } catch (err) {
      eventBus.emit('agent.error', { error: String(err), requestId: rid })
      log('ERROR', 'chat_handler_error', { request_id: rid, error: String(err) })
      return { error: 'INTERNAL' }
    } finally {
      this.runContext = null
    }
  }

  stop(): void {
    this.runContext?.interrupt('user_stop')
    this.runContext = null
    this.ttsService.stop()
  }

  private async toolLoop(messages: Message[], ctx: RunContext, requestId: string, source: string): Promise<string> {
    ctx.transition(RunState.RUNNING)
    const MAX_TURNS = 300
    try {
      for (let i = 0; i < MAX_TURNS; i++) {
        ctx.step = i
        if (ctx.interruptFlag) {
          log('INFO', 'chat_toolLoop_interrupted', { step: i })
          return ''
        }
        if (i > 0 && i % 5 === 0 && this.memoryService) {
          this.refreshMemory()
          const f = this.context.getMessages()
          if (f[0]?.role === 'system') messages[0] = f[0]
        }
        const onToken = (t: string) => {
          if (!ctx.interruptFlag) {
            this.ttsService.addChunk(t)
            this.mainWindow?.webContents.send('ai:chunk', t)
          }
        }
        // trim messages (the actual working array), not this.context which may
        // be a fresh copy after refreshMemory() at line 239
        trimOrphanedToolCallsFrom(messages)
        // 消耗 chat budget：每次 LLM 调用前检查
        const chatBudgetCheck = this.resourceBudget.checkLlmCall('chat')
        if (chatBudgetCheck) {
          log('WARN', 'chat_budget_exhausted', { step: i, check: chatBudgetCheck })
          this.context.addUser('【系统提示】对话预算已耗尽，请总结当前进展并结束。')
          return ''
        }
        this.resourceBudget.consumeLlmCall('chat')
        const result = await this.llmService.chatWithTools(messages, requestId, 120000, onToken)

        const err = this.handleLlmError(result.error, i, messages, ctx)
        if (err === 'return') return ''
        if (err === 'continue') continue

        if (result.toolCalls && result.toolCalls.length > 0) {
          ctx.consecutiveTimeouts = 0
          this.consecutiveRetryableErrors = 0
          if (ctx.interruptFlag) return ''
          // ── [OBSERVE] 查询流程记忆和失败模式 ──
          runObserve(result.toolCalls, messages, ctx, {
            proceduralMemory: this.proceduralMemory,
            failureAnalyzer: this.failureAnalyzer,
          })
          // ── [THINK] 大量静默工具调用时注入策略提示 ──
          if (this.thinkStageCount < 3) {
            const thinkResult = runThink(result.toolCalls, result.reply, messages, ctx)
            if (thinkResult.injected) {
              this.thinkStageCount++
              continue
            }
          }
          // ── GoalGuardrail 拦截：在 spend 之前，在 executeAll 之前 ──
          const guardDecision = await this.goalGuardrail.checkBatch(result.toolCalls, messages, ctx)
          if (guardDecision.status === 'denied') {
            if (!guardDecision.canRetry) return '' // 硬拒绝 → 终止本轮
            continue // 软拒绝 → 不 spend/不执行，LLM 重试
          }
          // ── 守卫通过，继续执行 ──
          if (this.tokenAccount) this.tokenAccount.spend(500, 'llm_call_tool', `chat step ${i}`)
          if (!result.reply?.trim()) this.ttsService.stop()
          if (result.reply) {
            this.persistAssistantMessage(result.reply, source)
            const b = result.reply.trim().replace(/[。！？\n].*$/s, '')
            if (b.length >= 4 && !ctx.spokenReplies.some((r) => r.includes(b))) ctx.spokenReplies.push(b)
          }
          ctx.transition(RunState.WAIT_TOOL)
          eventBus.emit('agent.progress' as any, { requestId, step: i + 1, toolNames: result.toolCalls.map((t) => t.name) })
          result.toolCalls.forEach((tc) => eventBus.emit('agent.tool.invoked', { tool: tc.name, args: tc.arguments }))
          const toolResults = await this.toolScheduler.executeAll(result.toolCalls, ctx.abortController.signal)
          // 信用恢复：每个成功的工具调用降低一次拒绝计数
          for (const tr of toolResults) {
            if (tr.success) {
              this.goalGuardrail.onToolSuccess()
              // 流程记忆：记录成功调用的工具名
              this.proceduralMemory?.recordHit(tr.name)
            }
          }
          for (const tr of toolResults) {
            this.emitToolStatus(tr.success ? 'success' : 'error', tr.name, tr.success ? '完成' : `失败: ${tr.error}`)
            if (tr.success) eventBus.emit('agent.tool.completed', { tool: tr.name, result: tr.content })
            else eventBus.emit('agent.tool.failed', { tool: tr.name, error: tr.error || '' })
            let c = tr.content || tr.error || ''
            if (c.length > 8000) c = c.slice(0, 8000) + `\n... [已截断，原长 ${c.length} 字符]`
            messages.push({ role: 'tool', tool_call_id: tr.id, content: c })
          }
          // ── [REFLECT] 同步执行反馈（同一轮可见） ──
          runReflect(toolResults, result.toolCalls, messages, ctx)
          this.context.trimToTokenBudget(600_000)
          if (!ctx.softReplyInjected && i >= 10) {
            ctx.softReplyInjected = true
            messages.push({ role: 'user', content: '【系统提示】你已执行了多步操作。请立即停止工具调用，向用户汇报当前进展。' })
          }
          const gr = this.guardrail.apply(toolResults, result.toolCalls, messages, ctx)
          if (gr.workflowActivation) {
            this.activeWorkflowModule = gr.workflowActivation.moduleContent
            const memCtx = this.memoryService?.getFormattedContext() || '',
              sm = this.skillManager?.getEnabledPromptModules() || []
            this.context = new ConversationContext(memCtx, 2000, [gr.workflowActivation.moduleContent, ...sm])
            messages.length = 0
            messages.push(...this.context.getMessages())
            messages.push({ role: 'system', content: buildSystemPrompt(memCtx, [gr.workflowActivation.moduleContent]) })
          }
          this.checkMilestone(i, toolResults, ctx, requestId, !!gr.workflowActivation)
          ctx.transition(RunState.RUNNING)
          continue
        }
        if (result.toolCalls?.length === 0) {
          log('WARN', 'chat_empty_tool_calls', { step: i })
          messages.push({ role: 'user', content: '【系统提示】工具调用参数解析失败。请重新生成。' })
          continue
        }
        const pa = await this.handlePlanForceContinue(result.reply || '', messages, ctx)
        if (pa === 'continue' || pa === 'abandon') continue
        const done = this.subAgentPool.collectCompleted()
        if (done.length > 0) {
          messages.push({ role: 'assistant', content: result.reply || '' })
          messages.push({ role: 'user', content: `【后台任务汇报】${done.map((t: any) => `[${t.status}]${t.goal}`).join('\n')}` })
          continue
        }
        ctx.transition(RunState.COMPLETED)
        return result.reply || ''
      }
    } finally {
    }
    return '操作次数过多，请重新尝试'
  }

  private handleLlmError(e: string | undefined, step: number, m: Message[], ctx: RunContext): 'return' | 'continue' | null {
    if (!e) return null
    if (e === 'TIMEOUT') {
      ctx.consecutiveTimeouts++
      if (ctx.consecutiveTimeouts >= 3) return 'return'
      m.push({ role: 'user', content: '【系统提示】超时，请缩短输出量从断点继续。' })
      return 'continue'
    }
    const c = this.errorClassifier.classify(e)
    eventBus.emit('recovery.error.classified' as any, { category: c.category })
    if (c.category === 'RETRYABLE') {
      this.consecutiveRetryableErrors++
      return this.consecutiveRetryableErrors >= 3 ? 'return' : 'continue'
    }
    if (c.category === 'CONTEXT_OVERFLOW') {
      this.context.saveToShortTermMemory(5)
      this.context.trimToTokenBudget(300_000)
      m.push({ role: 'user', content: '【系统提示】上下文过长已被压缩。' })
      return 'continue'
    }
    if (c.category === 'INVALID_REQUEST') {
      this.consecutiveInvalidRequest++
      if (this.consecutiveInvalidRequest >= 3) {
        log('ERROR', 'chat_invalid_request_exhausted', { step, count: this.consecutiveInvalidRequest })
        return 'return'
      }
      trimOrphanedToolCallsFrom(m)
      m.push({ role: 'user', content: '【系统提示】请求格式有误，请重试。' })
      return 'continue'
    }
    if (c.category === 'TOOL_SCHEMA_ERROR') {
      m.push({ role: 'user', content: '【系统提示】工具参数格式有误，请检查后重试。' })
      return 'continue'
    }
    return 'return'
  }

  private async handlePlanForceContinue(r: string, m: Message[], ctx: RunContext): Promise<'continue' | 'abandon' | 'done'> {
    const a = this.planManager.getActivePlan()
    if (!a || !this.sessionPlanIds.has(a.id)) return 'done'
    const p = a.steps.filter((s) => s.status !== 'done')
    if (!p.length) return 'done'
    ctx.forceContinueCount++
    log('INFO', 'plan_force_continue', { plan_id: a.id, pending: p.length, fc: ctx.forceContinueCount })
    if (ctx.forceContinueCount > 15) {
      this.planManager.abandonPlan(a.id, '强制续行超限')
      this.sessionPlanIds.delete(a.id)
      ctx.forceContinueCount = 0
      ctx.forceContinueStagnation = 0
      m.push({ role: 'user', content: `【系统】计划「${a.title}」已被放弃。` })
      return 'continue'
    }
    const pd = p.map((s) => s.description).join('|')
    pd === ctx.lastForceContinuePendingDesc ? ctx.forceContinueStagnation++ : (ctx.forceContinueStagnation = 0)
    ctx.lastForceContinuePendingDesc = pd
    if (ctx.forceContinueStagnation >= 5) {
      this.planManager.abandonPlan(a.id, '进度停滞')
      this.sessionPlanIds.delete(a.id)
      ctx.forceContinueCount = 0
      ctx.forceContinueStagnation = 0
      m.push({ role: 'user', content: `【系统】计划「${a.title}」已被放弃（停滞）。` })
      return 'continue'
    }
    m.push({ role: 'assistant', content: r })
    m.push({
      role: 'user',
      content:
        ctx.forceContinueCount <= 3
          ? `【系统强制】计划「${a.title}」(plan_id=${a.id})还有${p.length}步未完成！${p.map((s) => `"${s.description}"`).join('、')}。先写代码，然后update_plan_progress标记完成。`
          : `【强制】计划${a.id}还有${p.length}步未完成。`,
    })
    return 'continue'
  }

  private checkMilestone(step: number, tr: ToolResult[], ctx: RunContext, rid: string, changed: boolean): void {
    if (!this.recoveryManager) return
    const ap = this.planManager?.getActivePlan?.()
    const ms = evaluateMilestone({
      step,
      toolResultsLength: tr.length,
      runContext: ctx,
      activePlanChanged: changed,
      lastCheckpointStep: this.lastCheckpointStep,
      lastCheckpointTime: this.lastCheckpointTime,
      consecutiveTimeoutRecoveries: ctx.consecutiveTimeouts,
    })
    if (!ms.shouldCheckpoint) return
    const pd = ap ? ap.steps.filter((s: any) => s.status !== 'done').map((s: any) => s.description) : []
    this.recoveryManager
      .createCheckpoint({
        trigger: ms.trigger,
        runContext: ctx,
        context: this.context,
        runId: rid,
        planState: {
          activePlanId: ap?.id ?? null,
          activePlanTitle: ap?.title ?? null,
          sessionPlanIds: Array.from(this.sessionPlanIds),
          pendingStepDescriptions: pd,
        },
        resourceBudget: this.resourceBudget,
        circuitBreaker: null as any,
      })
      .catch(() => {})
    this.lastCheckpointStep = step
    this.lastCheckpointTime = Date.now()
  }

  private emitToolStatus(type: 'start' | 'success' | 'error', tool: string, msg: string): void {
    this.mainWindow?.webContents.send('tool:status', { type, tool, message: msg })
  }
}
