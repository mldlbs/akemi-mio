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
import { eventBus, type EventPayload } from '../core/EventBus'
import type { PlanManagerLike } from '../evolution/types'
import { SubAgentPoolAdapter } from './SubAgentPoolAdapter'
import { ReflectLoop } from './ReflectLoop'
import { Guardrail } from './Guardrail'
import { ProgressGuardrail } from './ProgressGuardrail'
import { GuardrailPipeline } from '../core/evaluation/GuardrailPipeline'
import type { EvaluationEmitter } from '../core/evaluation/EvaluationEmitter'
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
import { RunState, RunContext, GovernorRecord } from './runstate'
import { SessionRecoveryManager } from './SessionRecoveryManager'
import { classify as classifyError } from './ErrorClassifier'
import { evaluateMilestone } from './CheckpointScheduler'
import { ResourceBudget } from '../core/ResourceBudget'
import type { ProceduralMemory } from './ProceduralMemory'
import type { FailureAnalyzer } from './FailureAnalyzer'
import type { UnifiedKnowledgeQuery } from '../knowledge/UnifiedKnowledgeQuery'
import { runObserve } from './ObserveStage'
import { runThink } from './ThinkStage'
import { runReflect } from './ReflectStage'
import { ExecutionGovernor } from './ExecutionGovernor'
import { ObservabilityLogger } from '../observability/ObservabilityLogger'
import { PersonaStateManager } from './PersonaStateManager'
import { setPersonaStateManager } from '../tool/deps'
import { PersonaDriftControlSystem, DRIFT_CORRECTION_PROMPT } from './PersonaDriftControlSystem'
import { classifyContent } from './ContentClassifier'
import { userBehaviorAnalyzer, type SceneLabel, type ResponseMode, type InteractionDetail } from './UserBehaviorAnalyzer'
import { ToolPolicyPlanner } from './toolPolicy/ToolPolicyPlanner'
import { ToolPromptAssembler } from './toolPolicy/ToolPromptAssembler'
import type { ToolDecision } from './toolPolicy/types'
import { behaviorStateMachine } from '../behavior/BehaviorStateMachine'
import type { BehaviorMode } from '../behavior/BehaviorStateMachine'
import { correctionPatternLearner } from '../behavior/CorrectionPatternLearner'
import { taskOrchestrationModeManager } from '../behavior/TaskOrchestrationModeManager'
import { behaviorPreferenceStore } from '../behavior/BehaviorPreferenceStore'
import { toolDefaultAdjuster } from '../behavior/ToolDefaultAdjuster'
import { buildTtsNeed } from '../behavior/UserBehaviorTtsContract'
import { asrHotwordManager } from '../asr/AsrHotwordManager'
import { sentimentAnalyzer } from '../tts/SentimentAnalyzer'
import { agentMonitor, type AgentMonitor, type RoundMetrics } from './AgentMonitor'
import { emotionToneMap } from '../tts/EmotionToneMap'
import type { EmotionTtsParams, UserToneProfile, VoiceStyle, ReplyCategory } from '../tts/types'
import { toneProfileAnalyzer } from '../tts/ToneProfileAnalyzer'
import { toneToVoiceMapper } from '../tts/ToneToVoiceMapper'
import { toneProfileCache } from '../tts/UserToneProfileCache'
import { voiceStyleMap } from '../tts/VoiceStyleMap'
import { behaviorEmotionDetector } from '../tts/BehaviorEmotionDetector'
import { userInputEmotionAnalyzer, type UserInputEmotionResult } from '../tts/UserInputEmotionAnalyzer'
import { contextualTtsAdvisor } from '../tts/ContextualTtsAdvisor'
import { memoryEmotionBridge } from '../tts/MemoryEmotionBridge'
import { memoryTtsBridge } from '../tts/MemoryTtsBridge'
import { userContextClassifier } from '../tts/UserContextClassifier'
import { implicitFeedbackTracker } from '../tts/ImplicitFeedbackTracker'
import { userSpeechProfileTracker } from '../tts/UserSpeechProfileTracker'
import type {
  BehaviorEmotionResult,
  BehaviorMetrics,
  InteractionContext,
  ContextClassificationResult,
  ContextOverrideMode,
  PreferenceRecommendation,
  VoiceEmotionLabel,
} from '../tts/types'
import { VOICE_EMOTION_TTS_MAP } from '../tts/types'
import type { VoiceEmotion } from '../asr/types'
import type { McpAgentHybridPipeline } from '../hybrid/McpAgentHybridPipeline'
import { narrativeEmotionController, type StyledTtsSegment } from '../tts/emotion'
import { TaskStepRecorder } from '../memory/TaskStepRecorder'
import { SessionMemory, sessionMemory as defaultSessionMemory } from '../memory/SessionMemory'
import { MemoryContextProvider, type InjectionContext } from '../memory/MemoryContextProvider'
import { PlanMemoryRecall, planMemoryRecall as defaultPlanMemoryRecall } from '../memory/PlanMemoryRecall'

export class ChatExecutor {
  private llmService: LlmService
  private ttsService: TtsService
  private mainWindow: BrowserWindow | null
  private workingMemory: WorkingMemory
  private toolScheduler: ToolScheduler
  private guardrail: Guardrail
  private progressGuardrail: ProgressGuardrail
  private planManager: PlanManagerLike
  private resourceBudget: ResourceBudget
  private memoryService: MemoryService | null
  private skillManager: SkillManager | null
  private recoveryManager: SessionRecoveryManager | null
  private tokenAccount: TokenAccount | null
  private subAgentPool: SubAgentPoolAdapter
  private runtimeManager: import('../runtime/RuntimeManagerImpl').RuntimeManagerImpl | null
  private reflectLoop: ReflectLoop
  private goalGuardrail: GoalGuardrail
  private sessionPlanIds: Set<string> = new Set()
  private errorClassifier: { classify: (error: string) => any }
  private consecutiveRetryableErrors = 0
  private consecutiveInvalidRequest = 0
  private lastCheckpointStep = -1
  private lastCheckpointTime = 0
  private identityContext = ''
  private runContext: RunContext | null = null
  private proceduralMemory: ProceduralMemory | null = null
  private failureAnalyzer: FailureAnalyzer | null = null
  /** 统一知识源查询引擎（Memory + Agent 跨源查询） */
  private knowledgeQuery: UnifiedKnowledgeQuery | null = null
  private thinkStageCount = 0
  private obsLogger: ObservabilityLogger | null = null
  private lastUserText = ''
  /** 人格仲裁管理器 */
  private personaManager = new PersonaStateManager()
  /** 人格漂移控制系统 */
  private driftControl = new PersonaDriftControlSystem()
  /** 上轮 drift 评估产生的待注入消息信号 */
  private pendingDriftSignal: string | null = null
  /** 当前轮 user 消息的 content category */
  private currentCategory = 'chat'
  /** ── 叙事情感控制 ── */
  /** 待处理的叙事情感段落（由 applySentimentToTts 设置，run() 消费） */
  private pendingNarrativeSegments: StyledTtsSegment[] | null = null
  /** 叙述性检测：回复长度超过此阈值 + 非纯对话内容 → 启用叙述模式 */
  private readonly NARRATIVE_MIN_LENGTH = 80
  /** MCP-Agent 混合流水线（可选注入）*/
  private hybridPipeline: McpAgentHybridPipeline | null = null

  /** 当前加载的 session，用于切换 session 时重建上下文 */
  private currentSessionId: string | null = null

  /** 跨会话任务步骤记录器 — 自动记录每轮工具调用的输入/输出 */
  private taskStepRecorder: TaskStepRecorder | null = null

  /** ADR-013: Session Memory — 跨会话记忆检索与 compaction */
  private sessionMemory: SessionMemory

  /** ADR-013 Phase 3: Context Injection — SessionMemory → ChatExecutor bridge */
  private memoryContextProvider: MemoryContextProvider

  /** ADR-013 Phase 3: 缓存的 injection context（toolLoop refresh 时复用） */
  private currentInjectionCtx: InjectionContext | null = null

  /** 计划感知记忆恢复 — 按计划 ID 存储/检索对话上下文摘要 */
  private planMemoryRecall: PlanMemoryRecall

  // ── 行为自适应对话策略 ──
  /** 当前轮检测到的场景标签 */
  private currentScene: SceneLabel = 'unknown'
  /** 当前生效的回复模式 */
  private currentResponseMode: ResponseMode = 'warm_chat'
  /** 当前场景允许的工具集（undefined = 不限制） */
  private sceneAllowedTools: string[] | undefined = undefined
  /** ADR-008: 当前轮的工具策略决策（日志/观察用，P1 不改变行为） */
  private currentToolDecision: ToolDecision | null = null
  /** ADR-008: 工具策略规划器 */
  private toolPolicyPlanner = new ToolPolicyPlanner(
    () => userBehaviorAnalyzer.getRecentToolCallCount(),
  )
  /** ADR-008: 工具策略→Prompt 转换器 */
  private toolPromptAssembler = new ToolPromptAssembler()
  /** 当前轮用户消息的领域标签（供 InteractionDetail 使用） */
  private currentDomainLabel = ''
  /** 执行决策门 — 每轮 tool batch 后强制决策 */
  private executionGovernor = new ExecutionGovernor()
  /** Guardrail Pipeline — Trace 级别进展检测（可选注入） */
  private guardrailPipeline: GuardrailPipeline | null = null
  /** Evaluation Emitter — 用于写入 Guardrail Delivery Trace 事件 */
  private evaluationEmitter: EvaluationEmitter | null = null

