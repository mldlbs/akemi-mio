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
import { validateToolCallChain, rollbackToLastKnownGood } from './ContextIntegrityChecker'
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
import { WorkingMemory } from './WorkingMemory'
import {
  createMessageId,
  createSessionId,
  insertMessage,
  getLastSessionId,
  getLastMessageTime,
  getMessagesBySession,
  type StoredMessage,
} from '../db/messages'
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
import { ExecutionGovernor } from './ExecutionGovernor'
import { ObservabilityLogger } from '../observability/ObservabilityLogger'
import { PersonaStateManager } from './PersonaStateManager'
import { PersonaDriftControlSystem, DRIFT_CORRECTION_PROMPT } from './PersonaDriftControlSystem'

export class ChatExecutor {
  private llmService: LlmService
  private ttsService: TtsService
  private mainWindow: BrowserWindow | null
  private workingMemory: WorkingMemory
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
  private obsLogger: ObservabilityLogger | null = null
  private lastUserText = ''
  /** 人格仲裁管理器 */
  private personaManager = new PersonaStateManager()
  /** 人格漂移控制系统 */
  private driftControl = new PersonaDriftControlSystem()
  /** 上轮 drift 评估产生的待注入消息信号 */
  private pendingDriftSignal: string | null = null
  /** 当前加载的 session，用于切换 session 时重建上下文 */
  private currentSessionId: string | null = null
  /** 执行决策门 — 每轮 tool batch 后强制决策 */
  private executionGovernor = new ExecutionGovernor()

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
    this.workingMemory = new WorkingMemory('chat')
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
    return this.workingMemory.context
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

  private resolvePersonaFor(text: string): void {
    const result = this.personaManager.update(text)
    if (result.transitionSignal) {
      this.workingMemory.scratchpad.add('system_hint', result.transitionSignal)
    }
    if (result.changed) {
      this.mainWindow?.webContents.send('persona:updated', {
        level: this.personaManager.getCurrentLevel(),
      })
    }
  }

  private refreshMemory(): void {
    if (!this.memoryService) return
    const memCtx = this.memoryService.getFormattedContext()
    this.obsLogger?.logMemory(this.lastUserText, memCtx)
    const reflectCtx = this.reflectLoop.getFormattedContext()
    // 按需注入：根据用户输入匹配技能
    const skillModules = this.lastUserText
      ? this.skillManager?.getMatchedPromptModules(this.lastUserText) || []
      : this.skillManager?.getEnabledPromptModules() || []
    const extraModules: string[] = [...skillModules]
    // Persona 注入 — 委托 PersonaStateManager
    extraModules.unshift(...this.personaManager.getExtraModules())
    // Drift 修正 — 连续漂移时注入 system prompt 级别修正
    if (this.driftControl.needsCorrectionPrompt()) {
      extraModules.unshift(DRIFT_CORRECTION_PROMPT)
    }
    const wfModule = this.activeWorkflowModule
    const allExtraModules = wfModule ? [wfModule, ...extraModules] : extraModules.length > 0 ? extraModules : undefined
    if (memCtx || reflectCtx || allExtraModules || this.identityContext) {
      this.workingMemory.refreshMemory(memCtx, reflectCtx, allExtraModules, this.identityContext || undefined)
    }
  }

