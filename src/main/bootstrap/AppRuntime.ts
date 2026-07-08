import { app } from 'electron'
import { join, dirname } from 'path'
import { promises as fsp, readFileSync } from 'fs'
import { log, initLogFile, getLogFilePath, sanitizeForLog } from '../logger/Logger'
import { StateManager } from '../core/StateManager'
import { eventBus, SubscriptionTracker } from '../core/EventBus'
import { INITIAL_HOTWORDS, WORKSPACE, RUNTIME_ROOT } from '../config'
import { ServerManager } from '../mcp/ServerManager'
import { LlmService } from '../llm/LlmService'
import { WhisperGpuEngine } from '../asr/WhisperGpuEngine'
import { BaiduEngine } from '../asr/BaiduEngine'
import { AsrService } from '../asr/AsrService'
import { TtsService } from '../tts/TtsService'
import { AgentService } from '../agent/AgentService'
import { MemoryService } from '../memory/MemoryService'
import { registerHandlers, createServiceRef } from '../ipc/handlers'
import { credentialsManager } from '../credentials/CredentialsManager'
import { initEvolution, evolutionService, planManager, SelfEvolutionService } from '../evolution'
import { PipelineOrchestrator, CreativityCollector, CreativityExecutor, MemoryAnalysisCollector } from '../evolution/automation'
import { initInsight, insightService, insightStore } from '../insight'
import { initCreativity, creativityService } from '../creativity'
import { initInspiration } from '../inspiration'
import { setMemoryService } from '../mcp/LocalProvider'
import {
  setPlanManager,
  setCredentialsManager,
  setSkillManager as setToolSkillManager,
  setCognitiveService,
  setHealthManager,
} from '../tool/deps'
import { PluginLoader, toolRegistry } from '../plugin'
import { SkillManager, setSkillManager as setSkillManagerSingleton } from '../skill'
import { loadEnvFile, setupTransformers } from '../core/ModelLoader'
import { setupStartupLogging, createWindow, setupWallpaperListener, getMainWindow } from '../core/Lifecycle'
import { initTray, destroyTray, setDashboardToggle, setContextualTtsToggle } from '../core/TrayManager'
import { initUpdater, setUpdateWindow } from '../updater/UpdaterService'
import { EvolutionDashboardService } from '../wallpaper/WallpaperService'
import { initDatabase, closeDatabase } from '../db/connection'
import { ConstitutionEngine } from '../constitution'
import { CapabilityEngine, freezeDefaults } from '../capability'
import { CognitiveService } from '../cognitive'
import { AuditTrail } from '../plugin/AuditTrail'
import { MemoryIndexer } from '../memory/MemoryIndexer'
import { Kernel } from '../core/Kernel'
import { WorkerPool } from '../core/WorkerPool'
import { ProcessManager } from '../core/ProcessManager'
import { AgentModule, MemoryModule, EvolutionModule, McpModule } from '../core/kernel-modules'
import { SessionGovernor } from '../governance'
import { CheckpointV2 } from '../governance'
import { systemBus } from '../core/SystemBus'
import { SyscallBus, HealthChecker } from '../core/lifecycle/index'
import type { IModule, SubsystemState } from '../core/lifecycle/types'
import { TelegramService } from '../telegram/TelegramService'
import { OutboxWorker } from '../telegram/OutboxWorker'
import { UumitService } from '../uumit/index'
import type { TaskExecutionResult } from '../core/tasks/unified/TaskTypes'
import { TaskRunner } from '../core/tasks/unified/TaskRunner'
import { MetricsCollector } from '../observability/MetricsCollector'
import { SystemStabilityScore } from '../observability/SystemStabilityScore'
import { ComfyUIManager } from '../image/ComfyUIManager'
import { setComfyUIManager as setImageToolComfyUI } from '../tool/definitions/ImageGenerationTool'
import { ResourceBudget } from '../core/ResourceBudget'
import { BudgetRebalancer } from '../core/BudgetRebalancer'
import { LazyServiceGroup } from './LazyServiceGroup'
import { SessionRecoveryManager } from '../agent/SessionRecoveryManager'
import { UIBridge } from '../agent/UIBridge'
import { EventStore } from '../core/event-sourcing/EventStore'
import { RuntimeHealthManager } from '../health/RuntimeHealthManager'
import { EvaluationStore } from '../core/evaluation/EvaluationStore'
import { EvaluationEmitter } from '../core/evaluation/EvaluationEmitter'
import { RepositoryEventIterator } from '../core/evaluation/RepositoryEventIterator'
import { MetricsEngineImpl } from '../core/evaluation/MetricsEngine'
import { ToolEventBridge } from '../core/evaluation/ToolEventBridge'
import { GuardrailPipeline } from '../core/evaluation/GuardrailPipeline'
import type { MetricSnapshot, TimeWindow } from '../core/evaluation/types'

/**
 * AppRuntime — 应用启动生命周期编排器。
 * 封装 index.ts 中原本的模块级初始化逻辑，提供清晰的启动阶段。
 */
export class AppRuntime {
  private subs = new SubscriptionTracker()
  private taskRunner?: TaskRunner
  private lazyInit?: LazyServiceGroup
  private gpuInitTimeout?: ReturnType<typeof setTimeout> | null
  private memoryService?: MemoryService
  private memoryIndexer?: MemoryIndexer
  private workerPool?: WorkerPool
  private processManager?: ProcessManager
  private pluginLoader?: PluginLoader
  private agentServiceRef?: AgentService
  private crashGuard: { flushMemory: (() => void) | null }
  private resourceBudget?: ResourceBudget
  private metricsCollector?: MetricsCollector
  private stabilityScore?: SystemStabilityScore
  private proposalValidator?: any
  private gitOps?: any
  private syscallBus?: SyscallBus
  private healthChecker?: HealthChecker
  private capabilityEngine?: CapabilityEngine
  private sessionGovernor?: SessionGovernor
  private checkpointV2?: CheckpointV2
  private runtimeHealthManager?: RuntimeHealthManager
  private evaluationStore?: EvaluationStore
  private evaluationEmitter?: EvaluationEmitter
  private toolEventBridge?: ToolEventBridge
  private metricsEngine?: MetricsEngineImpl
  private comfyUI?: ComfyUIManager
  private pipeline?: PipelineOrchestrator
  private dashboardService?: EvolutionDashboardService

  constructor(crashGuard?: { flushMemory: (() => void) | null }) {
    this.crashGuard = crashGuard ?? { flushMemory: null }
  }

