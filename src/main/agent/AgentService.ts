import { BrowserWindow } from 'electron'
import { log, createRequestId } from '../logger/Logger'
import { LlmService } from '../llm/LlmService'
import { AsrService } from '../asr/AsrService'
import { TtsService } from '../tts/TtsService'
import { ConversationContext, Message } from './context'
import { MemoryService } from '../memory/MemoryService'
import { ChatResult } from '../llm/types'
import { IntentResult, IntentHandler } from './intent/types'
import { ServerManager } from '../mcp/ServerManager'
import { eventBus, EventBus } from '../core/EventBus'
import type { PlanManagerLike } from '../evolution/types'
import { extractJsonFromLLMReply } from '../utils/llm'
import { planManager as defaultPlanManager } from '../evolution'
import { SubAgentPool, type SpawnTaskOptions } from './SubAgentPool'
import { getRolePrompt, type SubAgentRoleName } from './roles'
import { ReflectLoop } from './ReflectLoop'
import { FailureAnalyzer } from './FailureAnalyzer'
import { Guardrail } from './Guardrail'
import { GoalGuardrail } from '../governance/GoalGuardrail'
import { CircuitBreaker } from '../core/CircuitBreaker'
import { ResourceBudget } from '../core/ResourceBudget'
import { type TokenAccount } from '../cognitive/TokenEconomy'
import { SleepCycle } from './SleepCycle'
import { SkillManager } from '../skill'
import { RunContext } from './runstate'
import { ToolScheduler } from './ToolScheduler'
import { SessionRecoveryManager } from './SessionRecoveryManager'
import { classify as classifyError } from './ErrorClassifier'
import { TaskExecutor } from './TaskExecutor'
import { ChatExecutor } from './ChatExecutor'
import type { GuardrailPipeline } from '../core/evaluation/GuardrailPipeline'
import type { EvaluationEmitter } from '../core/evaluation/EvaluationEmitter'
import { ProceduralMemory } from './ProceduralMemory'
import { setProceduralMemory, setTtsService, setAsrService } from '../tool/deps'
import { UnifiedKnowledgeQuery, MemoryPluginAdapter, adaptProceduralMemory, adaptReflectLoop, adaptFailureAnalyzer } from '../knowledge'
import { agentPluginRegistry, ObserveStagePluginAdapter, ThinkStagePluginAdapter, ReflectStagePluginAdapter } from './plugin'

export class AgentService {
  private llmService: LlmService
  private asrService: AsrService
  private ttsService: TtsService
  private memoryService: MemoryService | null = null
  private context: ConversationContext
  private mainWindow: BrowserWindow | null = null
  private intentHandlers: Map<string, IntentHandler> = new Map()
  private eventBus: EventBus
  private mcpManager: ServerManager
  private planManager: PlanManagerLike
  private inSelfTask = false
  /** 本次会话中由 LLM 创建的活跃计划 ID，force_continue 仅作用于它们 */
  private sessionPlanIds: Set<string> = new Set()
  /** 运行状态机上下文 */
  private runContext: RunContext | null = null
  /** 并发工具调度器 */
  private toolScheduler: ToolScheduler
  /** Guardrail — 工具循环安全护栏 */
  private guardrail: Guardrail
  /** 自任务超时中止控制器 — 用于取消 timed-out 的进化分析任务 */
  private selfTaskAbortController: AbortController | null = null
  /** 自任务开始时间戳，用于检测挂起超时任务 */
  private selfTaskStartTime: number = 0
  private subAgentPool: SubAgentPool
  readonly reflectLoop = new ReflectLoop()
  readonly proceduralMemory = new ProceduralMemory()
  readonly failureAnalyzer = new FailureAnalyzer()
  readonly sleepCycle = new SleepCycle()
  readonly resourceBudget = new ResourceBudget()
  /** Token 经济账户 — 长期 Token 余额管理 */
  tokenAccount: TokenAccount | null = null
  /** 技能管理器 — 管理外部技能的安装与注入 */
  private skillManager: SkillManager | null = null
  /** 目标守卫 — 工具调用前拦截，防宪法违规 & 目标漂移 */
  readonly goalGuardrail: GoalGuardrail
  /** 熔断器 — 防止 LLM/工具调用级联失败 */
  readonly circuitBreaker = new CircuitBreaker(5, 30000)
  /** 会话恢复管理器 */
  private recoveryManager: SessionRecoveryManager | null = null
  /** 错误分类器 */
  private errorClassifier = { classify: classifyError }
  /** 上次创建检查点的 toolLoop step */
  private lastCheckpointStep = -1
  /** 上次创建检查点的时间戳 */
  private lastCheckpointTime = 0
  /** 连续可重试错误计数 */
  private consecutiveRetryableErrors = 0
  /** 暂停状态 */
  private _paused = false