  /** 自动分配或续用 session_id：30 分钟无活动则新建 session */
  private resolveSessionId(): string {
    const lastTime = getLastMessageTime()
    const lastSid = getLastSessionId()
    const THIRTY_MIN = 30 * 60 * 1000
    if (lastSid && lastTime && Date.now() - lastTime < THIRTY_MIN) {
      return lastSid
    }
    return createSessionId()
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

  private noTts = false

  async run(
    text: string,
    requestId?: string,
    source: 'electron' | 'telegram' = 'electron',
    extra?: { telegramChatId?: number; telegramUserId?: number; telegramFrom?: string; telegramMessageId?: number },
    sessionId?: string,
    noTts?: boolean,
  ): Promise<ChatResult> {
    this.noTts = noTts ?? false
    const rid = requestId || createRequestId()
    const t0 = Date.now()
    this.memoryService?.recordInteraction()
    this.memoryService?.setLastUserText(text)
    this.lastUserText = text
    // Persona 仲裁：检测意图 → 路由人格
    this.resolvePersonaFor(text)
    // 注入上轮待处理的 drift 修正信号
    if (this.pendingDriftSignal) {
      this.workingMemory.scratchpad.add('system_hint', this.pendingDriftSignal)
      this.pendingDriftSignal = null
    }
    // 重置跨请求计数器
    this.consecutiveRetryableErrors = 0
    this.consecutiveInvalidRequest = 0
    this.obsLogger = new ObservabilityLogger(rid)
    this.obsLogger.logInput(text, source)
    // session 切换时加载对应历史到 workingMemory
    if (sessionId && sessionId !== this.currentSessionId) {
      this.currentSessionId = sessionId
      this.workingMemory = new WorkingMemory('chat')
      this.refreshMemory()
      const history = getMessagesBySession(sessionId)
      for (const m of history) {
        if (m.role === 'user') {
          this.workingMemory.context.addUser(m.content)
        } else if (m.role === 'assistant') {
          this.workingMemory.context.addAssistant(m.content)
        }
      }
    } else if (!sessionId) {
      this.currentSessionId = null
      this.workingMemory = new WorkingMemory('chat')
    }
    // 先刷新 memory（可能重建 context），再加用户消息，确保消息不丢失
    this.refreshMemory()
    this.workingMemory.addUser(text)
    eventBus.emit('agent.input.received', { text, requestId: rid, source })
    const effectiveSessionId = sessionId || this.resolveSessionId()
    const userMsg: StoredMessage = {
      id: createMessageId(),
      source,
      role: 'user',
      content: text,
      sessionId: effectiveSessionId,
      telegramChatId: extra?.telegramChatId ?? null,
      telegramUserId: extra?.telegramUserId ?? null,
      telegramFrom: extra?.telegramFrom ?? null,
      telegramMessageId: extra?.telegramMessageId ?? null,
      createdAt: Date.now(),
    }
    insertMessage(userMsg)
    this.mainWindow?.webContents.send('message:new', userMsg)

    try {
      const messages: Message[] = this.workingMemory.getMessages()
      trimOrphanedToolCallsFrom(messages)
      const ctx = new RunContext(rid)
      this.runContext = ctx
      const reply = await this.toolLoop(messages, ctx, rid, source)
      if (!reply) {
        this.obsLogger?.logOutput('NO_REPLY', Date.now() - t0)
        this.obsLogger?.flush()
        log('WARN', 'chat_no_reply', { request_id: rid, source, duration_ms: Date.now() - t0 })
        return { error: 'NO_REPLY' }
      }
      this.workingMemory.addAssistant(reply)
      this.obsLogger?.logOutput(reply, Date.now() - t0)
      this.obsLogger?.flush()
      eventBus.emit('agent.response.generated', { text: reply, requestId: rid, source })
      log('PERF', 'round_trip', { request_id: rid, duration_ms: Date.now() - t0, reply_len: reply.length })
      if (!this.noTts) this.ttsService.flushBuffer()
      if (reply) {
        const assistMsg: StoredMessage = {
          id: createMessageId(),
          source,
          role: 'assistant',
          content: reply,
          sessionId: effectiveSessionId,
          createdAt: Date.now(),
        }
        insertMessage(assistMsg)
        this.mainWindow?.webContents.send('message:new', assistMsg)
      }
      this.reflectLoop.trigger({ requestId: rid, userMessage: text, replyLength: reply.length, durationMs: Date.now() - t0 })
      // Persona Drift Control：输出后评估
      if (reply) {
        const { messageSignal } = this.driftControl.evaluateOutput(reply, this.personaManager.getCurrentLevel())
        // 修正信号在下一轮注入（本轮已结束）
        this.pendingDriftSignal = messageSignal
      }
      // P0→P1 沉淀（MetaController.onInteractionEnd）
      if (reply && this.memoryService) {
        this.memoryService.metaController.onInteractionEnd({
          userMessage: text,
          assistantReply: reply,
          tokenUsed: this.resourceBudget.getLlmUsage?.() || 0,
          tokenBudget: this.resourceBudget.getChatBudget?.() || 200000,
          planActive: this.sessionPlanIds.size > 0,
          agentId: 'chat',
        })
      }
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
    this.executionGovernor.reset()
  }

  private async toolLoop(messages: Message[], ctx: RunContext, requestId: string, source: string): Promise<string> {
    ctx.transition(RunState.RUNNING)
    const MAX_TURNS = 300
    /** 诊断：记录 LLM 返回 tool_calls 但未执行的路径 */
    const orphanSources: Record<string, number> = {}
    const tryRecordOrphan = (reason: string, msgsBefore: number) => {
      if (messages.length > msgsBefore) {
        orphanSources[reason] = (orphanSources[reason] || 0) + 1
        log('WARN', 'tool_orphan_born', { step: ctx.step, reason, requestId })
      }
    }
    try {
      for (let i = 0; i < MAX_TURNS; i++) {
        ctx.step = i
        if (ctx.interruptFlag && !ctx.guardrailStop) {
          log('INFO', 'chat_toolLoop_interrupted', { step: i })
          this.obsLogger?.logExit('interrupted')
          return ''
        }
        if (i > 0 && i % 5 === 0 && this.memoryService) {
          this.refreshMemory()
          const f = this.workingMemory.getMessages()
          if (f[0]?.role === 'system') messages[0] = f[0]
        }
        const onToken = (t: string) => {
          if (!ctx.interruptFlag) {
            if (!this.noTts) this.ttsService.addChunk(t)
            this.mainWindow?.webContents.send('ai:chunk', t)
          }
        }
        // trim messages (the actual working array), not workingMemory.context which may
        // be a fresh copy after refreshMemory() at line 239
        trimOrphanedToolCallsFrom(messages)
        // 将 scratchpad 中新条目注入对话
        this.workingMemory.injectScratchpad(messages)
        // 消耗 chat budget：每次 LLM 调用前检查
        const chatBudgetCheck = this.resourceBudget.checkLlmCall('chat')
        if (chatBudgetCheck) {
          log('WARN', 'chat_budget_exhausted', { step: i, check: chatBudgetCheck })
          this.obsLogger?.logExit('budget_exhausted', JSON.stringify(chatBudgetCheck))
          this.workingMemory.scratchpad.add('system_hint', '对话预算已耗尽，请总结当前进展并结束。')
          return ''
        }
        this.resourceBudget.consumeLlmCall('chat')
        this.obsLogger?.logLlmTrace('before', `step=${i} msgs=${messages.length}`)
        this.obsLogger?.logPrompt(messages)
        const tBeforeLlm = Date.now()
        const msgsBeforeCall = messages.length // 锚定：LLM 可能在 messages 中推入 assistant(tool_calls)
        const result = await this.llmService.chatWithTools(messages, requestId, 120000, onToken)
        const llmMs = Date.now() - tBeforeLlm
        this.obsLogger?.logLlmTrace(
          'result',
          `ms=${llmMs} reply_len=${(result.reply || '').length} tools=${result.toolCalls?.length || 0} error=${result.error || 'null'}`,
        )

        const err = this.handleLlmError(result.error, i, messages, ctx)
        if (err === 'return') {
          this.obsLogger?.logExit('llm_error', result.error)
          return ''
        }
        if (err === 'continue') continue

        // Guardrail 请求终止：放行本轮 LLM 回复，然后退出
        if (ctx.guardrailStop) {
          const finalReply = result.reply || '操作已完成。'
          this.obsLogger?.logExit('guardrail_stop', `reply_len=${finalReply.length}`)
          return finalReply
        }

        if (result.toolCalls && result.toolCalls.length > 0) {
          ctx.consecutiveTimeouts = 0
          this.consecutiveRetryableErrors = 0
          if (ctx.interruptFlag && !ctx.guardrailStop) {
            tryRecordOrphan('interrupt_flag', msgsBeforeCall)
            this.obsLogger?.logExit('interrupt_flag')
            return ''
          }
          // ── [OBSERVE] 查询流程记忆和失败模式 ──
          runObserve(result.toolCalls, messages, ctx, {
            proceduralMemory: this.proceduralMemory,
            failureAnalyzer: this.failureAnalyzer,
          })
          // ── [THINK] 大量静默工具调用时注入策略提示 ──
          if (this.thinkStageCount < 3) {
            const thinkResult = runThink(result.toolCalls, result.reply, messages, ctx)
            if (thinkResult.injected) {
              tryRecordOrphan('think_injected', msgsBeforeCall)
              this.thinkStageCount++
              continue
            }
          }
          // ── GoalGuardrail 拦截：在 spend 之前，在 executeAll 之前 ──
          const guardDecision = await this.goalGuardrail.checkBatch(result.toolCalls, messages, ctx)
          if (guardDecision.status === 'denied') {
            tryRecordOrphan('guardrail_denied', msgsBeforeCall)
            this.obsLogger?.logExit('guardrail_denied', `retry=${guardDecision.canRetry}`)
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
          result.toolCalls.forEach((tc) => eventBus.emit('agent.tool.invoked', { tool: tc.name, args: tc.arguments, id: tc.id }))
          const toolResults = await this.toolScheduler.executeAll(result.toolCalls, ctx.abortController.signal)
          this.obsLogger?.logToolBatch(toolResults)
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
            if (tr.success) eventBus.emit('agent.tool.completed', { tool: tr.name, result: tr.content, id: tr.id, latencyMs: tr.latencyMs })
            else eventBus.emit('agent.tool.failed', { tool: tr.name, error: tr.error || '', id: tr.id, latencyMs: tr.latencyMs })
            let c = tr.content || tr.error || ''
            if (c.length > 8000) c = c.slice(0, 8000) + `\n... [已截断，原长 ${c.length} 字符]`
            messages.push({ role: 'tool', tool_call_id: tr.id, content: c })
          }
          // ── [REFLECT] 同步执行反馈（同一轮可见） ──
          runReflect(toolResults, result.toolCalls, messages, ctx)
          this.workingMemory.trimToTokenBudget(600_000)
          if (!ctx.softReplyInjected && i >= 10) {
            ctx.softReplyInjected = true
            this.workingMemory.scratchpad.add('system_hint', '你已执行了多步操作。请立即停止工具调用，向用户汇报当前进展。')
          }
          const gr = this.guardrail.apply(toolResults, result.toolCalls, messages, ctx)
          // ── [DECIDE] ExecutionGovernor 强制决策门 ──
          const gd = this.executionGovernor.evaluate(toolResults, result.toolCalls, ctx)
          if (gd.action === 'stop') {
            log('WARN', 'chat_governor_stop', { step: i, reason: gd.reason })
            if (gd.message) messages.push({ role: 'user', content: gd.message })
            this.obsLogger?.logExit('governor_stop', gd.reason)
            return gd.reason
          }
          if (gd.action === 'shift') {
            log('WARN', 'chat_governor_shift', { step: i, reason: gd.reason })
            if (gd.message) messages.push({ role: 'user', content: gd.message })
            continue
          }
          if (gr.workflowActivation) {
            this.activeWorkflowModule = gr.workflowActivation.moduleContent
            const memCtx = this.memoryService?.getFormattedContext() || '',
              sm = this.skillManager?.getEnabledPromptModules() || []
            this.workingMemory.refreshMemory(memCtx, undefined, [gr.workflowActivation.moduleContent, ...sm], undefined, true)
            messages.length = 0
            messages.push(...this.workingMemory.getMessages())
          }
          this.checkMilestone(i, toolResults, ctx, requestId, !!gr.workflowActivation)
          ctx.transition(RunState.RUNNING)
          continue
        }
        if (result.toolCalls?.length === 0) {
          log('WARN', 'chat_empty_tool_calls', { step: i })
          this.workingMemory.scratchpad.add('system_hint', '工具调用参数解析失败。请重新生成。')
          continue
        }
        const pa = await this.handlePlanForceContinue(result.reply || '', messages, ctx)
        if (pa === 'continue' || pa === 'abandon') continue
        const done = this.subAgentPool.collectCompleted()
        if (done.length > 0) {
          messages.push({ role: 'assistant', content: result.reply || '' })
          const reportLines = done.map((t: any) => {
            const isSkill = t.id?.startsWith('sk_')
            if (isSkill && t.summary) {
              try {
                const parsed = JSON.parse(t.summary)
                const dataStr = parsed.error ? `错误: ${parsed.error}` : `结果: ${JSON.stringify(parsed.data)}`
                return `[${t.status}]${t.goal}\n${dataStr}`
              } catch {
                /* fallback to plain text */
              }
            }
            return `[${t.status}]${t.goal}`
          })
          messages.push({ role: 'user', content: `【后台任务汇报】\n${reportLines.join('\n\n')}` })
          continue
        }
        ctx.transition(RunState.COMPLETED)
        const finalReply = result.reply || ''
        if (!finalReply) this.obsLogger?.logExit('empty_llm_reply', `step=${i}`)
        return finalReply
      }
    } finally {
    }
    this.obsLogger?.logExit('max_turns_exceeded')
    return '操作次数过多，请重新尝试'
  }

  private handleLlmError(e: string | undefined, step: number, m: Message[], ctx: RunContext): 'return' | 'continue' | null {
    if (!e) return null
    if (e === 'TIMEOUT') {
      ctx.consecutiveTimeouts++
      if (ctx.consecutiveTimeouts >= 3) return 'return'
      this.workingMemory.scratchpad.add('error_hint', '超时，请缩短输出量从断点继续。')
      return 'continue'
    }
    const c = this.errorClassifier.classify(e)
    eventBus.emit('recovery.error.classified' as any, { category: c.category })
    if (c.category === 'RETRYABLE') {
      this.consecutiveRetryableErrors++
      return this.consecutiveRetryableErrors >= 3 ? 'return' : 'continue'
    }
    if (c.category === 'CONTEXT_OVERFLOW') {
      this.workingMemory.context.saveToShortTermMemory(5)
      this.workingMemory.trimToTokenBudget(300_000)
      this.workingMemory.scratchpad.add('error_hint', '上下文过长已被压缩。')
      return 'continue'
    }
    if (c.category === 'INVALID_REQUEST') {
      this.consecutiveInvalidRequest++
      if (this.consecutiveInvalidRequest >= 2) {
        log('ERROR', 'chat_invalid_request_rollback', { step, count: this.consecutiveInvalidRequest })
        const stm = this.workingMemory.context.getShortTermMemoryPairs()
        const lastUser = [...m].reverse().find((msg) => msg.role === 'user')
        rollbackToLastKnownGood(m, stm, lastUser?.content)
        this.workingMemory.scratchpad.add('error_hint', '会话状态异常，已回滚到最近的健康检查点，请重试。')
        return 'continue'
      }
      trimOrphanedToolCallsFrom(m)
      this.workingMemory.scratchpad.add('error_hint', '请求格式有误，已清理孤儿 tool_calls，请重试。')
      return 'continue'
    }
    if (c.category === 'CORRUPTED_STATE') {
      // CORRUPTED_STATE 在错误分类器中已具有更高优先级匹配
      // 首次出现就直接回滚，不需要等到第二次
      log('ERROR', 'chat_corrupted_state_rollback', { step, category: c.category })
      const stm = this.workingMemory.context.getShortTermMemoryPairs()
      const lastUser = [...m].reverse().find((msg) => msg.role === 'user')
      rollbackToLastKnownGood(m, stm, lastUser?.content)
      this.workingMemory.scratchpad.add('error_hint', '会话状态异常，已回滚到最近的健康检查点。')
      return 'continue'
    }
    if (c.category === 'CAPABILITY_LOSS') {
      this.workingMemory.scratchpad.add('error_hint', '该工具当前不可用，已跳过。')
      return 'continue'
    }
    if (c.category === 'CONFIGURATION_ERROR') {
      log('WARN', 'chat_configuration_error', { step, error: e.slice(0, 200) })
      return 'return'
    }
    if (c.category === 'TOOL_SCHEMA_ERROR') {
      this.workingMemory.scratchpad.add('error_hint', '工具参数格式有误，请检查后重试。')
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
      this.workingMemory.scratchpad.add('system_hint', `计划「${a.title}」已被放弃。`)
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
      this.workingMemory.scratchpad.add('system_hint', `计划「${a.title}」已被放弃（停滞）。`)
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
        context: this.workingMemory.context,
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