  async start(): Promise<void> {
    // === Stage 0: CLI flags & env ===
    setupStartupLogging()
    loadEnvFile()
    setupTransformers()

    const llmKey = process.env.LLM_KEY
    const llmCodeKey = process.env.LLM_CODE_KEY

    // === Stage 1: 核心基础设施 ===
    const stateManager = new StateManager()
    const mcpManager = new ServerManager()

    // 注册 Playwright MCP 服务器，赋予 AI 浏览器自动化能力
    try {
      const pwMcpDir = dirname(require.resolve('@playwright/mcp/package.json'))
      const cliPath = join(pwMcpDir, 'cli.js')
      mcpManager
        .addServer({
          name: 'playwright',
          transport: 'stdio',
          command: 'node',
          args: [cliPath, '--headless'],
        })
        .catch((err) => log('WARN', 'playwright_mcp_start_failed', { error: String(err) }))
    } catch {
      log('WARN', 'playwright_mcp_not_found')
    }

    const llmService = new LlmService(mcpManager)
    const gpuEngine = new WhisperGpuEngine()
    const baiduEngine = new BaiduEngine()
    const asrService = new AsrService(gpuEngine, baiduEngine)
    // 初始化长时个性化词表（从持久化存储加载）
    asrService.initVocabulary()

    this.registerCoreEventBus()
    this.logModelConfig(llmKey)

    if (llmKey) {
      llmService.setConfig(llmKey, llmCodeKey || llmKey)
    } else {
      log('WARN', 'missing_api_key')
    }

    // Phase 4: Agent OS 基础设施
    this.syscallBus = new SyscallBus()
    this.healthChecker = new HealthChecker(30_000)
    this.workerPool = new WorkerPool()
    this.processManager = new ProcessManager()

    // Phase 1-3: 基础设施实例化
    this.resourceBudget = new ResourceBudget()
    this.stabilityScore = new SystemStabilityScore()
    this.metricsCollector = new MetricsCollector()
    const { ProposalValidator } = await import('../evolution/ProposalValidator')
    const { EvolutionGitOps } = await import('../evolution/EvolutionGitOps')
    this.proposalValidator = new ProposalValidator()
    this.gitOps = new EvolutionGitOps()

    const ttsService = new TtsService((state) => stateManager.update(state))

    // ── TTS 路由：从凭据存储恢复用户的引擎偏好 ──
    try {
      const savedPref = credentialsManager.get('tts_mode')
      if (savedPref === 'cloud' || savedPref === 'local' || savedPref === 'auto') {
        ttsService.setEnginePreference(savedPref)
        log('INFO', 'tts_preference_restored', { preference: savedPref })
      }
    } catch (err) {
      // 凭据存储可能尚未就绪
      log('DEBUG', 'tts_preference_restore_skipped', { error: String(err).slice(0, 60) })
    }

    // ── 预检测网络状态（后台异步，不阻塞启动） ──
    import('../tts/NetworkMonitor').then(({ networkMonitor }) => {
      networkMonitor.refresh().catch(() => {})
    })

    const agentService = new AgentService(llmService, asrService, ttsService, eventBus, mcpManager)
    this.agentServiceRef = agentService
    // 将 SubAgentPool 引用注入到 SkillAgentTools 全局
    const { setSubAgentPool } = await import('../tool/definitions/SkillAgentTools')
    setSubAgentPool(agentService['subAgentPool'])

    const recoveryManager = new SessionRecoveryManager(join(WORKSPACE.evolution, 'recovery'))
    agentService.setRecoveryManager(recoveryManager)

    // 初始化 WorkflowScheduler V2
    const { WorkflowSchedulerV2, setWorkflowScheduler } = await import('../workflow/WorkflowScheduler')
    const { workflowStore } = await import('../workflow/WorkflowStoreV2')
    const scheduler = new WorkflowSchedulerV2({
      runSubAgent: (goal, parentGoal, options) => agentService['subAgentPool'].spawn(goal, parentGoal, options),
      runTool: async (name, args) => {
        const result = await mcpManager.callTool(name, args)
        return typeof result === 'string' ? result : JSON.stringify(result)
      },
      runApi: async (url, method, body) => {
        const res = await fetch(url, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        })
        return res.text()
      },
      injectPrompt: () => {},
      getCompletedAgentResults: () =>
        agentService['subAgentPool'].collectCompleted().map((r) => ({ id: r.id, summary: r.summary, error: r.error })),
      runPlan: (prompt) => {
        const planManager = agentService['planManager']
        return planManager.createPlan('Workflow Plan', prompt, []).id
      },
      getPlanStatus: () => {
        const pm = agentService['planManager']
        const plan = pm.getActivePlan()
        if (!plan) return null
        const done = plan.steps.filter((s: any) => s.status === 'done').length
        return {
          id: plan.id,
          title: plan.title || '',
          total: plan.steps.length,
          done,
          pending: plan.steps.filter((s: any) => s.status !== 'done').map((s: any) => s.description),
          status: plan.status,
        }
      },
      getDefinition: (id) => workflowStore.getDefinition(id),
    })
    setWorkflowScheduler(scheduler)

    // 初始化 WorkflowTriggerManager（cron + event 触发）
    const { WorkflowTriggerManager } = await import('../workflow/WorkflowTriggerManager')
    const triggerManager = new WorkflowTriggerManager()
    triggerManager.start()

    const telegramService = new TelegramService(agentService)

    // === Stage 2: Electron 窗口 ===
    await app.whenReady()
    initLogFile(WORKSPACE.logs)
    log('INFO', 'log_file_ready', { path: getLogFilePath() })
    await initDatabase()
    log('INFO', 'database_ready')
    credentialsManager.migrate()
    log('INFO', 'credential_migration_done')
    setCredentialsManager(credentialsManager)
    // 从凭据存储覆盖 env 配置，让设置界面填入的 LLM 参数生效
    llmService.refreshFromCredentials((key) => credentialsManager.get(key))
    log('INFO', 'llm_config_loaded_from_credentials')