  /** 身份上下文缓存（由 CognitiveService.identity 提供） */
  private identityContext = ''

  // ── 统一知识源查询引擎 ──
  /** KnowledgeQuery — 跨 Memory/Agent 统一查询 */
  readonly knowledgeQuery: UnifiedKnowledgeQuery

  // ── v2 架构 ──
  /** ChatExecutor — Chat 运行时（独立 context + toolLoop） */
  private chatExecutor: ChatExecutor | null = null
  /** TaskExecutor — Evolution 循环执行引擎 */
  private taskExecutor: TaskExecutor | null = null

  constructor(
    llmService: LlmService,
    asrService: AsrService,
    ttsService: TtsService,
    bus?: EventBus,
    mcpManager?: ServerManager,
    planManager?: PlanManagerLike,
  ) {
    this.llmService = llmService
    this.asrService = asrService
    this.ttsService = ttsService
    this.context = new ConversationContext()
    this.eventBus = bus || eventBus
    this.mcpManager = mcpManager || new ServerManager()
    this.planManager = planManager || defaultPlanManager
    this.toolScheduler = new ToolScheduler(this.mcpManager || new ServerManager())
    this.guardrail = new Guardrail({
      memoryService: null,
      skillManager: null,
      planManager: this.planManager,
    })
    this.goalGuardrail = new GoalGuardrail(null, null, { softCheckInterval: 1 })
    this.subAgentPool = new SubAgentPool(
      this.mcpManager,
      this.eventBus,
      this.llmService['chatApiKey'] || undefined,
      this.llmService['codeApiKey'] || undefined,
    )
    this.registerDefaultHandlers()
    // 监听计划创建，追踪本次会话的活跃计划
    this.eventBus.on('agent.plan.created', (p: { planId: string; title: string }) => {
      this.sessionPlanIds.add(p.planId)
      log('INFO', 'agent_service_plan_tracked', { plan_id: p.planId, title: p.title })
    })

    // ── 统一知识源查询引擎 ──
    // 注册 Memory 和 Agent 侧所有知识源的适配器
    this.knowledgeQuery = new UnifiedKnowledgeQuery()
    // Agent 侧知识源（注册为策略模式实现）
    this.knowledgeQuery.register(adaptProceduralMemory(this.proceduralMemory))
    this.knowledgeQuery.register(adaptReflectLoop(this.reflectLoop))
    this.knowledgeQuery.register(adaptFailureAnalyzer(this.failureAnalyzer))
    log('INFO', 'knowledge_query_initialized', { sources: this.knowledgeQuery.getSourceNames() })

    // ── v2 架构初始化 ──
    // ChatExecutor: 独立 context + toolLoop
    this.chatExecutor = new ChatExecutor(
      this.llmService,
      this.ttsService,
      this.mainWindow,
      this.toolScheduler,
      this.guardrail,
      this.goalGuardrail,
      this.planManager,
      this.resourceBudget,
      this.memoryService,
      this.skillManager,
      this.recoveryManager,
      this.tokenAccount,
      this.subAgentPool,
      this.reflectLoop,
    )

    // 注册流程记忆到工具依赖
    setProceduralMemory(this.proceduralMemory)
    // 注册 TTS 服务到工具依赖（供 PiperTTS 工具调用）
    setTtsService(this.ttsService)
    // 注册 ASR 服务到工具依赖（供 TypographyVerification 工具调用）
    setAsrService(this.asrService)

    this.taskExecutor = new TaskExecutor(this.llmService, this.toolScheduler, this.guardrail, this.planManager, this.resourceBudget)

    // ── 注册内置 Agent 插件到 AgentPluginRegistry ──
    // 模式迁移：ASR 的 SpeechPluginRegistry ServiceLoader 模式
    // （src/main/speech/）迁移到 Agent 认知管线
    this.registerBuiltinPlugins()
  }