  /** Agent 性能监控器 */
  private agentMonitor: AgentMonitor = agentMonitor

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
    subAgentPool: SubAgentPoolAdapter,
    runtimeManager: import('../runtime/RuntimeManagerImpl').RuntimeManagerImpl | null,
    reflectLoop: ReflectLoop,
  ) {
    this.llmService = llmService
    this.ttsService = ttsService
    this.mainWindow = mainWindow
    this.workingMemory = new WorkingMemory('chat')
    this.toolScheduler = toolScheduler
    this.guardrail = guardrail
    this.progressGuardrail = new ProgressGuardrail()
    this.planManager = planManager
    this.resourceBudget = resourceBudget
    this.memoryService = memoryService
    this.skillManager = skillManager
    this.recoveryManager = recoveryManager
    this.tokenAccount = tokenAccount
    this.subAgentPool = subAgentPool
    this.runtimeManager = runtimeManager
    this.reflectLoop = reflectLoop
    this.goalGuardrail = goalGuardrail
    this.errorClassifier = { classify: classifyError }
    this.sessionMemory = defaultSessionMemory
    this.memoryContextProvider = new MemoryContextProvider(defaultSessionMemory)
    this.planMemoryRecall = defaultPlanMemoryRecall
  }

  /** 注入 GuardrailPipeline（启动时由 AppRuntime 调用） */
  setGuardrailPipeline(pipeline: GuardrailPipeline): void {
    this.guardrailPipeline = pipeline
  }

  /** 注入 EvaluationEmitter（启动时由 AppRuntime 调用，用于写入 Delivery Trace 和 Session Memory Event） */
  setEvaluationEmitter(emitter: EvaluationEmitter): void {
    this.evaluationEmitter = emitter
    this.sessionMemory.setEvaluationEmitter(emitter)
    this.memoryContextProvider.setEvaluationEmitter(emitter)
  }

  /** 注入 MCP-Agent 混合流水线 */
  setHybridPipeline(pipeline: McpAgentHybridPipeline): void {
    this.hybridPipeline = pipeline
    log('INFO', 'chat_executor_hybrid_pipeline_set', {
      enabled: pipeline.isEnabled(),
      points: pipeline.getConfig().points,
    })
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
    knowledgeQuery?: UnifiedKnowledgeQuery | null
  }): void {
    if (deps.memoryService !== undefined) {
      this.memoryService = deps.memoryService
      // 偏好存储依赖 memoryService，首次注入时初始化
      behaviorPreferenceStore.setMemoryService(deps.memoryService)
      // 跨会话任务步骤记录器 — 依赖 MemoryService
      if (deps.memoryService && !this.taskStepRecorder) {
        this.taskStepRecorder = new TaskStepRecorder(deps.memoryService)
      }
    }
    if (deps.skillManager !== undefined) this.skillManager = deps.skillManager
    if (deps.recoveryManager !== undefined) this.recoveryManager = deps.recoveryManager
    if (deps.tokenAccount !== undefined) this.tokenAccount = deps.tokenAccount
    if (deps.mainWindow !== undefined) this.mainWindow = deps.mainWindow
    if (deps.identityContext !== undefined) this.identityContext = deps.identityContext
    if (deps.proceduralMemory !== undefined) this.proceduralMemory = deps.proceduralMemory
    if (deps.failureAnalyzer !== undefined) this.failureAnalyzer = deps.failureAnalyzer
    if (deps.knowledgeQuery !== undefined) this.knowledgeQuery = deps.knowledgeQuery
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

  /**
   * 从用户文本中提取领域标签（用于 InteractionDetail.domainLabel）。
   * 复用 UserBehaviorAnalyzer 的 TOPIC_PATTERNS 逻辑做轻量匹配。
   */
  private _extractDomainLabel(text: string): string {
    if (!text || text.length < 2) return 'chat'
    // 简单规则：看是否包含代码/技术相关关键词
    const codePatterns = [/代码|编程|实现|函数|class|interface|type|import|export|const|let|var|function/]
    for (const p of codePatterns) {
      if (p.test(text)) return 'code'
    }
    const writingPatterns = [/写.*故事|写.*小说|创作|章节|角色|剧情|描写/]
    for (const p of writingPatterns) {
      if (p.test(text)) return 'writing'
    }
    const evolutionPatterns = [/进化|自我.*改进|自我.*优化|evolve|evolution/]
    for (const p of evolutionPatterns) {
      if (p.test(text)) return 'evolution'
    }
    // 短消息通常为聊天/问答
    if (text.length < 30) return 'qa'
    return 'chat'
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

  private refreshMemory(sessionMemCtx?: InjectionContext): void {
    if (!this.memoryService) return

    // TODO(v3): 切换为 this.knowledgeQuery.getCombinedContext() 统一获取，
    // 当前保持传统同步路径（getFormattedContext 均为同步调用）
    let memCtx: string
    try {
      memCtx = this.memoryService.getFormattedContext()
    } catch (err) {
      log('WARN', 'memory_get_formatted_context_failed', { error: String(err) })
      return
    }
    // ADR-013 Phase 3: merge session memory context into 【长期记忆】 section
    if (sessionMemCtx?.text) {
      memCtx = memCtx
        ? `${memCtx}\n\n${sessionMemCtx.text}`
        : sessionMemCtx.text
    }
    this.obsLogger?.logMemory(this.lastUserText, memCtx)
    const reflectCtx = this.reflectLoop.getFormattedContext()

    // 按需注入：根据用户输入匹配外部技能
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
    // 任务状态恢复 & 用户画像注入（持久任务状态与画像Agent）
    const taskCtx = this.memoryService.getTaskStateContext()
    if (taskCtx) extraModules.push(taskCtx)
    const profileCtx = this.memoryService.getUserProfileContext()
    if (profileCtx) extraModules.push(profileCtx)
    // 行为预判：检测高频工具和话题模式，注入工具优先级提示
    const behaviorPattern = userBehaviorAnalyzer.analyze()
    if (behaviorPattern.hasSufficientData && behaviorPattern.suggestedToolHints.length > 0) {
      extraModules.push(...behaviorPattern.suggestedToolHints)
    }
    // 行为自适应对话策略：注入场景感知 Prompt
    if (this.currentScene !== 'unknown' || behaviorPattern.hasSufficientData) {
      const scenePrompt = userBehaviorAnalyzer.getScenePrompt()
      if (scenePrompt) {
        extraModules.push(scenePrompt)
      }
    }
    // ADR-008: 注入独立工具策略 Prompt（P3 新增行为）
    if (this.currentToolDecision) {
      const toolPrompt = this.toolPromptAssembler.assemble(this.currentToolDecision)
      if (toolPrompt) {
        extraModules.push(toolPrompt)
      }
    }
    // 行为强化记忆巩固：检测重复提问模式，自动强化相关记忆条目
    if (this.lastUserText) {
      const repeatPattern = userBehaviorAnalyzer.detectRepeatedPattern(this.lastUserText)
      if (repeatPattern.detected && repeatPattern.mergedTopics.length > 0) {
        this.memoryService.reinforceByBehaviorPattern(repeatPattern.mergedTopics, repeatPattern.currentText)
      }
    }
    // 行为偏好上下文注入：基于用户习惯偏好调整回复
    const prefContext = behaviorPreferenceStore.getFormattedContext()
    if (prefContext) extraModules.push(prefContext)
    // 工具默认参数推荐：基于学习到的用户偏好注入工具参数默认值
    const toolDefaultContext = toolDefaultAdjuster.adjust().formattedPrompt
    if (toolDefaultContext) extraModules.push(toolDefaultContext)
    // 计划感知记忆恢复：活跃计划的历史对话摘要注入
    if (this.sessionPlanIds.size > 0) {
      try {
        const planIds = Array.from(this.sessionPlanIds)
        const planCtx = this.planMemoryRecall.getFormattedContext(planIds)
        if (planCtx) extraModules.push(planCtx)
      } catch (err) {
        log('WARN', 'plan_memory_recall_context_failed', { error: String(err) })
      }
    }
    const allExtraModules = extraModules.length > 0 ? extraModules : undefined
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

  /** 检测显式重置指令（返回 true 则请求方在外部新建 session） */
  static isExplicitReset(text: string): boolean {
    return /^(重置|reset|新会话|new session)/i.test(text.trim())
  }

  private persistAssistantMessage(reply: string, source: string): void {
    const msg: StoredMessage = {
      id: createMessageId(),
      source: source as any,
      role: 'assistant',
      content: reply,
      category: this.currentCategory,
      createdAt: Date.now(),
    }
    insertMessage(msg)
    this.mainWindow?.webContents.send('message:new', msg)
  }

  private noTts = false
  /** 情感自适应语音是否启用（用户可通过 IPC 开关） */
  private emotionTtsEnabled = true
  /** 上次应用的 TTS 情感参数（避免重复设置相同参数） */
  private lastEmotionParams: EmotionTtsParams | null = null
  /** 用户语气记忆个性化语音是否启用 */
  private toneProfileEnabled = true
  /** 缓存的用户语气基线参数（避免每次重新计算） */
  private lastToneBaseline: EmotionTtsParams | null = null
  /** 当前用户语气画像 */
  private currentToneProfile: UserToneProfile | null = null
  /** 已初始化标记 */
  private toneProfileInitialized = false
  /** 行为情绪检测是否启用（用户可通过 IPC 开关） */
  private behaviorEmotionEnabled = true
  /** 上次检测的行为情绪结果（用于混合） */
  private lastBehaviorEmotion: BehaviorEmotionResult | null = null
  /** 交互情境自适应语音是否启用（用户可通过系统托盘切换自动/手动模式） */
  private contextualTtsEnabled = true
  /** 上次交互情境推荐结果 */
  private lastContextualContext: InteractionContext | null = null
  /** 用户情境自适应语音是否启用 */
  private userContextClassifierEnabled = true
  /** 上次用户情境分类结果（用于混合 + UI 展示） */
  private lastUserContext: ContextClassificationResult | null = null
  /** 隐式反馈驱动的语音自适应是否启用 */
  private implicitFeedbackEnabled = true
  /** 上次隐式反馈推荐结果 */
  private lastImplicitFeedback: PreferenceRecommendation | null = null

  // ══════════════════════════════════════════
  //  UserBehavior → TTS 消费者合同
  // ══════════════════════════════════════════

  /** 缓存用户行为状态（从 EventBus 订阅，用于 buildTtsNeed） */
  private cachedBehaviorState: {
    activityState: string
    fullscreen: boolean
    focused: boolean
    idleTimeMs: number
  } | null = null
  /** 行为状态订阅是否已初始化 */
  private behaviorStateSubscribed = false

  // ══════════════════════════════════════════
  //  语音情感（从 ASR 声学特征推断）
  // ══════════════════════════════════════════

  /** 语音情感自适应是否启用 */
  private voiceEmotionEnabled = true
  /** 最新的用户语音情感分析结果（由 ASR 识别后通过 IPC 更新） */
  private userVoiceEmotion: VoiceEmotion | null = null

  /** 用户输入文本情感分析结果（由 UserInputEmotionAnalyzer 驱动） */
  private currentUserInputEmotion: UserInputEmotionResult | null = null

  // ══════════════════════════════════════════
  //  记忆情感上下文（从 Memory 对话历史情感分析驱动）
  // ══════════════════════════════════════════

  /** 记忆情感自适应语音是否启用 */
  private memoryEmotionEnabled = true
  /** 缓存的记忆情感上下文（供 IPC 展示） */
  private lastMemoryEmotionContext: import('../tts/MemoryEmotionBridge').AggregatedEmotionContext | null = null

  async run(
    text: string,
    requestId?: string,
    source: 'electron' | 'telegram' = 'electron',
    extra?: { telegramChatId?: number; telegramUserId?: number; telegramFrom?: string; telegramMessageId?: number },
    sessionId?: string,
    noTts?: boolean,
  ): Promise<ChatResult> {
    this.noTts = noTts ?? false
    // 纠正模式学习器懒启动（安全幂等）
    correctionPatternLearner.start()
    // 行为情绪检测器懒启动（首次 run 时绑定窗口事件并开始采样）
    if (this.behaviorEmotionEnabled && !behaviorEmotionDetector.isEnabled()) {
      behaviorEmotionDetector.setEnabled(true)
      if (this.mainWindow) {
        behaviorEmotionDetector.updateWindow(this.mainWindow)
      }
      behaviorEmotionDetector.start(this.mainWindow ?? undefined)
    }
    // 用户情境分类器懒启动（首次 run 时开始轮询活跃窗口）
    if (this.userContextClassifierEnabled) {
      userContextClassifier.start()
    }
    // 行为状态订阅懒初始化（首次 run 时绑定 EventBus）
    this.ensureBehaviorStateSubscription()
    const rid = requestId || createRequestId()
    const t0 = Date.now()
    this.memoryService?.recordInteraction(text)
    this.memoryService?.setLastUserText(text)
    this.lastUserText = text
    // 行为分析：记录用户消息用于模式检测
    userBehaviorAnalyzer.recordUserMessage(text)
    // 行为偏好学习：检测用户消息中的风格/参数纠正模式
    correctionPatternLearner.recordUserMessage(text)
    // 行为驱动的动态编排：检测用户消息中的求助/困惑信号
    taskOrchestrationModeManager.recordUserMessage(text)
    // 行为自适应对话策略：记录交互详情并分析场景
    this.currentDomainLabel = this._extractDomainLabel(text)
    userBehaviorAnalyzer.recordInteractionDetail({
      type: 'user_message',
      length: text.length,
      domainLabel: this.currentDomainLabel,
      timestamp: Date.now(),
      text,
    })
    const sceneResult = userBehaviorAnalyzer.analyzeScene()
    this.currentScene = sceneResult.scene
    this.currentResponseMode = sceneResult.responseMode
    // ADR-008: 工具策略决策
    this.currentToolDecision = this.toolPolicyPlanner.decide(this.currentScene, text)
    // ADR-008: 统一过滤路径 — toToolFilter 替代 getSceneToolFilter
    this.sceneAllowedTools = this.toolPolicyPlanner.toToolFilter(this.currentToolDecision)
    log('INFO', 'behavior_adaptive_scene', {
      scene: sceneResult.scene,
      mode: sceneResult.responseMode,
      confidence: sceneResult.confidence,
      topics: sceneResult.dominantTopics,
      avgLen: sceneResult.avgUserMessageLength,
      toolPreference: this.currentToolDecision.preference,
      toolReason: this.currentToolDecision.reason,
      toolFilter: this.sceneAllowedTools === undefined ? 'all' : this.sceneAllowedTools.length === 0 ? 'none' : 'restricted',
    })
    // ── [隐式反馈] 用户发送新消息 → 标记"继续对话"（接受当前 TTS 质量）──
    if (this.implicitFeedbackEnabled) {
      implicitFeedbackTracker.onUserContinuedConversation()
      // 检测用户是否在修改/重述之前的请求
      const repeatPattern = userBehaviorAnalyzer.detectRepeatedPattern(text)
      if (repeatPattern.detected && repeatPattern.similarity > 0.6) {
        implicitFeedbackTracker.onUserModifiedRequest()
      }
    }
    // ASR热词增强：喂入用户文本用于提取高频词汇
    asrHotwordManager.feedUserText(text)
    // 行为情绪：记录用户交互用于 APM 计算
    if (this.behaviorEmotionEnabled) {
      behaviorEmotionDetector.recordInteraction()
    }
    // 用户输入文本情感分析：从用户输入文本推断情绪（愤怒/悲伤/喜悦）
    if (text.trim().length > 0 && this.emotionTtsEnabled) {
      this.currentUserInputEmotion = userInputEmotionAnalyzer.analyze(text)
    }
    // 交互情境：记录交互时间戳用于节奏检测
    if (this.contextualTtsEnabled) {
      contextualTtsAdvisor.recordInteraction()
    }
    // 用户情境：记录交互时间用于 idle 检测
    if (this.userContextClassifierEnabled) {
      userContextClassifier.recordInteraction()
    }
    // 语气记忆：懒初始化 + 增量更新用户语气画像
    this.ensureToneProfileInit()
    if (this.toneProfileEnabled) {
      try {
        const profile = toneProfileAnalyzer.updateProfile(text)
        this.currentToneProfile = profile
        // 缓存到磁盘（debounced）
        toneProfileCache.save(profile)
        // 语气变化时更新基线参数
        const newBaseline = toneToVoiceMapper.getBaselineParams(profile)
        if (!this.lastToneBaseline || toneToVoiceMapper.isDifferent(this.lastToneBaseline, newBaseline)) {
          this.lastToneBaseline = newBaseline
          log('INFO', 'tone_baseline_updated', {
            tone: profile.primaryTone,
            confidence: profile.confidence.toFixed(2),
            voice: newBaseline.voice,
          })
        }
      } catch (err) {
        // 语气分析失败不应影响对话
        log('WARN', 'tone_profile_update_error', { error: String(err) })
      }
    }
    // ── 记忆情感：分析用户消息情感并写入 Memory ──
    if (this.memoryEmotionEnabled && this.memoryService) {
      try {
        memoryEmotionBridge.recordUserMessageEmotion(text, this.memoryService)
      } catch (err) {
        log('WARN', 'memory_emotion_record_error', { error: String(err) })
      }
    }
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
    // 统一 resolve sessionId（只调一次），后续分支和 DB 存储共用
    const effectiveSessionId = sessionId || this.resolveSessionId()
    // session 切换时加载对应历史到 workingMemory
    if (effectiveSessionId !== this.currentSessionId) {
      this.currentSessionId = effectiveSessionId
      this.workingMemory = new WorkingMemory('chat')
      try { this.refreshMemory() } catch (err) { log('WARN', 'refresh_memory_skipped', { error: String(err) }) }
      const history = getMessagesBySession(effectiveSessionId)
      for (const m of history) {
        if (m.role === 'user') {
          this.workingMemory.context.addUser(m.content)
        } else if (m.role === 'assistant') {
          this.workingMemory.context.addAssistant(m.content)
        }
      }
    }
    // ADR-013 Phase 3: context injection — retrieve AND inject session memory
    const attentionEntities = this.workingMemory.attention.getActive()
    this.sessionMemory.setAttention(attentionEntities)
    const injectionCtx = this.memoryContextProvider.buildInjectionContext({
      userText: text,
      sessionId: effectiveSessionId,
      activeTopics: [],
      attentionEntities,
    }, rid)
    this.currentInjectionCtx = injectionCtx
    if (injectionCtx.text) {
      log('INFO', 'session_memory_context_injected', {
        sessionId: effectiveSessionId,
        sources: injectionCtx.sourceSessions,
        tokens: injectionCtx.tokenEstimate,
        fallback: injectionCtx.fallbackMode,
      })
    }
    // 先刷新 memory（可能重建 context），再加用户消息，确保消息不丢失
    try { this.refreshMemory(injectionCtx) } catch (err) { log('WARN', 'refresh_memory_skipped', { error: String(err) }) }
    this.workingMemory.addUser(text)
    eventBus.emit('agent.input.received', { text, requestId: rid, source })
    const contentCategory = classifyContent(text)
    this.currentCategory = contentCategory
    const userMsg: StoredMessage = {
      id: createMessageId(),
      source,
      role: 'user',
      content: text,
      category: contentCategory,
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
      let reply = await this.toolLoop(messages, ctx, rid, source)
      // 统一过滤：去除工具调用 XML 序列化残留（如 <invoke name="centos_exec"> 等）
      if (reply) {
        const cleaned = reply.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, '').trim()
        reply = cleaned || '嗯，我在呢。'
      }
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
      // ── [EMOTION] 最终回复情感分析 ──
      this.applySentimentToTts(reply)
      if (!this.noTts) {
        // 如果是叙事情感模式且有段落分割，使用 speakNarrative
        if (this.pendingNarrativeSegments && this.pendingNarrativeSegments.length > 1) {
          const segments = this.pendingNarrativeSegments
          this.pendingNarrativeSegments = null
          // 清除流式缓冲区中的剩余内容（叙事模式下不重复播放缓冲内容）
          this.ttsService.stop()
          // 异步启动叙事播报（不等待完成）
          this.ttsService.speakNarrative(segments, true).catch((err) => {
            log('WARN', 'narrative_speak_error', { error: String(err) })
          })
        } else {
          this.pendingNarrativeSegments = null
          this.ttsService.flushBuffer()
        }
      }
      // ── [Memory × TTS 深度融合] 检测记忆状态变化 ← TTS 适应 ──
      // 在每轮交互完成后检测记忆是否发生了值得通知 TTS 的显著变化
      const memoryChange = memoryTtsBridge.detectMemoryChangeForTts()
      if (memoryChange) {
        log('INFO', 'memory_tts_change_detected', { change: memoryChange })
      }
      if (reply) {
        const assistMsg: StoredMessage = {
          id: createMessageId(),
          source,
          role: 'assistant',
          content: reply,
          category: 'chat',
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
      // 行为自适应：记录助手回复的交互详情
      if (reply) {
        userBehaviorAnalyzer.recordInteractionDetail({
          type: 'user_message', // 作为「完整交互轮次」记录，type 记为 user_message 供场景分析用
          length: reply.length,
          domainLabel: this.currentDomainLabel,
          timestamp: Date.now(),
          text: reply.slice(0, 200),
        })
      }
      // P0→P1 沉淀（MetaController.onInteractionEnd）
      if (reply && this.memoryService) {
        this.memoryService.metaController.onInteractionEnd({
          userMessage: text,
          assistantReply: reply,
          tokenUsed: this.resourceBudget.getSnapshot().chatLlmCalls || 0,
          tokenBudget: this.resourceBudget.getConfig().maxChatLlmCalls || 200000,
          planActive: this.sessionPlanIds.size > 0,
          agentId: 'chat',
        })
        // 记忆驱动的 Agent 主动服务：更新记忆快照（非阻塞）
        this.memoryService.snapshotManager.onInteractionEnd()
      }
      // ── 计划感知记忆恢复：活跃计划对话摘要存储 ──
      if (reply && this.memoryService && this.sessionPlanIds.size > 0) {
        try {
          const planIds = Array.from(this.sessionPlanIds)
          const planTitles = new Map<string, string>()
          for (const pid of planIds) {
            const plan = this.planManager.getPlan(pid)
            planTitles.set(pid, plan?.title || pid)
          }
          this.planMemoryRecall.storeForPlans(planIds, planTitles, text, reply)
        } catch (err) {
          log('WARN', 'plan_memory_recall_store_failed', { error: String(err) })
        }
      }
      // 行为偏好持久化：交互结束后刷新偏好存储
      if (this.memoryService) {
        behaviorPreferenceStore.flush()
      }
      // ── AgentMonitor: 记录本轮成功交互指标 ──
      if (this.agentMonitor && reply) {
        let sentimentScore = 0.5
        try {
          const sentiment = sentimentAnalyzer.analyze(reply)
          sentimentScore = sentiment.score || 0.5
        } catch { /* 情感分析失败不影响主流程 */ }
        this.agentMonitor.recordRound({
          timestamp: Date.now(),
          success: true,
          sentimentScore,
          durationMs: Date.now() - t0,
          toolCallCount: 0,
          llmCallCount: (this.resourceBudget?.getSnapshot?.()?.chatLlmCalls as number) ?? 0,
          wasInterrupted: ctx?.interruptFlag ?? false,
          source,
        })
      }
      // ADR-013 Phase 1: reply 后检查 compaction 条件（仅日志，不注入 context）
      try { this.sessionMemory.checkCompaction(effectiveSessionId, source) } catch { /* noop */ }
      return { reply }
    } catch (err) {
      eventBus.emit('agent.error', { error: String(err), requestId: rid })
      log('ERROR', 'chat_handler_error', { request_id: rid, error: String(err) })
      // ── AgentMonitor: 记录本轮失败交互指标 ──
      if (this.agentMonitor) {
        this.agentMonitor.recordRound({
          timestamp: Date.now(),
          success: false,
          sentimentScore: 0.3,
          durationMs: Date.now() - t0,
          toolCallCount: 0,
          llmCallCount: (this.resourceBudget?.getSnapshot?.()?.chatLlmCalls as number) ?? 0,
          wasInterrupted: false,
          source,
        })
      }
      return { error: 'INTERNAL' }
    } finally {
      this.runContext = null
    }
  }

  // ── M4.2 Action Delivery Trace ──

  /** 写入 guardrail.action_delivered — Policy 决策已被 Runtime 成功执行 */
  private emitActionDelivered(
    decisionId: string,
    traceId: string,
    actionType: 'TERMINATE' | 'WARNING' | 'CONTINUE',
    policyVersion: string,
  ): void {
    if (!this.evaluationEmitter) return
    this.evaluationEmitter.emit(
      'guardrail.action_delivered' as any,
      {
        type: 'guardrail.action_delivered',
        decisionId,
        traceId,
        actionType,
        policyVersion,
        timestamp: Date.now(),
      },
      { traceId },
    )
  }

  /** 写入 guardrail.action_delivery_failed — Policy 决策未能被 Runtime 执行 */
  private emitActionDeliveryFailed(
    decisionId: string,
    traceId: string,
    intendedAction: 'TERMINATE' | 'WARNING' | 'CONTINUE',
    policyVersion: string,
    errorCode: string,
  ): void {
    if (!this.evaluationEmitter) return
    this.evaluationEmitter.emit(
      'guardrail.action_delivery_failed' as any,
      {
        type: 'guardrail.action_delivery_failed',
        decisionId,
        traceId,
        intendedAction,
        policyVersion,
        timestamp: Date.now(),
        errorCode,
      },
      { traceId },
    )
  }

  stop(): void {
    this.runContext?.interrupt('user_stop')
    this.runContext = null
    this.ttsService.stop()
    // ── [隐式反馈] 用户停止对话 → 记录 SKIP ──
    if (this.implicitFeedbackEnabled) {
      implicitFeedbackTracker.recordSimpleAction('SKIP')
    }
    this.executionGovernor.reset()
    this.progressGuardrail.reset()
    taskOrchestrationModeManager.reset()
    // 停止行为情绪检测器的鼠标采样（释放定时器）
    behaviorEmotionDetector.stop()
    // 停止用户情境分类器轮询
    userContextClassifier.stop()
  }

  /** 设置 Agent 性能监控器（允许外部注入自定义实例） */
  setAgentMonitor(monitor: AgentMonitor): void {
    this.agentMonitor = monitor
  }

  private async toolLoop(messages: Message[], ctx: RunContext, requestId: string, source: string): Promise<string> {
    ctx.transition(RunState.RUNNING)
    this.guardrailPipeline?.reset()
    const MAX_TURNS = 300
    /** 本轮调用了哪些工具，空 reply 时用于生成摘要 */
    const executedToolNames = new Set<string>()
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
          taskOrchestrationModeManager.recordCancellation('user_interrupt')
          this.obsLogger?.logExit('interrupted')
          return ''
        }
        if (i > 0 && i % 5 === 0 && this.memoryService) {
          this.refreshMemory(this.currentInjectionCtx ?? undefined)
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
        // 行为自适应：根据场景限制可用工具集
        // 每 5 轮重新评估场景（刷新 memory 时同步更新）
        if (i > 0 && i % 5 === 0) {
          const reScene = userBehaviorAnalyzer.analyzeScene()
          this.currentScene = reScene.scene
          this.currentResponseMode = reScene.responseMode
          this.currentToolDecision = this.toolPolicyPlanner.decide(this.currentScene, this.lastUserText)
          this.sceneAllowedTools = this.toolPolicyPlanner.toToolFilter(this.currentToolDecision)
        }
        // ── [ORCHESTRATION] 行为驱动的动态编排模式检查 ──
        taskOrchestrationModeManager.startNewRound()
        const modeRecs = taskOrchestrationModeManager.getModeRecommendations()

        // 简化/引导模式：进一步限制工具链长度
        if (modeRecs.reduceToolChain && this.sceneAllowedTools && this.sceneAllowedTools.length > 3) {
          // 在场景允许工具之上再缩减，只保留前 3 个最相关的工具
          this.sceneAllowedTools = this.sceneAllowedTools.slice(0, 3)
        }

        // 注入模式相关的 system prompt 片段（通过 scratchpad）
        if (modeRecs.extraPromptModules.length > 0) {
          for (const module of modeRecs.extraPromptModules) {
            this.workingMemory.scratchpad.add('system_hint', module)
          }
          this.workingMemory.injectScratchpad(messages)
        }

        // 引导模式：连续求助 → 插入探测性问题确认用户意图
        if (modeRecs.insertProbingQuestion) {
          log('INFO', 'orchestration_probing_question_injected', {
            mode: taskOrchestrationModeManager.getCurrentMode(),
            signalStats: taskOrchestrationModeManager.getSignalStats(),
            step: i,
          })
          messages.push({
            role: 'user',
            content: modeRecs.probingQuestionText,
          })
          // 插入探测性问题后跳过本轮 LLM 调用，让用户先回应
          continue
        }

        const result = await this.llmService.chatWithTools(
          messages,
          requestId,
          120000,
          onToken,
          undefined, // externalSignal
          this.sceneAllowedTools, // allowedToolNames — 场景工具过滤
        )
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
          // ── [MCP-AGENT HYBRID] 工具选择验证 ──
          if (this.hybridPipeline?.isPointEnabled('tool_selection')) {
            const contextText = this.buildHybridContextText(messages)
            const arbResult = await this.hybridPipeline.validateToolSelection(result.toolCalls, contextText, requestId)
            if (arbResult && arbResult.arbitratedOutput.assessment !== 'approved') {
              const rejected = arbResult.arbitratedOutput.rejectedTools
              const suggested = arbResult.arbitratedOutput.suggestedAdditionalTools
              const parts: string[] = []
              if (rejected.length > 0) {
                parts.push(`【MCP 验证】以下工具被建议拦截: ${rejected.join(', ')}`)
              }
              if (suggested.length > 0) {
                parts.push(`【MCP 建议】以下工具被建议补充: ${suggested.join(', ')}`)
              }
              parts.push(`仲裁依据: ${arbResult.arbitratedOutput.rationale}`)
              messages.push({ role: 'user', content: parts.join('\n') })
              log('INFO', 'hybrid_tool_selection_intervention', {
                request_id: requestId,
                step: i,
                rejected: rejected.length,
                suggested: suggested.length,
                method: arbResult.arbitrationMethod,
              })
              // MCP 拒绝了所有工具 → 直接跳过执行轮，让 LLM 重新考虑
              if (arbResult.arbitratedOutput.assessment === 'rejected') {
                continue
              }
            }
          }
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
          result.toolCalls.forEach((tc) => eventBus.emit('agent.tool.invoked', { tool: tc.name, args: tc.arguments, requestId }))
          const toolResults = await this.toolScheduler.executeAll(result.toolCalls, ctx.abortController.signal)
          this.obsLogger?.logToolBatch(toolResults)
          // 信用恢复：每个成功的工具调用降低一次拒绝计数
          for (const tr of toolResults) {
            if (tr.success) {
              executedToolNames.add(tr.name)
              this.goalGuardrail.onToolSuccess()
              // 流程记忆：记录成功调用的工具名
              this.proceduralMemory?.recordHit(tr.name)
              // 行为分析：记录工具调用模式
              userBehaviorAnalyzer.recordToolCall(tr.name)
              // 行为自适应：记录工具调用交互详情
              userBehaviorAnalyzer.recordInteractionDetail({
                type: 'tool_call',
                length: tr.content.length,
                domainLabel: this.currentDomainLabel,
                timestamp: Date.now(),
              })
              // 行为情绪：记录工具调用用于 APM 计算
              if (this.behaviorEmotionEnabled) {
                behaviorEmotionDetector.recordAction()
              }
            }
          }
          for (const tr of toolResults) {
            this.emitToolStatus(tr.success ? 'success' : 'error', tr.name, tr.success ? '完成' : `失败: ${tr.error}`)
            if (tr.success) eventBus.emit('agent.tool.completed', { tool: tr.name, result: tr.content, requestId })
            else eventBus.emit('agent.tool.failed', { tool: tr.name, error: tr.error || '', requestId })
            let c = tr.content || tr.error || ''
            if (c.length > 8000) c = c.slice(0, 8000) + `\n... [已截断，原长 ${c.length} 字符]`
            messages.push({ role: 'tool', tool_call_id: tr.id, content: c })
          }
          // ── [ORCHESTRATION] 行为驱动的动态编排：反馈本轮工具执行结果 ──
          taskOrchestrationModeManager.recordToolBatchResult(
            toolResults.map((tr) => ({ name: tr.name, success: tr.success, error: tr.error })),
          )
          // 如果本轮全部成功且处于 Simplified/Guided 模式，模式管理器会自动考虑降级
          // ── [TASK STEP RECORDER] 记录本轮工具调用步骤 ──
          if (this.taskStepRecorder && this.currentSessionId) {
            try {
              this.taskStepRecorder.recordToolCallRound({
                toolCalls: result.toolCalls,
                toolResults,
                sessionId: this.currentSessionId,
                stepIndex: i,
                roundReply: result.reply,
              })
            } catch (err) {
              log('WARN', 'task_step_record_failed', { error: String(err), step: i })
            }
          }
          // ── [MCP-AGENT HYBRID] 工具结果验证 ──
          if (this.hybridPipeline?.isPointEnabled('result_validation')) {
            const contextText = this.buildHybridContextText(messages)
            const arbResult = await this.hybridPipeline.validateResults(toolResults, contextText, requestId)
            if (arbResult && arbResult.arbitratedOutput.verdict !== 'consistent') {
              const issues = arbResult.arbitratedOutput.issues
              const additionalCtx = arbResult.arbitratedOutput.additionalContext
              const parts: string[] = ['【MCP 结果验证】']
              if (issues.length > 0) {
                for (const issue of issues.slice(0, 3)) {
                  parts.push(`- [${issue.severity}] ${issue.toolName}: ${issue.description}`)
                }
              }
              if (additionalCtx) {
                parts.push(additionalCtx)
              }
              messages.push({ role: 'user', content: parts.join('\n') })
              log('INFO', 'hybrid_result_validation_intervention', {
                request_id: requestId,
                step: i,
                issueCount: issues.length,
                verdict: arbResult.arbitratedOutput.verdict,
                method: arbResult.arbitrationMethod,
              })
              // 需要重新执行时，不继续 REFLECT 直接让 LLM 处理
              if (arbResult.arbitratedOutput.needsReExecution) {
                continue
              }
            }
          }
          // ── [EMOTION] 情感自适应：分析工具结果+LLM回复，调整TTS语调 ──
          this.applySentimentToTts(
            result.reply || '',
            toolResults.filter((t) => t.success).map((t) => t.content),
          )
          // ── [REFLECT] 同步执行反馈（同一轮可见） ──
          runReflect(toolResults, result.toolCalls, messages, ctx)
          this.workingMemory.trimToTokenBudget(600_000)
          if (!ctx.softReplyInjected && i >= 10) {
            ctx.softReplyInjected = true
            this.workingMemory.scratchpad.add('system_hint', '你已执行了多步操作。请立即停止工具调用，向用户汇报当前进展。')
          }
          const gr = this.guardrail.apply(toolResults, result.toolCalls, messages, ctx)
          // ── [PROGRESS] Progress Guardrail: 零输出停滞检测 ──
          const pgResult = this.progressGuardrail.check(result.reply, result.toolCalls, toolResults, messages, ctx)
          if (pgResult.triggered) {
            log('WARN', 'chat_progress_guardrail_triggered', { step: i, reason: pgResult.reason })
            // guardrailStop 已由 check() 设置，放行本轮后退出
          }
          // ── [DECIDE] ExecutionGovernor 强制决策门 ──
          const failedTools = toolResults.filter((r) => !r.success).map((r) => r.name)
          const hasFail = failedTools.length > 0
          const allFail = hasFail && failedTools.length === toolResults.length
          const roundResult: GovernorRecord['roundResult'] = allFail ? 'all_failed' : hasFail ? 'partial' : 'all_ok'
          const gd = this.executionGovernor.evaluate(toolResults, result.toolCalls, ctx)
          ctx.recordGovernor(gd, failedTools, roundResult)
          eventBus.emit('agent.governor' as any, {
            requestId,
            step: i,
            action: gd.action,
            reason: gd.reason,
            roundResult,
            failedTools,
          })
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
          this.checkMilestone(i, toolResults, ctx, requestId)
          // ── [GUARDRAIL KERNEL] Trace 级别进展检测，Runtime 只消费 RuntimeAction ──
          if (this.guardrailPipeline) {
            const result = await this.guardrailPipeline.check(requestId, i)
            if (result) {
              switch (result.runtimeAction) {
                case 'TERMINATE':
                  log('WARN', 'chat_guardrail_kernel_terminate', { step: i, reason: result.decision.reason, traceId: requestId })
                  eventBus.emit('guardrail.progress_stagnation', { consecutiveRounds: i, step: i })
                  this.emitActionDelivered(result.decisionId, requestId, 'TERMINATE', result.decision.policyVersion)
                  ctx.guardrailStop = true
                  break
                case 'WARNING':
                  log('WARN', 'chat_guardrail_kernel_warning', { step: i, reason: result.decision.reason, traceId: requestId })
                  this.emitActionDelivered(result.decisionId, requestId, 'WARNING', result.decision.policyVersion)
                  break
                case 'CONTINUE':
                  // 不干预
                  break
              }
            }
          }
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
        // [旁路] Runtime 旁路集成 — RUNTIME_ENABLED=1 时额外收集 Runtime Worker 结果
        if (this.runtimeManager && process.env.RUNTIME_ENABLED === '1') {
          const tasks = this.runtimeManager.listTasks()
          log('DEBUG', 'runtime_bypass_check', { taskCount: tasks.length })
          for (const task of tasks) {
            const completed = task.collectCompleted()
            for (const r of completed) {
              done.push({
                id: r.id,
                goal: r.goal,
                status: r.state === 'cancelled' ? ('interrupted' as any) : (r.state as any),
                summary: r.summary,
                error: r.error,
                startedAt: 0,
                completedAt: Date.now(),
              })
            }
          }
        }
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
        let finalReply = result.reply || ''
        if (!finalReply) {
          // LLM 本轮调了工具但没生成文字回复 → 生成自然语言摘要
          if (executedToolNames.size > 0) {
            const toolList = [...executedToolNames]
              .map((n) => {
                const map: Record<string, string> = {
                  centos_exec: '远程服务器',
                  centos_read_file: '远程文件',
                  centos_grep: '远程搜索',
                  read_file: '文件',
                  grep: '搜索',
                  list_files: '目录',
                  run_command: '命令',
                  write_file: '写入文件',
                  edit_file: '编辑文件',
                }
                return map[n] || n
              })
            finalReply = `正在${toolList.join('、')}，稍等~`
          }
          this.obsLogger?.logExit('empty_llm_reply', `step=${i} generated="${finalReply}"`)
        }
        // 效用跟踪：检测 Agent 回复中是否引用了记忆
        if (finalReply && this.memoryService) {
          this.memoryService.recordAgentReference(finalReply)
        }
        // ── [MCP-AGENT HYBRID] 回复质量验证 ──
        if (finalReply && this.hybridPipeline?.isPointEnabled('reply_quality')) {
          const contextText = this.buildHybridContextText(messages)
          const arbResult = await this.hybridPipeline.validateReplyQuality(finalReply, contextText, requestId)
          if (arbResult && arbResult.arbitratedOutput.needsRegeneration) {
            const suggestion = arbResult.arbitratedOutput.suggestion
            messages.push({
              role: 'user',
              content: `【MCP 质量验证】Agent 回复质量评估: ${arbResult.arbitratedOutput.verdict}\n${
                suggestion ? `建议: ${suggestion}` : '请重新生成更准确完整的回复。'
              }`,
            })
            // 从 COMPLETED 回到 READY（有效转换），下一轮 loop 自动转入 RUNNING
            ctx.transition(RunState.READY)
            log('INFO', 'hybrid_reply_quality_regeneration', {
              request_id: requestId,
              step: i,
              verdict: arbResult.arbitratedOutput.verdict,
              method: arbResult.arbitrationMethod,
            })
            continue
          }
        }
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
        rollbackToLastKnownGood(m, stm, lastUser?.content ?? undefined)
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
      rollbackToLastKnownGood(m, stm, lastUser?.content ?? undefined)
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

  /**
   * 构建混合流水线的上下文摘要文本。
   * 从 messages 中提取最近的 system/user/assistant 消息摘要，
   * 供 MCP 路径独立分析使用。
   */
  private buildHybridContextText(messages: Message[]): string {
    const parts: string[] = []
    // 最近的几条消息
    const recent = messages.slice(-6)
    for (const m of recent) {
      const role = m.role
      const content = (m.content || '').slice(0, 200).replace(/\n/g, ' ')
      if (m.tool_calls?.length) {
        const tools = m.tool_calls.map((tc: any) => tc.function?.name || tc.name).join(', ')
        parts.push(`[${role}] tools: ${tools}`)
      } else if (content) {
        parts.push(`[${role}] ${content}`)
      }
    }
    // 消息统计
    const totalMsgs = messages.length
    const userCount = messages.filter((m) => m.role === 'user').length
    const toolCount = messages.filter((m) => m.role === 'tool').length
    parts.push(`(总 ${totalMsgs} 条消息: ${userCount} user, ${toolCount} tool)`)
    return parts.join('\n')
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

  private checkMilestone(step: number, tr: ToolResult[], ctx: RunContext, rid: string): void {
    if (!this.recoveryManager) return
    const ap = this.planManager?.getActivePlan?.()
    const ms = evaluateMilestone({
      step,
      toolResultsLength: tr.length,
      runContext: ctx,
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

  /**
   * 情感自适应语音：分析回复文本并更新 TTS 情感参数
   *
   * 在 LLM 回复完成后、TTS 发音前调用。
   * 优先使用 VoiceStyleMap（基于回复类型语义），回退到 EmotionToneMap（基于文本情感）。
   *
   * 如果启用了语气记忆个性化语音（toneProfileEnabled），
   * 会将用户语气基线参数与内容风格参数进行混合。
   */
  private applySentimentToTts(llmReply: string, toolResultTexts?: string[]): void {
    if (!this.emotionTtsEnabled) return

    try {
      // 合并 LLM 回复和工具结果进行综合分析
      const parts: string[] = []
      if (llmReply) parts.push(llmReply)
      if (toolResultTexts && toolResultTexts.length > 0) {
        parts.push(...toolResultTexts.filter(Boolean))
      }
      const combined = parts.join(' ')

      if (!combined || combined.trim().length < 10) return

      // ── 第一层：VoiceStyleMap（基于回复类型语义）──
      const { style, params: styleParams, category } = voiceStyleMap.detectAndMap(combined)

      // ── 第二层：EmotionToneMap（基于文本情感，作为补充）──
      const sentiment = sentimentAnalyzer.analyze(combined)
      const emotionParams = emotionToneMap.getParams(sentiment)

      // ── 融合：优先 VoiceStyle voice，情感微调 rate/pitch ──
      let finalParams = styleParams
      if (sentiment.polarity === 'positive') {
        // 正面情感强化 style 的活力
        finalParams = {
          ...styleParams,
          rate: emotionParams.rate,
          pitch: emotionParams.pitch,
          label: `${styleParams.label}·${emotionParams.label}`,
        }
      } else if (sentiment.polarity === 'negative') {
        // 负面情感降低 style 的活力
        finalParams = {
          ...styleParams,
          rate: emotionParams.rate,
          pitch: emotionParams.pitch,
          label: `${styleParams.label}·${emotionParams.label}`,
        }
      }

      // ── 紧急度覆盖：高紧急内容使用紧凑节奏 ──
      if (sentiment.urgency >= 0.4) {
        finalParams = {
          voice: finalParams.voice,
          rate: emotionParams.rate,
          pitch: emotionParams.pitch,
          label: `${finalParams.label}·紧急`,
        }
        log('INFO', 'tts_urgency_applied', {
          urgency: sentiment.urgency.toFixed(2),
          contentType: sentiment.contentType,
          rate: emotionParams.rate,
          pitch: emotionParams.pitch,
          label: finalParams.label,
        })
      }

      // 如果启用了语气记忆，混合用户语气基线 + 内容风格
      if (this.toneProfileEnabled && this.lastToneBaseline) {
        finalParams = toneToVoiceMapper.blend(this.lastToneBaseline, finalParams)
      }

      // ── 语音情感混合（从 ASR 声学特征推断的用户情绪，约 20% 权重）──
      if (this.voiceEmotionEnabled && this.userVoiceEmotion && this.userVoiceEmotion.confidence > 0.3) {
        const voiceEmotionLabel = this.userVoiceEmotion.label as VoiceEmotionLabel
        const voiceEmotionParams = VOICE_EMOTION_TTS_MAP[voiceEmotionLabel]
        if (voiceEmotionParams && voiceEmotionLabel !== 'neutral') {
          const currentRate = parseInt(finalParams.rate.replace(/[^0-9-]/g, '')) || 0
          const emotionRate = parseInt(voiceEmotionParams.rate.replace(/[^0-9-]/g, '')) || 0
          const currentPitch = parseInt(finalParams.pitch.replace(/[^0-9-]/g, '')) || 0
          const emotionPitch = parseInt(voiceEmotionParams.pitch.replace(/[^0-9-]/g, '')) || 0

          const blendedRate = Math.round(currentRate * 0.8 + emotionRate * 0.2)
          const blendedPitch = Math.round(currentPitch * 0.8 + emotionPitch * 0.2)

          finalParams = {
            voice: finalParams.voice,
            rate: `${blendedRate >= 0 ? '+' : ''}${blendedRate}%`,
            pitch: `${blendedPitch >= 0 ? '+' : ''}${blendedPitch}Hz`,
            label: `${finalParams.label}·${voiceEmotionParams.label}`,
          }
        }
      }

      // ── 用户输入文本情感混合（从用户输入关键词推断的情绪，约 25% 权重）──
      if (this.currentUserInputEmotion && this.currentUserInputEmotion.confidence > 0.3 && this.currentUserInputEmotion.emotion !== 'neutral') {
        const inputEmotionParams = this.currentUserInputEmotion.consecutiveEmotion
          ? userInputEmotionAnalyzer.getStrengthenedParams(this.currentUserInputEmotion)
          : this.currentUserInputEmotion.ttsParams
        const currentRate = parseInt(finalParams.rate.replace(/[^0-9-]/g, '')) || 0
        const inputRate = parseInt(inputEmotionParams.rate.replace(/[^0-9-]/g, '')) || 0
        const currentPitch = parseInt(finalParams.pitch.replace(/[^0-9-]/g, '')) || 0
        const inputPitch = parseInt(inputEmotionParams.pitch.replace(/[^0-9-]/g, '')) || 0

        const blendedRate = Math.round(currentRate * 0.75 + inputRate * 0.25)
        const blendedPitch = Math.round(currentPitch * 0.75 + inputPitch * 0.25)

        finalParams = {
          voice: finalParams.voice,
          rate: `${blendedRate >= 0 ? '+' : ''}${blendedRate}%`,
          pitch: `${blendedPitch >= 0 ? '+' : ''}${blendedPitch}Hz`,
          label: `${finalParams.label}·${inputEmotionParams.label}`,
        }

        log('INFO', 'user_input_emotion_blended', {
          emotion: this.currentUserInputEmotion.emotion,
          confidence: this.currentUserInputEmotion.confidence,
          consecutive: this.currentUserInputEmotion.consecutiveEmotion,
          consecutiveCount: this.currentUserInputEmotion.consecutiveCount,
          inputRate: inputEmotionParams.rate,
          inputPitch: inputEmotionParams.pitch,
          blendedRate,
          blendedPitch,
        })
      }

      // ── 记忆情感混合（从 Memory 对话历史情感分析驱动，约 30% 权重）──
      if (this.memoryEmotionEnabled && this.memoryService) {
        try {
          const emotionContext = memoryEmotionBridge.getRecentEmotionContext(this.memoryService)
          this.lastMemoryEmotionContext = emotionContext
          if (emotionContext.recentEmotions.length > 0) {
            finalParams = memoryEmotionBridge.blendWithTtsParams(finalParams, emotionContext)
            log('INFO', 'memory_emotion_applied_to_tts', {
              dominantLabel: emotionContext.stats.dominantLabel,
              entries: emotionContext.stats.totalEntries,
              trend: emotionContext.stats.trend,
              rateDelta: emotionContext.adjustment.rateDelta,
              pitchDelta: emotionContext.adjustment.pitchDelta,
            })
          }
        } catch (err) {
          log('WARN', 'memory_emotion_tts_blend_error', { error: String(err) })
        }
      }

      // ── [Memory × TTS 深度融合] 记忆驱动的 TTS 适应 ──
      // 综合情感上下文（复用 MemoryEmotionBridge）、记忆活跃度、用户偏好，
      // 提供情感之外的额外调整维度。
      if (this.memoryService) {
        try {
          const memorySuggestion = memoryTtsBridge.getMemoryDrivenSuggestion(finalParams)
          if (memorySuggestion.confidence > 0.2 && (memorySuggestion.rateDelta !== 0 || memorySuggestion.pitchDelta !== 0)) {
            const currentRate = parseInt(finalParams.rate.replace(/[^0-9-]/g, '')) || 0
            const currentPitch = parseInt(finalParams.pitch.replace(/[^0-9-]/g, '')) || 0
            const newRate = Math.max(-50, Math.min(50, currentRate + memorySuggestion.rateDelta))
            const newPitch = Math.max(-20, Math.min(20, currentPitch + memorySuggestion.pitchDelta))
            finalParams = {
              ...finalParams,
              rate: `${newRate >= 0 ? '+' : ''}${newRate}%`,
              pitch: `${newPitch >= 0 ? '+' : ''}${newPitch}Hz`,
              label: `${finalParams.label}·忆驱动`,
            }
            log('INFO', 'memory_driven_tts_applied', {
              rateDelta: memorySuggestion.rateDelta,
              pitchDelta: memorySuggestion.pitchDelta,
              reason: memorySuggestion.reason,
              confidence: memorySuggestion.confidence,
            })
          }
        } catch (err) {
          log('WARN', 'memory_driven_tts_error', { error: String(err) })
        }
      }

      // ── [显式反馈偏好持久化] 将隐式反馈推荐保存到 Memory 用户画像 ──
      if (this.implicitFeedbackEnabled && this.lastImplicitFeedback && this.lastImplicitFeedback.confidence > 0.5) {
        try {
          memoryTtsBridge.recordUserTtsPreference(
            this.lastImplicitFeedback.params,
            this.lastImplicitFeedback.confidence,
            this.lastImplicitFeedback.reason,
          )
        } catch (err) {
          log('WARN', 'memory_tts_preference_record_error', { error: String(err) })
        }
      }

      // ── [UserBehavior → TTS 消费者合同] ──
      //
      // 重构前：ChatExecutor 手动读取 6+ 行为源 → 逐层混合 rate/pitch → setEmotion
      // 重构后：UserBehavior 集体声明需求 → buildTtsNeed 聚合 → applyBehaviorNeed
      //
      // 消费者视角的优势:
      //   - BehaviorEmotionDetector 声明"用户焦躁→需要轻柔TTS"
      //   - ContextualTtsAdvisor 声明"急迫节奏→需要低延迟"
      //   - UserContextClassifier 声明"休息情境→需要安静"
      //   - TtsService 负责"如何满足"这些需求

      // 记录各分析器的结果（供 IPC 展示 + 后续 read 用）
      if (this.behaviorEmotionEnabled) {
        this.lastBehaviorEmotion = behaviorEmotionDetector.getEmotion()
      }
      if (this.contextualTtsEnabled) {
        this.lastContextualContext = contextualTtsAdvisor.getRecommendation()
      }
      if (this.userContextClassifierEnabled) {
        this.lastUserContext = userContextClassifier.getClassification()
      }
      if (this.implicitFeedbackEnabled) {
        this.lastImplicitFeedback = implicitFeedbackTracker.getRecommendation()
      }

      // 通过 buildTtsNeed 聚合行为需求
      const behaviorNeed = buildTtsNeed(
        this.buildMinimalEnrichedState(),
        this.behaviorEmotionEnabled ? this.lastBehaviorEmotion : null,
        this.behaviorEmotionEnabled ? behaviorEmotionDetector.getMetrics() : null,
        this.contextualTtsEnabled ? this.lastContextualContext : null,
        this.userContextClassifierEnabled ? this.lastUserContext : null,
      )

      // ── 源 6: 用户语音特征画像（语速+音调自适应） ──
      // 基于最近 N 次语音交互的语速（字/秒）和声学特征（基频、能量），
      // 综合调整 TTS 合成语速和音调，使用户的听觉反馈更贴合其自然的沟通风格。
      const acousticRecommendation = userSpeechProfileTracker.getAcousticRecommendation()
      if (acousticRecommendation.rateAdjustment !== 0) {
        behaviorNeed.rateSuggestion = acousticRecommendation.rateAdjustment
      }
      if (acousticRecommendation.pitchAdjustment !== 0) {
        behaviorNeed.pitchSuggestion = acousticRecommendation.pitchAdjustment
      }
      if (acousticRecommendation.rateAdjustment !== 0 || acousticRecommendation.pitchAdjustment !== 0) {
        behaviorNeed.reason += `；${acousticRecommendation.reason}`
        behaviorNeed.sources.push('UserSpeechProfile')
      }

      // 将行为需求应用到 TTS（TtsService 内部自动根据 need 调整 rate/pitch/路由）
      this.ttsService.applyBehaviorNeed(behaviorNeed, finalParams)

      // 同步 UserContext 的语音配置到 TtsService（供 PiperOrchestrator 等查询）
      if (this.userContextClassifierEnabled) {
        const smoothedConfig = userContextClassifier.getSmoothedParams()
        this.ttsService.setContextVoiceConfig(smoothedConfig)
      }

      // 记录最后应用的参数供 IPC 展示
      this.lastEmotionParams = this.ttsService.getEmotionParams()

      // 发送完整语音风格信息到渲染进程（供 UI 展示/调试）
      this.mainWindow?.webContents.send('tts:emotion', {
        polarity: sentiment.polarity,
        contentType: sentiment.contentType,
        score: sentiment.score,
        urgency: sentiment.urgency,
        voice: finalParams.voice,
        label: finalParams.label,
        matchedWords: sentiment.matchedWords.slice(0, 5),
        // ── VoiceStyle 字段 ──
        voiceStyle: style,
        replyCategory: category,
        toneProfile:
          this.toneProfileEnabled && this.currentToneProfile
            ? {
                primaryTone: this.currentToneProfile.primaryTone,
                confidence: this.currentToneProfile.confidence,
              }
            : null,
        // ── BehaviorEmotion 字段 ──
        behaviorEmotion:
          this.behaviorEmotionEnabled && this.lastBehaviorEmotion
            ? {
                emotion: this.lastBehaviorEmotion.emotion,
                confidence: this.lastBehaviorEmotion.confidence,
                scores: this.lastBehaviorEmotion.scores,
                metrics: {
                  apm: this.lastBehaviorEmotion.metrics.apm,
                  windowSwitchesPerMin: this.lastBehaviorEmotion.metrics.windowSwitchesPerMin,
                  mouseJitter: this.lastBehaviorEmotion.metrics.mouseJitter,
                },
              }
            : null,
        // ── VoiceEmotion（从 ASR 声学特征推断）字段 ──
        voiceEmotion:
          this.voiceEmotionEnabled && this.userVoiceEmotion
            ? {
                label: this.userVoiceEmotion.label,
                confidence: this.userVoiceEmotion.confidence,
                scores: this.userVoiceEmotion.scores,
                features: this.userVoiceEmotion.features,
              }
            : null,
        // ── MemoryEmotion（从对话历史情感分析驱动）字段 ──
        memoryEmotion:
          this.memoryEmotionEnabled && this.lastMemoryEmotionContext
            ? {
                dominantLabel: this.lastMemoryEmotionContext.stats.dominantLabel,
                dominantPolarity: this.lastMemoryEmotionContext.stats.dominantPolarity,
                trend: this.lastMemoryEmotionContext.stats.trend,
                entries: this.lastMemoryEmotionContext.stats.totalEntries,
                adjustment: this.lastMemoryEmotionContext.adjustment,
                labelDistribution: this.lastMemoryEmotionContext.stats.labelCounts,
              }
            : null,
        // ── ContextualTts 字段 ──
        contextualTts:
          this.contextualTtsEnabled && this.lastContextualContext
            ? {
                cadence: this.lastContextualContext.cadence,
                dayPeriod: this.lastContextualContext.dayPeriod,
                confidence: this.lastContextualContext.confidence,
                description: this.lastContextualContext.description,
                meanIntervalSec: this.lastContextualContext.intervalStats.meanIntervalSec,
                rapidBurstCount: this.lastContextualContext.intervalStats.rapidBurstCount,
              }
            : null,
        // ── UserContext 字段 ──
        userContext:
          this.userContextClassifierEnabled && this.lastUserContext
            ? {
                context: this.lastUserContext.context,
                confidence: this.lastUserContext.confidence,
                description: this.lastUserContext.description,
                activeWindowTitle: this.lastUserContext.indicators.activeWindowTitle,
                activeProcessName: this.lastUserContext.indicators.activeProcessName,
                idleSeconds: this.lastUserContext.indicators.idleSeconds,
                apm: this.lastUserContext.indicators.apm,
              }
            : null,
        // ── [隐式反馈] 偏好学习字段 ──
        implicitFeedback:
          this.implicitFeedbackEnabled && this.lastImplicitFeedback
            ? {
                confidence: this.lastImplicitFeedback.confidence,
                totalSamples: this.lastImplicitFeedback.totalSamples,
                reason: this.lastImplicitFeedback.reason,
                recommendedVoice: this.lastImplicitFeedback.params.voice,
              }
            : null,
      })
      // ── [NARRATIVE CURVE] ──
      if (this.memoryService && combined.length >= this.NARRATIVE_MIN_LENGTH) {
        const isNarr = this.detectNarrativeContent(combined)
        if (isNarr) {
          try {
            const narrResult = narrativeEmotionController.buildNarrativeEmotion(combined, this.memoryService, finalParams, true)
            if (narrResult.segments.length > 1) {
              this.pendingNarrativeSegments = narrResult.segments
            }
          } catch (err) {
            log('WARN', 'narrative_curve_error', { error: String(err) })
          }
        }
      }
    } catch (err) {
      // 情感分析失败不应影响正常对话流程
      log('WARN', 'sentiment_apply_error', { error: String(err) })
    }
  }

  /**
   * 检测回复文本是否为叙事性内容。
   */
  private detectNarrativeContent(text: string): boolean {
    if (text.length < this.NARRATIVE_MIN_LENGTH) return false
    const narrativePatterns = [
      /让.*告诉|为.*介绍|来讲.*故事|话说|从前|有一次/,
      /首先|然后|最后|接着|另一方面/,
      /总的来说|总而言之|综上所述|归根结底/,
      /比如|例如|举例来说|打个比方/,
      /之所以|是因为|原因是|因为.*所以/,
      /如果.*就|当.*时|一旦.*便/,
    ]
    const narrativeScore = narrativePatterns.reduce((score: number, p: RegExp) => {
      return score + (p.test(text) ? 1 : 0)
    }, 0)
    const chatPatterns = [/^[好嗯哦对是]/, /^[哈哈呵呵嘿嘿]+/, /明白|了解|知道了|没问题/]
    const chatScore = chatPatterns.reduce((score: number, p: RegExp) => {
      return score + (p.test(text) ? 1 : 0)
    }, 0)
    return narrativeScore >= 1 || (text.length >= this.NARRATIVE_MIN_LENGTH * 2 && chatScore === 0)
  }

  /** 切换情感自适应语音开关（供 IPC 调用） */
  toggleEmotionTts(enabled: boolean): void {
    this.emotionTtsEnabled = enabled
    this.ttsService.setEmotionEnabled(enabled)
    if (!enabled) {
      this.lastEmotionParams = null
    }
    this.mainWindow?.webContents.send('tts:emotion:enabled', { enabled })
  }

  /** 获取当前情感 TTS 状态 */
  getEmotionTtsState(): { enabled: boolean; params: EmotionTtsParams | null } {
    return {
      enabled: this.emotionTtsEnabled,
      params: this.emotionTtsEnabled ? this.ttsService.getEmotionParams() : null,
    }
  }

  // ══════════════════════════════════════════
  //  语气记忆个性化语音
  // ══════════════════════════════════════════

  /**
   * 懒初始化语气画像：首次调用时从缓存加载，
   * 恢复 ToneProfileAnalyzer 状态。
   */
  private ensureToneProfileInit(): void {
    if (this.toneProfileInitialized) return
    this.toneProfileInitialized = true

    try {
      const cached = toneProfileCache.load()
      if (cached.messageCount > 0) {
        toneProfileAnalyzer.restoreFromProfile(cached)
        this.currentToneProfile = cached
        this.lastToneBaseline = toneToVoiceMapper.getBaselineParams(cached)
        log('INFO', 'tone_profile_init_from_cache', {
          tone: cached.primaryTone,
          messages: cached.messageCount,
          confidence: cached.confidence.toFixed(2),
          baselineVoice: this.lastToneBaseline.voice,
        })
      }
    } catch (err) {
      log('WARN', 'tone_profile_init_error', { error: String(err) })
    }
  }

  /** 切换语气记忆个性化语音开关（供 IPC 调用） */
  toggleToneProfileTts(enabled: boolean): void {
    this.toneProfileEnabled = enabled
    if (!enabled) {
      this.lastToneBaseline = null
    }
    this.mainWindow?.webContents.send('tts:toneProfile:enabled', { enabled })
  }

  /** 获取当前语气画像状态（供 IPC/调试） */
  getToneProfileState(): {
    enabled: boolean
    profile: UserToneProfile | null
    baseline: EmotionTtsParams | null
  } {
    return {
      enabled: this.toneProfileEnabled,
      profile: this.currentToneProfile,
      baseline: this.lastToneBaseline,
    }
  }

  // ══════════════════════════════════════════
  //  行为情绪检测
  // ══════════════════════════════════════════

  /** 切换行为情绪检测开关（供 IPC 调用） */
  toggleBehaviorEmotion(enabled: boolean): void {
    this.behaviorEmotionEnabled = enabled
    behaviorEmotionDetector.setEnabled(enabled)
    if (!enabled) {
      this.lastBehaviorEmotion = null
    }
    this.mainWindow?.webContents.send('tts:behaviorEmotion:enabled', { enabled })
  }

  /** 记录一次撤回/重做操作，用于行为情绪推断（供 IPC 调用） */
  recordBehaviorRetraction(): void {
    if (!this.behaviorEmotionEnabled) return
    behaviorEmotionDetector.recordRetraction()
  }

  /** 获取当前行为情绪状态（供 IPC/调试） */
  getBehaviorEmotionState(): {
    enabled: boolean
    result: BehaviorEmotionResult | null
    metrics: BehaviorMetrics | null
  } {
    return {
      enabled: this.behaviorEmotionEnabled,
      result: this.lastBehaviorEmotion,
      metrics: this.behaviorEmotionEnabled ? behaviorEmotionDetector.getMetrics() : null,
    }
  }

  // ══════════════════════════════════════════
  //  交互情境自适应语音
  // ══════════════════════════════════════════

  /** 切换交互情境自适应语音开关（供 IPC 调用，系统托盘 auto/manual 模式） */
  toggleContextualTts(enabled: boolean): void {
    this.contextualTtsEnabled = enabled
    contextualTtsAdvisor.setEnabled(enabled)
    if (!enabled) {
      this.lastContextualContext = null
    }
    this.mainWindow?.webContents.send('tts:contextual:enabled', { enabled })
  }

  /** 获取当前交互情境自适应状态（供 IPC/调试） */
  getContextualTtsState(): {
    enabled: boolean
    context: InteractionContext | null
  } {
    return {
      enabled: this.contextualTtsEnabled,
      context: this.contextualTtsEnabled ? contextualTtsAdvisor.getRecommendation() : null,
    }
  }

  // ══════════════════════════════════════════
  //  用户情境自适应语音
  // ══════════════════════════════════════════

  /** 切换用户情境自适应语音开关（供 IPC 调用） */
  toggleUserContextClassifier(enabled: boolean): void {
    this.userContextClassifierEnabled = enabled
    userContextClassifier.setEnabled(enabled)
    if (!enabled) {
      userContextClassifier.stop()
      this.lastUserContext = null
    } else {
      userContextClassifier.start()
    }
    this.mainWindow?.webContents.send('tts:userContext:enabled', { enabled })
  }

  /** 设置用户情境手动覆盖模式（供 IPC/系统托盘调用） */
  setUserContextOverride(mode: ContextOverrideMode): void {
    userContextClassifier.setOverrideMode(mode)
    log('INFO', 'user_context_override_changed', { mode })
  }

  /** 获取当前用户情境自适应状态（供 IPC/调试） */
  getUserContextState(): {
    enabled: boolean
    result: ContextClassificationResult | null
  } {
    return {
      enabled: this.userContextClassifierEnabled,
      result: this.lastUserContext,
    }
  }

  /** 重置用户情境分类器过渡状态 */
  resetUserContextTransition(): void {
    userContextClassifier.resetTransition()
  }

  // ══════════════════════════════════════════
  //  隐式反馈驱动的语音自适应
  // ══════════════════════════════════════════

  /** 切换隐式反馈语音自适应开关（供 IPC 调用） */
  toggleImplicitFeedback(enabled: boolean): void {
    this.implicitFeedbackEnabled = enabled
    implicitFeedbackTracker.setEnabled(enabled)
    if (!enabled) {
      this.lastImplicitFeedback = null
    }
    this.mainWindow?.webContents.send('tts:implicitFeedback:enabled', { enabled })
  }

  /** 获取当前隐式反馈状态（供 IPC/调试） */
  getImplicitFeedbackState(): {
    enabled: boolean
    recommendation: PreferenceRecommendation | null
    status: {
      modelInitialized: boolean
      totalSamples: number
      historySize: number
    }
  } {
    const status = implicitFeedbackTracker.getStatus()
    return {
      enabled: this.implicitFeedbackEnabled,
      recommendation: this.implicitFeedbackEnabled ? this.lastImplicitFeedback : null,
      status: {
        modelInitialized: status.modelInitialized,
        totalSamples: status.totalSamples,
        historySize: status.historySize,
      },
    }
  }

  /** 触发隐式反馈模型立即更新 */
  triggerImplicitFeedbackUpdate(): void {
    implicitFeedbackTracker.updateModel()
    log('INFO', 'implicit_feedback_manual_update_triggered')
  }

  /** 重置隐式反馈模型学习数据 */
  resetImplicitFeedback(): void {
    implicitFeedbackTracker.reset()
    this.lastImplicitFeedback = null
    log('INFO', 'implicit_feedback_reset')
  }

  // ══════════════════════════════════════════
  //  语音情感自适应（从 ASR 声学特征推断的用户情绪 → TTS 参数）
  // ══════════════════════════════════════════

  /**
   * 设置来自 ASR 的用户语音情感分析结果。
   * 由 IPC handler（asr:transcribe 成功后）调用。
   * 在下一轮 applySentimentToTts() 中自动融合到 TTS 参数。
   */
  setUserVoiceEmotion(emotion: VoiceEmotion | null): void {
    this.userVoiceEmotion = emotion
    if (emotion) {
      log('INFO', 'voice_emotion_set', {
        label: emotion.label,
        confidence: emotion.confidence,
        energy: emotion.features.energy,
        pitchHz: emotion.features.pitchHz,
      })
    }
  }

  /** 获取当前用户语音情感（供调试/UI） */
  getUserVoiceEmotion(): VoiceEmotion | null {
    return this.userVoiceEmotion
  }

  /** 切换语音情感自适应开关 */
  toggleVoiceEmotionTts(enabled: boolean): void {
    this.voiceEmotionEnabled = enabled
    if (!enabled) {
      this.userVoiceEmotion = null
    }
    this.mainWindow?.webContents.send('tts:voiceEmotion:enabled', { enabled })
  }

  /** 获取语音情感自适应状态 */
  getVoiceEmotionState(): { enabled: boolean; emotion: VoiceEmotion | null } {
    return {
      enabled: this.voiceEmotionEnabled,
      emotion: this.voiceEmotionEnabled ? this.userVoiceEmotion : null,
    }
  }

  // ══════════════════════════════════════════
  //  记忆情感自适应（从 Memory 对话历史情感分析驱动）
  // ══════════════════════════════════════════

  /** 切换记忆情感自适应语音开关（供 IPC 调用） */
  toggleMemoryEmotionTts(enabled: boolean): void {
    this.memoryEmotionEnabled = enabled
    if (!enabled) {
      this.lastMemoryEmotionContext = null
    }
    log('INFO', 'memory_emotion_tts_enabled', { enabled })
  }

  /** 获取记忆情感自适应状态 */
  getMemoryEmotionState(): {
    enabled: boolean
    context: import('../tts/MemoryEmotionBridge').AggregatedEmotionContext | null
  } {
    return {
      enabled: this.memoryEmotionEnabled,
      context: this.memoryEmotionEnabled ? this.lastMemoryEmotionContext : null,
    }
  }

  // ══════════════════════════════════════════
  //  UserBehavior → TTS 消费者合同
  // ══════════════════════════════════════════

  /**
   * 懒初始化行为状态订阅（通过 EventBus 获取 UserBehaviorService 的最新状态）。
   * 只订阅一次，重复调用无害。
   */
  private ensureBehaviorStateSubscription(): void {
    if (this.behaviorStateSubscribed) return
    this.behaviorStateSubscribed = true
    try {
      eventBus.on('behavior.state.updated', (state: EventPayload['behavior.state.updated']) => {
        if (state && typeof state === 'object') {
          this.cachedBehaviorState = {
            activityState: state.activityState ?? 'active',
            fullscreen: state.fullscreen ?? false,
            focused: state.focused ?? true,
            idleTimeMs: state.idleTimeMs ?? 0,
          }
        }
      })
    } catch (err) {
      log('WARN', 'behavior_state_subscribe_error', { error: String(err) })
    }
  }

  /**
   * 从缓存的行为状态 + BehaviorStateMachine 构建最小 EnrichedBehaviorState
   * 供 buildTtsNeed 消费。当订阅尚未收到数据时返回 null（buildTtsNeed 会优雅降级）。
   */
  private buildMinimalEnrichedState(): {
    mode: BehaviorMode
    activityState: string
    fullscreen: boolean
    focused: boolean
    idleTimeMs: number
  } | null {
    if (!this.cachedBehaviorState) return null
    return {
      mode: behaviorStateMachine.getCurrentMode(),
      activityState: this.cachedBehaviorState.activityState,
      fullscreen: this.cachedBehaviorState.fullscreen,
      focused: this.cachedBehaviorState.focused,
      idleTimeMs: this.cachedBehaviorState.idleTimeMs,
    }
  }
}