    // Evaluation 子系统：Store → Emitter → Bridge
    this.evaluationStore = new EvaluationStore()
    await this.evaluationStore.init()
    const sessionId = `runtime_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.evaluationEmitter = new EvaluationEmitter(this.evaluationStore, 'runtime', sessionId)
    llmService.setEvaluationEmitter(this.evaluationEmitter)
    this.toolEventBridge = new ToolEventBridge(this.evaluationEmitter, eventBus)
    this.toolEventBridge.start()
    // GuardrailPipeline — 注入 ChatExecutor 的 GuardrailPipeline（需要 evaluationStore + emitter 就绪）
    const guardrailPipeline = new GuardrailPipeline(this.evaluationStore, undefined, undefined, this.evaluationEmitter)
    agentService.setGuardrailPipeline(guardrailPipeline)
    log('INFO', 'evaluation_ready', { sessionId })

    const win = createWindow(stateManager)
    agentService.setMainWindow(win)
    ttsService.setAudioSink(async (filePath) => {
      try {
        const buf = await fsp.readFile(filePath)
        win.webContents.send('tts:play_audio_buffer', buf)
      } catch {
        win.webContents.send('tts:play_audio', filePath)
      }
    })

    // 系统托盘 — 关闭窗口时隐藏到托盘而非退出
    initTray(() => getMainWindow())

    // UIBridge: 将 EventBus 事件桥接到 Renderer 窗口
    const uiBridge = new UIBridge()
    uiBridge.bind(win)

    // === Stage 3: 核心服务（内存、插件、技能） ===
    const memoryService = new MemoryService()
    this.memoryService = memoryService
    this.crashGuard.flushMemory = () => memoryService.flush()
    const skillManager = new SkillManager()
    await skillManager.initialize()
    agentService.setSkillManager(skillManager)
    setSkillManagerSingleton(skillManager)
    agentService.setMemoryService(memoryService)
    setMemoryService(memoryService)
    setPlanManager(planManager)
    setToolSkillManager(skillManager)

    // Phase 4: Kernel 升级 — init() / start() 生命周期
    const kernel = Kernel.getInstance()
    await kernel.init()

    // Phase 4: 注册内核模块（Agent, Memory, MCP, Evolution 等）
    const agentModule = new AgentModule(agentService)
    const memoryModule = new MemoryModule(memoryService)
    const mcpModule = new McpModule(mcpManager)
    await kernel.registerModule(agentModule)
    await kernel.registerModule(memoryModule)
    await kernel.registerModule(mcpModule)

    // Phase 4: ProcessManager — 子进程生命周期管理
    await this.processManager!.init()

    // Phase 4: WorkerPool — 后台工作线程池（ISubsystem，独立生命周期）
    await this.workerPool!.init()

    // Phase 4: SessionGovernor — 会话级健康治理
    this.sessionGovernor = new SessionGovernor()
    this.sessionGovernor.setStateManager(stateManager)
    await this.sessionGovernor.init()

    // Phase 4: CheckpointV2 — 带健康验证的检查点
    this.checkpointV2 = new CheckpointV2(join(WORKSPACE.evolution, 'recovery'), recoveryManager)
    this.checkpointV2.setHealthScorer(this.sessionGovernor.scorer)

    // Phase 4: 连接 SessionGovernor 恢复回调到 AgentService
    this.sessionGovernor.setRecoveryCallbacks({
      onContextCompress: () => {
        try {
          agentService.getContext().trimOrphanedToolCalls?.()
        } catch {}
      },
      onInjectCorrection: (msg) => {
        try {
          agentService.getContext().addSystemMessage?.(msg)
        } catch {}
      },
      onClearContext: () => {
        try {
          agentService.clearContext()
        } catch {}
      },
    })

    // 注册 SyscallBus 为内核模块
    const kernelModule: IModule = {
      name: 'syscall',
      prefix: 'src/main/core/lifecycle/',
      hotReloadable: false,
      exports: ['SyscallBus'],
      state: 'ready' as SubsystemState,
      init: async () => {},
      start: async () => {},
      stop: async () => {},
      destroy: async () => {},
      healthCheck: async () => ({ healthy: true }),
      getExport: (n: string) => (n === 'SyscallBus' ? this.syscallBus : undefined),
      handleSyscall: async (method: string) => {
        if (method === 'list_syscalls') return { modules: this.syscallBus!.getRegisteredModules() }
        throw new Error(`Unknown syscall: ${method}`)
      },
    }
    await kernel.registerModule(kernelModule)
    await kernel.start()
    // Phase 4: 启动会话治理
    await this.sessionGovernor!.start()
    // Phase 4: 冻结内核模块注册表 + 能力沙箱默认值
    kernel.freezeModuleRegistry()
    freezeDefaults()
    kernel.verifyIntegrity()

    log('INFO', 'kernel_ready', {
      modules: kernel.getModules().map((m) => ({ name: m.name, state: m.state })),
    })

    if (memoryService.engineering) {
      agentService.reflectLoop.setDeps(llmService, memoryService.engineering)
      agentService.reflectLoop.setResourceBudget(this.resourceBudget!)
      agentService.reflectLoop.setDecisionStore(memoryService['decisionStore'])
      agentService.failureAnalyzer.setEngineering(memoryService.engineering)
      agentService.failureAnalyzer.start()
      agentService.sleepCycle.setDeps(memoryService, agentService.failureAnalyzer)
      agentService.sleepCycle.setMetaController(memoryService.metaController)
      log('INFO', 'agent_cognitive_enhancements_ready', { reflect: true, failureAnalyzer: true, sleepCycle: true })
    }

    // 预算再平衡器：监听 budget.exhausted 事件，动态调配 pool 预算
    new BudgetRebalancer(this.resourceBudget!)

    // === Stage 4: 插件 & MCP ===
    const pluginLoader = new PluginLoader()
    this.pluginLoader = pluginLoader
    await pluginLoader.loadAll()
    log('INFO', 'plugin_system_ready', { plugins: pluginLoader.getLoadedPlugins() })

    const auditTrail = new AuditTrail()
    toolRegistry.setAuditTrail(auditTrail)
    log('INFO', 'audit_trail_ready')

    log('INFO', 'mcp_ready', { servers: mcpManager.listServers().length, tools: mcpManager.listTools().length })
    telegramService.initialize()

    // === Stage 5: Handler 注册 & 宪法 ===
    const evolutionRef = createServiceRef<SelfEvolutionService>()
    const dashboardRef = createServiceRef<EvolutionDashboardService>()
    registerHandlers(agentService, stateManager, ttsService, evolutionRef, undefined, dashboardRef)

    const constitutionEngine = new ConstitutionEngine()
    await constitutionEngine.initialize(join(WORKSPACE.evolution, 'constitution'))
    constitutionEngine.setEnforcementMode('enforce')
    // Phase 4: 延迟注入 GoalGuardrail 依赖（ConstitutionEngine 在此阶段可用）
    agentService.goalGuardrail.setConstitutionEngine(constitutionEngine)
    // Phase 4: CapabilityEngine
    this.capabilityEngine = new CapabilityEngine()
    this.capabilityEngine.setEnforcementMode('enforce')
    this.capabilityEngine.setConstitutionEngine(constitutionEngine)
    mcpManager.setCapabilityEngine(this.capabilityEngine)
    mcpManager.setMemoryService(memoryService)
    log('INFO', 'capability_engine_ready', { mode: this.capabilityEngine.getEnforcementMode() })

    // Phase 4: HealthChecker 子系统注册
    await this.healthChecker.init()
    this.healthChecker.register(kernel)
    this.healthChecker.register(this.syscallBus as any)
    await this.healthChecker.start()

    // Phase 4: WorkerPool start + worker 注册
    await this.workerPool!.start()
    this.workerPool!.register('memory-indexer', 'memory-indexer-worker')
    this.workerPool!.register('verification', 'verification-worker')
    this.workerPool!.register('observer', 'observer-worker')
    this.healthChecker.register(this.workerPool!)
    this.healthChecker.register(this.sessionGovernor!)
    this.healthChecker.register(this.processManager!)
    // Phase 5D: RuntimeHealthManager init with available providers (TaskRunner not yet ready)
    this.runtimeHealthManager = new RuntimeHealthManager()
    this.runtimeHealthManager.setSessionHealthProvider(this.sessionGovernor!.scorer)
    this.runtimeHealthManager.setCapabilityHealthProvider(mcpManager)
    await this.runtimeHealthManager.init()
    setHealthManager(this.runtimeHealthManager)
    this.healthChecker.register(this.runtimeHealthManager)
    await this.runtimeHealthManager.start()
    // Phase 4: ProcessManager 启动（此时开始健康检查）
    await this.processManager!.start()
    log('INFO', 'process_manager_ready')
    log('INFO', 'workerpool_ready', { workers: ['memory-indexer', 'verification', 'observer'] })
    log('INFO', 'health_checker_started')

    // === Stage 6: Task Runtime & Memory Indexer ===
    this.taskRunner = new TaskRunner()

    // 注册 stability.tick 到 TaskRunner（原 TaskScheduler 已弃用）
    let previousStabilityStatus: string | undefined
    this.taskRunner.register(
      'stability.tick',
      async () => {
        if (this.metricsCollector && this.stabilityScore) {
          previousStabilityStatus = this.stabilityScore.getStatus()
          const snapshot = this.metricsCollector.getSnapshot()
          const stabilityInputs = this.metricsCollector.getStabilityInputs()
          const factors = {
            memoryHealth: Math.max(0, 1 - snapshot.memory.heapUsedMB / Math.max(snapshot.memory.heapTotalMB, 1)),
            taskFlowEfficiency: stabilityInputs.taskFlowEfficiency,
            schedulerBalance: stabilityInputs.schedulerBalance,
            evolutionRiskControl: stabilityInputs.evolutionRiskControl,
            errorRateInverse: snapshot.apiCalls.total > 0 ? 1 - snapshot.apiCalls.failureCount / snapshot.apiCalls.total : 1,
            guardrailHealth: snapshot.guardrail.totalRejections > 0 ? Math.max(0.3, 1 - snapshot.guardrail.totalRejections * 0.1) : 1,
          }
          const score = this.stabilityScore.compute(factors)
          const trend = this.stabilityScore.getTrend()
          const status = this.stabilityScore.getStatus()

          // 当状态变化时发出事件（仅观测，不参与调度决策循环）
          eventBus.emit('stability.score.updated', { score, trend, status })
          if (status !== previousStabilityStatus) {
            eventBus.emit('stability.status.changed', { previous: previousStabilityStatus, current: status, score })
          }
        }
        return { success: true }
      },
      60000,
    )

    const memoryIndexer = new MemoryIndexer(30)
    this.memoryIndexer = memoryIndexer
    memoryIndexer.setMemoryService(memoryService)
    memoryIndexer.setEngineering(memoryService.engineering)
    memoryIndexer.setKnowledgeGraph(memoryService.knowledgeGraph)
    memoryIndexer.setWorkerPool(this.workerPool!)

    const cognitiveService = new CognitiveService()
    await cognitiveService.initialize(join(RUNTIME_ROOT, 'CONSTITUTION.md'), {
      engineeringMemory: memoryService.engineering,
      proceduralMemory: agentService.proceduralMemory,
      llmService,
    })
    agentService.tokenAccount = cognitiveService.tokenAccount
    // 推送身份上下文到 AgentService → ChatExecutor
    agentService['identityContext'] = cognitiveService.identity.getFormattedContext()
    // Phase 5: 延迟注入 GoalGuardrail 的 GoalEngine（CognitiveService 在此阶段可用）
    agentService.goalGuardrail.setGoalEngine(cognitiveService.goals)
    setCognitiveService(cognitiveService) // 注入到 tool/deps，供 GoalTools 等使用
    log('INFO', 'cognitive_service_ready', {
      goals: cognitiveService.goals.getActiveGoals().length,
      tokenBalance: cognitiveService.tokenAccount.getBalance(),
    })

    // Wire LLMKnowledgeExtractor into KnowledgeGraph
    const { LLMKnowledgeExtractor } = await import('../memory/extractors/LLMKnowledgeExtractor')
    const llmExtractor = new LLMKnowledgeExtractor()
    if (llmService) {
      llmExtractor.setLlm({
        chatJson: (prompt: string, opts?: any) => llmService.chatJson(prompt, opts),
      })
    }
    memoryService.knowledgeGraph.setLLMExtractor(llmExtractor)

    // Phase 5: SystemBus 注册 & 冻结
    systemBus.registerQuery<number>(
      'utility-score',
      'goal-engine',
      async () => {
        const goals = cognitiveService.goals.getActiveGoals()
        if (goals.length === 0) return 0.5
        // 有活跃目标时降低基础分，迫使 LLM 更谨慎
        return 0.7
      },
      { fallback: 0.5, timeoutMs: 100 },
    )

    systemBus.registerQuery<number>(
      'utility-score',
      'resource-budget',
      async () => {
        const s = this.resourceBudget!.getSnapshot()
        const maxCalls = this.resourceBudget!.getConfig().maxLlmCallsPerRequest
        const utilization = s.llmCallsThisRequest / Math.max(maxCalls, 1)
        return Math.max(0, 1 - utilization)
      },
      { dependencies: ['goal-engine'], fallback: 0.5, timeoutMs: 100 },
    )

    systemBus.registerQuery<number>(
      'utility-score',
      'memory-activity',
      async () => {
        if (!memoryService) return 0.5
        const count = memoryService.getInteractionCount()
        // 交互越多 → 上下文越复杂 → 需要更谨慎
        return Math.max(0.3, 1 - count * 0.01)
      },
      { dependencies: ['resource-budget'], fallback: 0.5, timeoutMs: 100 },
    )

    // 注入 GoalGuardrail 的 SystemBus 引用
    agentService.goalGuardrail.setSystemBus(systemBus)

    const dagResult = systemBus.validateDAG()
    if (!dagResult.valid) {
      log('ERROR', 'systembus_dag_validation_failed', { cycles: dagResult.cycles.map((c) => c.join(' -> ')) })
    }
    systemBus.freeze()
    log('INFO', 'systembus_ready', { stats: systemBus.getStats() })

    // SystemBus v2: EventBus bridge
    systemBus.bridgeFrom(eventBus, [
      {
        event: 'evolution.cycle.completed',
        command: 'evolution.adjust-priority',
        mapPayload: (p) => ({ success: p.success, durationMs: p.durationMs }),
      },
      { event: 'budget.exhausted', query: 'resource-status' },
    ])
    log('INFO', 'systembus_bridge_ready')

    // EventBus v2: 启用事件持久化
    const store = new EventStore()
    store
      .init()
      .then(() => {
        eventBus.enablePersistence(store)
        log('INFO', 'event_persistence_enabled')
      })
      .catch(() => {})

    setUpdateWindow(win)
    initUpdater()

    // === Stage 7: 延迟服务 ===
    this.lazyInit = new LazyServiceGroup()
    this.registerLazyServices(
      agentService,
      llmService,
      memoryService,
      memoryIndexer,
      stateManager,
      planManager,
      cognitiveService,
      evolutionRef,
      dashboardRef,
    )

    // 注册 Telegram outbox worker（在 taskRunner 启动前注册，start 后生效）
    const outboxUrl =
      credentialsManager.get('telegram_server_url') || process.env.TELEGRAM_SERVER_URL || 'https://skills.crlkcloud.cyou/telegram'
    const outboxWorker = new OutboxWorker(outboxUrl)
    this.taskRunner.register('telegram.outbox', () => outboxWorker.tick(), 2000, { cooldownMs: 10000 })
    // 当 TelegramService 写入新 outbox 消息时，自动恢复被禁用的 outbox 任务
    telegramService.setReactivateOutbox(() => {
      this.taskRunner?.reactivate('telegram.outbox')
    })

    // 社交平台自动发布（每分钟检查 content_calendar.yaml）
    const socialDir = join(WORKSPACE.evolution, 'social')
    this.taskRunner.register(
      'social.tick',
      async (): Promise<TaskExecutionResult> => {
        try {
          const { exec } = require('child_process')
          const { promisify } = require('util')
          const asyncExec = promisify(exec)
          const result = await asyncExec(`node "${join(socialDir, 'cli.mjs')}" tick`, { encoding: 'utf-8', timeout: 30000, cwd: socialDir })
          const data = JSON.parse(result.stdout.trim())
          if (data.posted > 0 || data.errors > 0) {
            log('INFO', 'social_tick', { posted: data.posted, skipped: data.skipped, errors: data.errors })
          }
        } catch (err) {
          log('WARN', 'social_tick_error', { error: String(err) })
        }
        return { success: true }
      },
      60000,
      { cooldownMs: 30000 },
    )

    // Phase 5D: 注入 Task 健康提供者（此时所有 task 已注册）
    this.runtimeHealthManager?.setTaskHealthProvider(this.taskRunner)

    // 启动！
    this.lazyInit.start()
    this.taskRunner.start()
    log('INFO', 'task_runtime_started')

    // === Stage 8: GPU ASR（异步） ===
    this.initGpuAsync(stateManager, gpuEngine, asrService)

    // === Stage 9: 窗口激活监听 ===
    app.on('activate', async () => {
      try {
        const { BrowserWindow } = await import('electron')
        if (BrowserWindow.getAllWindows().length === 0) createWindow(stateManager)
      } catch (err) {
        log('ERROR', 'activate_failed', { error: String(err) })
      }
    })

    // === before-quit ===
    app.on('before-quit', () => {
      this.shutdown()
      destroyTray()
    })
    app.on('window-all-closed', () => {
      // 关闭窗口时隐藏到托盘，不退出进程
      if (process.platform !== 'darwin') {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.hide()
        }
      }
    })
  }

  private async shutdown(): Promise<void> {
    // Phase 5D: 停止运行时健康管理器
    await this.runtimeHealthManager?.stop().catch(() => {})

    // Phase 4: Agent OS 生命周期 — 反向停止
    await this.sessionGovernor?.stop().catch(() => {})
    await this.healthChecker?.stop().catch(() => {})
    await this.processManager?.stop().catch(() => {})
    await this.workerPool?.stop().catch(() => {})
    const kernel = Kernel.getInstance()
    await kernel.stop().catch(() => {})

    // 保存恢复检查点（同步写文件确保在进程退出前完成）
    if (this.agentServiceRef) {
      try {
        this.agentServiceRef.saveRecoverySnapshot('shutdown')
      } catch (err) {
        log('WARN', 'shutdown_checkpoint_failed', { error: String(err) })
      }
    }
    this.taskRunner?.stop()
    await this.comfyUI?.stop().catch(() => {})
    this.toolEventBridge?.stop()
    await this.evaluationStore?.shutdown().catch(() => {})
    this.memoryService?.shutdown()
    this.memoryIndexer?.stop()
    await this.evaluationStore?.shutdown().catch(() => {})
    evolutionService?.stop()
    insightService?.stop()
    creativityService?.stop()
    this.dashboardService?.destroy()
    this.lazyInit?.cancel()
    this.subs.dispose()
    closeDatabase()
    log('INFO', 'memory_flushed_on_quit')
  }

  private registerCoreEventBus(): void {
    eventBus.track('agent.tool.invoked', (p: any) => log('INFO', 'tool_start', { tool: p.tool }), this.subs, 'runtime:tool_invoked')
    eventBus.track('agent.tool.completed', (p: any) => log('INFO', 'tool_success', { tool: p.tool }), this.subs, 'runtime:tool_completed')
    eventBus.track(
      'agent.tool.failed',
      (p: any) => log('WARN', 'tool_error', { tool: p.tool, error: p.error }),
      this.subs,
      'runtime:tool_failed',
    )
    eventBus.track(
      'agent.input.received',
      (p: any) => log('CHAT', 'agent_input', { request_id: p.requestId, text: sanitizeForLog(p.text) }),
      this.subs,
      'runtime:agent_input',
    )
    eventBus.track(
      'agent.response.generated',
      (p: any) => log('CHAT', 'agent_output', { request_id: p.requestId, reply_len: p.text.length }),
      this.subs,
      'runtime:agent_output',
    )
    eventBus.track(
      'agent.plan.created',
      (p: any) => log('INFO', 'plan_created', { plan_id: p.planId, title: p.title }),
      this.subs,
      'runtime:plan_created',
    )
    eventBus.track(
      'agent.plan.step',
      (p: any) => log('INFO', 'plan_step', { plan_id: p.planId, step: p.stepIndex, status: p.status }),
      this.subs,
      'runtime:plan_step',
    )
    eventBus.track('agent.plan.completed', (p: any) => log('INFO', 'plan_done', { plan_id: p.planId }), this.subs, 'runtime:plan_completed')
    eventBus.track('evolution.cycle.started', () => log('INFO', 'evolution_cycle_start'), this.subs, 'runtime:evolution_start')
    eventBus.track(
      'evolution.cycle.completed',
      (p: any) => log('INFO', 'evolution_cycle_end', { success: p.success }),
      this.subs,
      'runtime:evolution_done',
    )
    eventBus.track(
      'recovery.checkpoint.created',
      (p: any) => log('INFO', 'checkpoint_created', { runId: p.runId, trigger: p.trigger }),
      this.subs,
      'runtime:checkpoint',
    )
    eventBus.track(
      'recovery.session.restored',
      (p: any) => log('INFO', 'session_restored', { runId: p.runId, hasPlan: p.hasUnfinishedPlan }),
      this.subs,
      'runtime:session_restored',
    )
    eventBus.track(
      'recovery.error.classified',
      (p: any) => log('INFO', 'error_classified', { category: p.category, strategy: p.strategy }),
      this.subs,
      'runtime:error_classified',
    )
    eventBus.track(
      'recovery.context.compress',
      (p: any) => log('INFO', 'context_compressed', { before: p.beforeTokens, after: p.afterTokens }),
      this.subs,
      'runtime:context_compress',
    )
  }

  private registerLazyServices(
    agentService: AgentService,
    llmService: LlmService,
    memoryService: MemoryService,
    memoryIndexer: MemoryIndexer,
    stateManager: StateManager,
    planManager: any,
    cognitiveService: CognitiveService,
    evolutionRef?: { current: SelfEvolutionService | null },
    dashboardRef?: { current: EvolutionDashboardService | null },
  ): void {
    // 进化服务
    this.lazyInit!.add({
      name: 'evolution',
      priority: 'normal',
      delayMs: 200,
      fn: async () => {
        const evolution = initEvolution(agentService)
        evolution.setSafetyMode('auto')
        // 注册 Evolution 内核模块
        const evolutionModule = new EvolutionModule(evolution)
        const kernel = Kernel.getInstance()
        await kernel.registerModule(evolutionModule)
        // 初始化自动化管道（Collectors → ProblemQueue → Claude Code CLI）
        const pipeline = new PipelineOrchestrator({
          projectRoot: process.cwd(),
          persistDir: join(WORKSPACE.evolution, 'pipeline_data'),
          maxFixesPerCycle: 3,
        })
        // 注册基础 collector 和 executor（先不传 mcpManager，备用执行器延迟注入）
        pipeline.initDefaults()
        // 注册记忆分析采集器（从对话记录中检测用户不满意模式）
        pipeline.addCollector(new MemoryAnalysisCollector())
        // 附加到进化系统（SelfEvolutionService 将消费管道指标）
        evolution.setPipeline(pipeline)
        this.pipeline = pipeline
        evolution.scheduleEvolution(2)
        if (evolutionRef) evolutionRef.current = evolution
        log('INFO', 'evolution_service_started', { interval_hours: 2 })
      },
    })

    // 记忆索引
    this.lazyInit!.add({
      name: 'memory-indexer',
      priority: 'normal',
      delayMs: 500,
      fn: async () => {
        memoryIndexer.start()
        log('INFO', 'memory_indexer_service_started')
      },
    })

    // 洞察
    this.lazyInit!.add({
      name: 'insight',
      priority: 'normal',
      delayMs: 400,
      fn: async () => {
        const insight = initInsight(
          join(WORKSPACE.cache, 'insights.json'),
          {
            getMemoryEntries: () => memoryService.getEntries().map((e) => ({ type: e.type, content: e.content, createdAt: e.createdAt })),
            getSummaries: () => memoryService.summary.getRecent(20),
            getInteractionCount: () => memoryService.getInteractionCount(),
            getPlans: () => {
              try {
                return planManager
                  .listPlans()
                  .map((p: any) => ({ title: p.title, status: p.status, updatedAt: p.updatedAt, steps: p.steps, createdAt: p.createdAt }))
              } catch {
                return []
              }
            },
          },
          { chatJson: llmService.chatJson.bind(llmService) },
          this.taskRunner,
        )
        insight.start()
        log('INFO', 'insight_service_started')
      },
    })

    // 创造力
    this.lazyInit!.add({
      name: 'creativity',
      priority: 'normal',
      delayMs: 600,
      fn: async () => {
        const creativity = initCreativity(
          join(WORKSPACE.cache, 'creativity.json'),
          {
            getSources: () => this.buildCreativitySources(memoryService, planManager),
            getInsights: () => {
              try {
                if (!insightStore) return []
                return insightStore
                  .getUnreported()
                  .slice(0, 10)
                  .map((i: any) => ({ title: i.title, description: i.description, score: i.score }))
              } catch {
                return []
              }
            },
            getFailedHypotheses: () => {
              const store = creativityService?.getStore()
              if (!store) return []
              return store.getHypotheses({ status: 'rejected' }).map((h: any) => ({ title: h.title, idea: h.idea, risk: h.risk }))
            },
          },
          llmService.chatJson.bind(llmService),
          0.3,
          join(WORKSPACE.evolution, 'creativity', 'reports'),
          this.taskRunner,
          join(WORKSPACE.evolution, 'observer'),
          llmService.chatJsonWithCode.bind(llmService),
        )
        creativity.start()
        // 注册创意采集器和执行器到管道
        if (this.pipeline) {
          this.pipeline.addCollector(new CreativityCollector())
          this.pipeline.addExecutor(new CreativityExecutor())
          log('INFO', 'creativity_pipeline_wired')
        }
        log('INFO', 'creativity_service_started')
      },
    })

    // 灵感
    this.lazyInit!.add({
      name: 'inspiration',
      priority: 'background',
      fn: async () => {
        const inspiration = initInspiration(join(WORKSPACE.evolution, 'inspiration'), process.env.GITHUB_TOKEN)
        inspiration.refresh().catch(() => {})
        log('INFO', 'inspiration_service_started')
      },
    })

    // Observer (worker isolation)
    this.lazyInit!.add({
      name: 'observer',
      priority: 'background',
      delayMs: 5000,
      fn: async () => {
        if (!this.workerPool) return
        try {
          await this.workerPool.sendTaskAndWait('observer', 'init', { baseDir: join(WORKSPACE.evolution, 'observer') }, 10_000)
          const llmResult: any = await this.workerPool.sendTaskAndWait('observer', 'initLlm', null, 15_000)
          if (llmResult?.loaded) {
            await this.workerPool.sendTaskAndWait('observer', 'start', null, 5_000)
            log('INFO', 'observer_service_started')
          } else {
            log('WARN', 'observer_service_skipped', { reason: 'model load failed' })
          }
        } catch (err: any) {
          log('WARN', 'observer_service_worker_failed', { error: err.message })
        }
      },
    })

    // 插件监听
    this.lazyInit!.add({
      name: 'plugin-watcher',
      priority: 'background',
      fn: async () => {
        this.pluginLoader?.startWatching()
        log('INFO', 'plugin_watcher_started')
      },
    })

    // Sleep Cycle
    this.lazyInit!.add({
      name: 'sleep-cycle',
      priority: 'background',
      delayMs: 120_000,
      fn: async () => {
        setInterval(() => agentService.sleepCycle.run(() => agentService.isBusy()), 2 * 60 * 60 * 1000)
        log('INFO', 'sleep_cycle_service_started', { interval_hours: 2 })
      },
    })

    // 进化仪表盘 — 在桌面右下角展示进化状态卡片
    this.lazyInit!.add({
      name: 'evolution-dashboard',
      priority: 'normal',
      delayMs: 100,
      fn: async () => {
        const dashboard = new EvolutionDashboardService()
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          dashboard.setWindow(win)
        }
        if (dashboardRef) dashboardRef.current = dashboard
        this.dashboardService = dashboard
        // 托盘切换回调
        setDashboardToggle(() => {
          const d = dashboardRef?.current
          if (d) d.toggleVisibility()
        })
        // 交互情境语音 自动/手动 模式切换回调
        setContextualTtsToggle(() => {
          const chatExec = agentService.getChatExecutor()
          if (chatExec) {
            const currentState = chatExec.getContextualTtsState()
            chatExec.toggleContextualTts(!currentState.enabled)
          }
        })
        log('INFO', 'evolution_dashboard_started')
      },
    })

    // 壁纸监听
    this.lazyInit!.add({
      name: 'wallpaper-listener',
      priority: 'background',
      delayMs: 3000,
      fn: async () => {
        setupWallpaperListener(stateManager)
      },
    })

    // UUMit 平台对接（延迟启动，等核心服务就绪）
    this.lazyInit!.add({
      name: 'uumit',
      priority: 'normal',
      delayMs: 5000,
      fn: async () => {
        const uumit = new UumitService(agentService)
        await uumit.initialize()
        await uumit.start()
        log('INFO', 'uumit_service_started')
      },
    })

    // ComfyUI 本地生图引擎
    this.lazyInit!.add({
      name: 'comfyui',
      priority: 'background',
      delayMs: 8000,
      fn: async () => {
        this.comfyUI = new ComfyUIManager()
        setImageToolComfyUI(this.comfyUI)
        await this.comfyUI.start()
        if (this.comfyUI.isReady) {
          log('INFO', 'comfyui_service_ready', { port: 8188 })
        }
      },
    })

    // EventBus 日志订阅
    this.lazyInit!.add({
      name: 'eventbus-log-subs',
      priority: 'normal',
      delayMs: 100,
      fn: async () => {
        // MetricsEngine 定时计算（每 10 分钟汇总一次）
        this.metricsEngine = new MetricsEngineImpl(new RepositoryEventIterator(this.evaluationStore!))
        this.taskRunner!.register(
          'evaluation.metrics',
          async () => {
            const until = Date.now()
            const since = until - 600_000 // 10 分钟窗口
            const snapshot = await this.metricsEngine!.compute({ since, until })
            log('INFO', 'eval_metrics', {
              calls: snapshot.traffic.totalCalls,
              rate: Math.round(snapshot.quality.completionRate * 100),
              avgMs: Math.round(snapshot.latency.avgMs),
              tokens: snapshot.cost.totalTokens,
            })
            return { success: true }
          },
          600_000,
        )
        eventBus.track(
          'insight.detector.completed',
          (p: any) => log('INFO', 'insight_detector', { detector: p.detector, findings: p.findings }),
          this.subs,
          'runtime:insight_detector',
        )
        eventBus.track(
          'insight.candidate.generated',
          (p: any) => log('INFO', 'insight_candidates', { count: p.count }),
          this.subs,
          'runtime:insight_candidates',
        )
        eventBus.track(
          'insight.found',
          (p: any) => log('INFO', 'insight_found', { count: p.count, top: p.insights?.[0]?.title }),
          this.subs,
          'runtime:insight_found',
        )
        eventBus.track(
          'insight.analysis.completed',
          (p: any) => log('INFO', 'insight_analysis_end', { count: p.count, hasValue: p.hasValue }),
          this.subs,
          'runtime:insight_analysis',
        )
        eventBus.track('creativity.cycle.started', () => log('INFO', 'creativity_cycle_start'), this.subs, 'runtime:creativity_start')
        eventBus.track(
          'creativity.ideas.generated',
          (p: any) => log('INFO', 'creativity_ideas', { count: p.count, top: p.ideas?.[0]?.title, novelty: p.ideas?.[0]?.novelty }),
          this.subs,
          'runtime:creativity_ideas',
        )
        eventBus.track(
          'creativity.dream.completed',
          (p: any) => log('INFO', 'creativity_dream_end', { count: p.count, top_novelty: p.topNovelty }),
          this.subs,
          'runtime:creativity_dream',
        )

        // MetricsEngine 定时计算（10 分钟窗口）
        this.metricsEngine = new MetricsEngineImpl(new RepositoryEventIterator(this.evaluationStore!))
        this.taskRunner!.register(
          'evaluation.metrics',
          async () => {
            const until = Date.now()
            const since = until - 600_000
            const snapshot = await this.metricsEngine!.compute({ since, until })
            log('INFO', 'eval_metrics', {
              calls: snapshot.traffic.totalCalls,
              rate: Math.round(snapshot.quality.completionRate * 100),
              avgMs: Math.round(snapshot.latency.avgMs),
              tokens: snapshot.cost.totalTokens,
            })
            return { success: true }
          },
          600_000,
        )

        // ── Chain: Evolution → Observer pipeline ──
        // Evolution 产出有效计划后，立即触发 Observer pipeline 而非等 4h 定时
        eventBus.track(
          'evolution.cycle.completed',
          async (p: any) => {
            if (p.success && p.planCreated && this.workerPool?.isActive('observer') && !this.workerPool.isBusy('observer')) {
              log('INFO', 'chain_evolution_to_observer', { planSummary: p.summary?.slice(0, 80) })
              try {
                const result = await this.workerPool.sendTaskAndWait('observer', 'pipeline', { mode: 'analytical' }, 180_000)
                if (result) {
                  log('INFO', 'chain_observer_insight_from_evolution', { topic: result.payload?.topic })
                }
              } catch (err: any) {
                log('WARN', 'chain_observer_pipeline_failed', { error: err.message })
              }
            }
          },
          this.subs,
          'runtime:chain_evolution_to_observer',
        )

        // ── Chain: Observer pipeline → Creativity nudge ──
        // Observer 完成 insight 产出后（通过 WorkerPool 回调不可观测），
        // 此链由 creatority.cycle.completed 隐含覆盖：
        // CreativityService.WorldTrendProvider 自动读取 Observer store，
        // 下一个 Creativity 周期即包含最新趋势。
        // 这里只做监控日志，验证链式工作在运行。
        log('INFO', 'chain_service_triggers_ready', {
          evolution_to_observer: true,
        })
      },
    })
  }

  private logModelConfig(llmKey?: string): void {
    log('INFO', 'model_config', {
      asr_model: 'whisper_gpu (Vulkan)',
      gpu: 'RTX 3060',
      vad: true,
      streaming: true,
      hotwords: INITIAL_HOTWORDS,
      chat_model: 'deepseek-chat (OpenCode Go)',
      code_model: 'deepseek-v4-flash (OpenCode Go)',
      key_configured: !!llmKey,
    })
  }

  private buildCreativitySources(memoryService: MemoryService, pm: any): any[] {
    const recentTopics: string[] = []
    const entryCount = 0
    const interactionCount = memoryService?.getInteractionCount?.() || 0

    const sources: any[] = [
      {
        name: 'Memory',
        content: `对话记忆：${entryCount || 0} 条记录，最近话题 ${recentTopics.slice(0, 3).join('、') || '无'}`,
        type: 'knowledge',
        weight: 0.9,
      },
      { name: 'MCP', content: '工具调用框架：多工具集成、动态附件、实时响应', type: 'knowledge', weight: 0.8 },
      { name: 'ASR', content: '语音识别：中英文语音输入、实时转写、领域词表', type: 'knowledge', weight: 0.7 },
      { name: 'TTS', content: '语音合成：多音色选择、情感语调可控、低延迟', type: 'knowledge', weight: 0.7 },
      { name: 'Agent', content: 'Agent 服务：多轮对话、工具调用、任务编排', type: 'knowledge', weight: 0.9 },
      {
        name: 'Evolution',
        content: '自进化系统：代码分析与修改、计划执行、2 小时周期',
        type: 'knowledge',
        weight: 0.8,
      },
      { name: 'Wallpaper', content: '桌面壁纸：半透明 Overlay、系统托盘、鼠标穿透', type: 'knowledge', weight: 0.5 },
      { name: 'PiperTTS', content: '本地 TTS：离线合成、低延迟、多模型切换', type: 'knowledge', weight: 0.5 },
      {
        name: 'UserBehavior',
        content: `最近交互 ${interactionCount} 次${recentTopics.length > 0 ? `，活跃话题: ${recentTopics.slice(0, 3).join('、')}` : ''}`,
        type: 'behavior',
        weight: 0.7,
      },
    ]
    try {
      const plans = pm.listPlans()
      if (plans.length > 0) {
        const plan = plans[0]
        sources.push({ name: `Plan:${plan.title}`, content: plan.description, type: 'behavior', weight: 0.3 })
      }
    } catch {}
    return sources
  }

  private initGpuAsync(stateManager: StateManager, gpuEngine: WhisperGpuEngine, asrService: AsrService): void {
    stateManager.update({ asr: 'loading', model: 'whisper_gpu (Vulkan)' })
    this.gpuInitTimeout = setTimeout(() => {
      log('WARN', 'gpu_asr_init_timeout')
      const baiduKey = credentialsManager.get('baidu_asr_api_key') || process.env.BAIDU_ASR_API_KEY
      const baiduSecret = credentialsManager.get('baidu_asr_secret_key') || process.env.BAIDU_ASR_SECRET_KEY
      if (baiduKey && baiduSecret) {
        asrService.setBaiduCredentials(baiduKey, baiduSecret)
        log('INFO', 'baidu_asr_ready_timeout_fallback')
        stateManager.update({ asr: 'ready', model: 'baidu_asr (fallback)' })
      } else {
        stateManager.update({ error: 'GPU ASR 加载超时，未配置百度备用' })
      }
    }, 30000)

    gpuEngine
      .initialize('small')
      .then(() => {
        if (this.gpuInitTimeout) {
          clearTimeout(this.gpuInitTimeout)
          this.gpuInitTimeout = null
        }
        log('INFO', 'gpu_asr_ready')
        stateManager.update({ asr: 'ready', model: 'whisper_gpu (Vulkan)' })
      })
      .catch((err) => {
        if (this.gpuInitTimeout) {
          clearTimeout(this.gpuInitTimeout)
          this.gpuInitTimeout = null
        }
        log('WARN', 'gpu_asr_fallback', { error: String(err) })
        const baiduKey = credentialsManager.get('baidu_asr_api_key') || process.env.BAIDU_ASR_API_KEY
        const baiduSecret = credentialsManager.get('baidu_asr_secret_key') || process.env.BAIDU_ASR_SECRET_KEY
        if (baiduKey && baiduSecret) {
          asrService.setBaiduCredentials(baiduKey, baiduSecret)
          log('INFO', 'baidu_asr_ready')
          stateManager.update({ asr: 'ready', model: 'baidu_asr (fallback)' })
        } else {
          stateManager.update({ error: 'GPU ASR 加载失败，未配置百度备用' })
        }
      })
  }
}