  // ══════════════════════════════════════════
  //  Agent Plugin Registry（源自 ASR 的 SpeechPluginRegistry 模式）
  // ══════════════════════════════════════════

  /**
   * 注册内置 Agent 插件到 AgentPluginRegistry。
   *
   * 模式迁移：ASR 的 SpeechPluginRegistry ServiceLoader 模式
   * （src/main/speech/）迁移到 Agent 认知管线。
   *
   * 当前注册：
   * - ObserveStagePluginAdapter — 包装 runObserve
   * - ThinkStagePluginAdapter — 包装 runThink
   * - ReflectStagePluginAdapter — 包装 runReflect
   *
   * 后续可在此注册更多认知阶段插件、行为分析插件等。
   */
  private registerBuiltinPlugins(): void {
    // Observe 阶段插件（需要注入 ProceduralMemory 和 FailureAnalyzer 引用）
    const observePlugin = new ObserveStagePluginAdapter()
    observePlugin.setDeps({
      proceduralMemory: this.proceduralMemory,
      failureAnalyzer: this.failureAnalyzer,
    })
    agentPluginRegistry.register(observePlugin)

    // Think 阶段插件（无状态，不需要依赖注入）
    agentPluginRegistry.register(new ThinkStagePluginAdapter())

    // Reflect 阶段插件（无状态，不需要依赖注入）
    agentPluginRegistry.register(new ReflectStagePluginAdapter())

    log('INFO', 'agent_builtin_plugins_registered', {
      count: 3,
      capabilities: ['cognitive_stage'],
    })
  }

  /**
   * 获取 AgentPluginRegistry 实例（供外部访问）。
   */
  getPluginRegistry(): typeof agentPluginRegistry {
    return agentPluginRegistry
  }

  getMcpManager(): ServerManager {
    return this.mcpManager
  }

  registerIntentHandler(handler: IntentHandler): void {
    this.intentHandlers.set(handler.intent, handler)
  }

  private registerDefaultHandlers(): void {
    this.registerIntentHandler({
      intent: 'open_pump',
      description: '开启泵站',
      execute: (slots) => `已开启${slots.pump_id || '指定泵站'}`,
    })
    this.registerIntentHandler({
      intent: 'close_pump',
      description: '关闭泵站',
      execute: (slots) => `已关闭${slots.pump_id || '指定泵站'}`,
    })
    this.registerIntentHandler({
      intent: 'query_status',
      description: '查询状态',
      execute: (slots) => `${slots.target || '系统'}运行正常，各项指标在正常范围内。`,
    })
    this.registerIntentHandler({
      intent: 'report_alarm',
      description: '报告报警',
      execute: (slots) => `收到${slots.alarm_type || '报警'}${slots.location ? '，位置：' + slots.location : ''}，已通知值班人员处理。`,
    })
  }

  private async classifyIntent(text: string, requestId?: string): Promise<IntentResult | null> {
    const result = await this.llmService.classifyIntent(text, requestId)
    if (result.error || !result.reply) return null
    try {
      const parsed = JSON.parse(result.reply) as IntentResult
      log('INFO', 'intent_parsed', { intent: parsed.intent, slots: parsed.slots })
      if (!parsed.intent || typeof parsed.intent !== 'string') return null
      parsed.slots = parsed.slots || {}
      return parsed
    } catch {
      // 如果直接解析失败，尝试从 markdown 代码围栏中提取 JSON
      const extracted = extractJsonFromLLMReply(result.reply)
      if (extracted) {
        try {
          const parsed = JSON.parse(extracted) as IntentResult
          if (parsed.intent && typeof parsed.intent === 'string') {
            parsed.slots = parsed.slots || {}
            log('INFO', 'intent_parsed_from_fences', { intent: parsed.intent })
            return parsed
          }
        } catch {
          /* fall through */
        }
      }
      log('WARN', 'intent_parse_failed', { raw: result.reply })
      return null
    }
  }

  /** 同步 ChatExecutor 中的 DI 依赖（延时注入后调用） */
  private updateRuntimeDeps(): void {
    this.chatExecutor?.updateDeps({
      memoryService: this.memoryService,
      skillManager: this.skillManager,
      recoveryManager: this.recoveryManager,
      tokenAccount: this.tokenAccount,
      identityContext: this.identityContext || undefined,
      failureAnalyzer: this.failureAnalyzer,
      knowledgeQuery: this.knowledgeQuery,
    })
  }

  setMemoryService(memoryService: MemoryService): void {
    this.memoryService = memoryService
    this.guardrail.updateDeps({ memoryService })
    // 注册 Memory 侧知识源到统一查询引擎
    // MemoryPluginAdapter 将 IMemoryPlugin 适配为 IKnowledgeSource
    for (const plugin of memoryService.unifiedQuery.getAllPlugins()) {
      this.knowledgeQuery.register(new MemoryPluginAdapter(plugin))
    }
    log('INFO', 'memory_plugins_registered_to_knowledge', { pluginCount: memoryService.unifiedQuery.getAllPlugins().length })
    this.refreshMemoryInContext()
    this.updateRuntimeDeps()

    // 初始化 Agent 插件（内存服务就绪后触发，不阻塞主流程）
    // 模式迁移：ASR 的 SpeechPluginRegistry.loadAll() 在引擎就绪后调用
    agentPluginRegistry.loadAll().catch((err) => {
      log('WARN', 'agent_plugin_load_all_failed', { error: String(err) })
    })
  }

  /** 刷新 ConversationContext 中的静态记忆片段，确保 remember_fact 写入后立即可见 */
  private refreshMemoryInContext(lastUserText?: string): void {
    if (!this.memoryService) return

    // 使用统一知识源查询引擎获取合并上下文
    // 策略模式：统一接口隐藏了 Memory + Agent 侧各知识源的差异
    const getCombinedContext = (): string => {
      // Memory 上下文（核心记忆）
      const memCtx = this.memoryService!.getFormattedContext()
      // 尝试从统一知识源获取 agent 侧上下文
      const reflectCtx = this.reflectLoop.getFormattedContext()
      const procCtx = this.proceduralMemory.getFormattedContext()
      const failCtx = this.failureAnalyzer?.getFormattedContext() ?? ''

      return [memCtx, procCtx, reflectCtx, failCtx].filter(Boolean).join('\n\n')
    }

    const skillModules = lastUserText
      ? this.skillManager?.getMatchedPromptModules(lastUserText) || []
      : this.skillManager?.getEnabledPromptModules() || []
    const extraModules = skillModules.length > 0 ? skillModules : undefined
    const allExtraModules = extraModules
    const combinedContext = getCombinedContext()

    if (combinedContext || allExtraModules) {
      this.context = new ConversationContext(
        combinedContext || undefined,
        2000,
        allExtraModules,
        undefined,
        this.reflectLoop.getFormattedContext(),
      )
    }
  }

  setSkillManager(sm: SkillManager): void {
    this.skillManager = sm
    this.guardrail.updateDeps({ skillManager: sm })
    this.updateRuntimeDeps()
  }

  getSkillManager(): SkillManager | null {
    return this.skillManager
  }

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
    this.chatExecutor?.setMainWindow(win)
  }

  /** 注入 GuardrailPipeline（启动时由 AppRuntime 调用） */
  setGuardrailPipeline(pipeline: GuardrailPipeline): void {
    this.chatExecutor?.setGuardrailPipeline(pipeline)
  }

  /** 注入 EvaluationEmitter（启动时由 AppRuntime 调用） */
  setEvaluationEmitter(emitter: EvaluationEmitter): void {
    this.chatExecutor?.setEvaluationEmitter(emitter)
  }

  getContext(): ConversationContext {
    return this.context
  }

  clearContext(): void {
    this.memoryService?.flush()
    this.context.clear()
  }

  getLlmService(): LlmService {
    return this.llmService
  }

  getAsrService(): AsrService {
    return this.asrService
  }

  getTtsService(): TtsService {
    return this.ttsService
  }

  getMemoryService(): MemoryService | null {
    return this.memoryService
  }

  getSubAgentPool(): SubAgentPool {
    return this.subAgentPool
  }

  private async executeIntentCommand(intent: IntentResult, requestId: string): Promise<ChatResult> {
    const handler = this.intentHandlers.get(intent.intent)
    if (!handler) return { error: 'UNKNOWN_INTENT' }
    const reply = await handler.execute(intent.slots)
    this.mainWindow?.webContents.send('ai:chunk', reply)
    log('INFO', 'intent_executed', { request_id: requestId, intent: intent.intent, slots: intent.slots, reply })
    return { reply }
  }

  async processTextInput(
    text: string,
    requestId?: string,
    source: 'electron' | 'telegram' = 'electron',
    extra?: { telegramChatId?: number; telegramUserId?: number; telegramFrom?: string; telegramMessageId?: number },
    sessionId?: string,
    noTts?: boolean,
  ): Promise<ChatResult> {
    // 熔断检查
    const blocked = this.circuitBreaker.allow('llm')
    if (blocked) {
      log('WARN', 'agent_circuit_broken', { reason: blocked })
      return { error: 'CIRCUIT_OPEN' }
    }

    // 会话恢复
    if (this.recoveryManager?.hasInterruptedSession()) {
      this.tryRestoreSession()
    }

    this.resourceBudget.startRequest()

    const rid = requestId || createRequestId()
    const t0 = Date.now()

    this.memoryService?.recordInteraction(text)
    this.memoryService?.setLastUserText(text)

    // 中断正在运行的 Evolution
    if (this.inSelfTask) {
      log('INFO', 'input_preempting_self_task', { requestId: rid })
      this.abortSelfTask()
      let waitMs = 0
      while (this.inSelfTask && waitMs < 3000) {
        await new Promise((r) => setTimeout(r, 10))
        waitMs += 10
      }
      if (this.inSelfTask) {
        log('WARN', 'self_task_preempt_timeout', { requestId: rid })
        this.inSelfTask = false
      }
    }

    try {
      // v2: 委托 ChatExecutor 执行，传入 sessionId 用于加载历史
      const reply = await this.chatExecutor!.run(text, rid, source, extra, sessionId, noTts)
      if (!reply || reply.error) return reply || { error: 'NO_REPLY' }
      log('PERF', 'round_trip', { request_id: rid, duration_ms: Date.now() - t0, reply_len: reply.reply?.length || 0 })
      return reply
    } catch (err) {
      this.eventBus.emit('agent.error', { error: String(err), requestId: rid })
      log('ERROR', 'chat_handler_error', { request_id: rid, error: String(err) })
      await this.saveRecoverySnapshot('error', String(err)).catch(() => {})
      return { error: 'INTERNAL' }
    }
  }

  async stopConversation(): Promise<void> {
    // 取消正在运行的 toolLoop
    this.chatExecutor?.stop()
    this.runContext?.interrupt('user_stop')
    this.runContext = null
    // 停止 TTS 播放
    this.ttsService.stop()
    log('INFO', 'conversation_stopped_by_user')
  }

  isBusy(): boolean {
    return this.inSelfTask || this.chatExecutor?.isBusy() === true
  }

  /** 获取 ChatExecutor 实例（供 IPC handler 调用情感 TTS 等功能） */
  getChatExecutor(): ChatExecutor | null {
    return this.chatExecutor
  }

  /** 暂停 Chat 处理（暂停 ASR/TTS/LLM 调用，保留上下文） */
  pause(): void {
    if (this._paused) return
    this._paused = true
    this.chatExecutor?.stop()
    this.ttsService.stop()
    log('INFO', 'agent_paused')
    this.eventBus.emit('agent.pause' as any, {})
  }

  /** 恢复 Chat 处理 */
  resume(): void {
    if (!this._paused) return
    this._paused = false
    log('INFO', 'agent_resumed')
    this.eventBus.emit('agent.resume' as any, {})
  }

  /** 是否处于暂停状态 */
  isPaused(): boolean {
    return this._paused
  }

  /** 设置/清除强制续行抑制。在 tryRun 前设为 true，防止 toolLoop 注入"停止读取"等干扰提示 */
  setSuppressForceContinue(val: boolean): void {
    if (this.runContext) {
      this.runContext.suppressForceContinue = val
    }
  }

  /** 取消正在运行的自任务（由 SelfEvolutionService 在超时时调用） */
  abortSelfTask(): void {
    // Pause/Resume 模式：请求 TaskExecutor 保存状态而非硬中断
    this.taskExecutor?.pause()
    this.selfTaskAbortController?.abort()
    if (this.runContext) {
      this.runContext.interrupt('self_task_abort')
    }
    log('INFO', 'agent_self_task_aborted')
  }

  /** 获取自任务运行时长（毫秒），无自任务时返回 0 */
  getSelfTaskAge(): number {
    if (!this.inSelfTask || this.selfTaskStartTime === 0) return 0
    return Date.now() - this.selfTaskStartTime
  }

  /** 获取子 agent 状态 */
  getSubAgentStatus(): { running: { id: string; goal: string; elapsed: number }[] } {
    return { running: this.subAgentPool.listRunning() }
  }

  /** 设置会话恢复管理器 */
  setRecoveryManager(rm: SessionRecoveryManager): void {
    this.recoveryManager = rm
    this.updateRuntimeDeps()
  }

  /** 保存恢复快照（检查点） */
  async saveRecoverySnapshot(trigger: 'milestone' | 'error' | 'interrupt' | 'shutdown', error?: string): Promise<void> {
    if (!this.recoveryManager) return
    try {
      const activePlan = this.planManager?.getActivePlan?.()
      const pendingDescriptions = activePlan ? activePlan.steps.filter((s: any) => s.status !== 'done').map((s: any) => s.description) : []
      await this.recoveryManager.createCheckpoint({
        trigger,
        runContext: this.runContext,
        context: this.context,
        runId: this.runContext?.runId ?? `recovery_${Date.now()}`,
        planState: {
          activePlanId: activePlan?.id ?? null,
          activePlanTitle: activePlan?.title ?? null,
          sessionPlanIds: Array.from(this.sessionPlanIds),
          pendingStepDescriptions: pendingDescriptions,
        },
        resourceBudget: this.resourceBudget,
        circuitBreaker: this.circuitBreaker,
        error,
      })
    } catch (err: any) {
      log('WARN', 'save_recovery_snapshot_failed', { error: String(err) })
    }
  }

  /** 尝试恢复中断的会话。返回 true 表示已恢复 */
  private tryRestoreSession(): boolean {
    if (!this.recoveryManager) return false
    if (!this.recoveryManager.hasInterruptedSession()) return false

    // 恢复循环检测：连续 3 次恢复且 60 秒内 → 安全模式
    if (this.recoveryManager.isRecoveryLoop()) {
      log('WARN', 'session_recovery_loop_detected', {})
      this.recoveryManager.clearSession()
      this.recoveryManager.resetRecoveryFailCount()
      return false
    }

    const checkpoint = this.recoveryManager.restoreLatestCheckpoint()
    if (!checkpoint) return false

    log('INFO', 'session_auto_restore', { runId: checkpoint.meta.runId, trigger: checkpoint.meta.trigger })

    this.eventBus.emit('recovery.recovery.started' as any, {
      oldRunId: checkpoint.meta.runId,
      error: checkpoint.meta.trigger === 'error' ? 'previous session error' : 'interrupted',
    })

    // 重建 context
    const memCtx = this.memoryService?.getFormattedContext() || ''
    const reflectCtx = this.reflectLoop.getFormattedContext()
    const skillModules = this.skillManager?.getEnabledPromptModules() || []
    const extraM = skillModules.length > 0 ? skillModules : undefined
    this.context = new ConversationContext(memCtx, 2000, extraM, undefined, reflectCtx)

    // 注入短期记忆对
    for (const pair of checkpoint.shortTermMemory) {
      this.context.addUser(pair.user)
      this.context.addAssistant(pair.assistant)
    }

    // 恢复会话计划 ID
    this.sessionPlanIds = new Set(checkpoint.planState.sessionPlanIds)

    // 构建恢复提示
    let recoveryMsg = '【系统恢复】系统在之前的会话中被中断。以下是恢复信息：'
    if (checkpoint.conversationSummary) {
      recoveryMsg += `\n${checkpoint.conversationSummary}`
    }
    if (checkpoint.planState.activePlanId) {
      recoveryMsg += `\n\n之前的活跃计划: ${checkpoint.planState.activePlanTitle} (${checkpoint.planState.activePlanId})`
      recoveryMsg += '\n请继续完成该计划，不要重新开始。'
    } else {
      recoveryMsg += '\n请从断点继续工作。'
    }
    this.context.addUser(recoveryMsg)

    // 记录恢复尝试
    this.recoveryManager.recordRecoveryAttempt()

    this.eventBus.emit('recovery.session.restored' as any, {
      runId: checkpoint.meta.runId,
      hasUnfinishedPlan: !!checkpoint.planState.activePlanId,
    })

    this.recoveryManager.clearSession()
    this.recoveryManager.resetRecoveryFailCount()

    return true
  }

  async runSelfTask(task: string, systemPrompt?: string): Promise<{ success: boolean; summary: string }> {
    if (this.inSelfTask) return { success: false, summary: '自进化已经在运行' }
    this.inSelfTask = true
    this.selfTaskAbortController = new AbortController()
    this.selfTaskStartTime = Date.now()
    this.resourceBudget.resetToolLoopTurns()
    this.resourceBudget.resetEvolution()
    const savedContext = this.context
    const savedSessionPlanIds = this.sessionPlanIds
    this.sessionPlanIds = new Set()
    this.context = new ConversationContext(undefined, 2000, undefined, systemPrompt)
    try {
      this.context.addUser(task)
      // v2: 使用 TaskExecutor 替代 toolLoop
      const messages: Message[] = this.context.getMessages()
      const ctx = new RunContext(`self_${Date.now()}`)
      this.runContext = ctx
      const reply = await this.taskExecutor!.run(messages, ctx, this.selfTaskAbortController?.signal)
      return { success: !!reply, summary: reply || '' }
    } finally {
      this.inSelfTask = false
      this.selfTaskAbortController = null
      this.selfTaskStartTime = 0
      this.sessionPlanIds = savedSessionPlanIds
      this.context = savedContext
      this.runContext = null
    }
  }

  /**
   * 通过 SubAgentPool 在独立子 agent 中运行任务。
   * 与 runSelfTask 的区别：
   *  - 不进 completedQueue，不影响主对话 collectCompleted()
   *  - 不占用 isBusy() 锁
   *  - 没有 context save/restore
   *  - 没有 inSelfTask 互斥守卫（可并发）
   */
  async runAgentTask(
    task: string,
    systemPrompt?: string,
    options?: { maxTurns?: number; llmTimeoutMs?: number; role?: SubAgentRoleName },
  ): Promise<{ success: boolean; summary: string }> {
    const rolePrompt = options?.role ? getRolePrompt(options.role) : undefined
    const combinedPrompt = [rolePrompt, systemPrompt].filter(Boolean).join('\n\n')
    const spawnOptions: SpawnTaskOptions = {
      maxTurns: options?.maxTurns,
      llmTimeoutMs: options?.llmTimeoutMs,
    }
    const result = await this.subAgentPool.spawnTask(task, combinedPrompt, spawnOptions)
    return {
      success: result.status === 'completed',
      summary: result.summary,
    }
  }
}
