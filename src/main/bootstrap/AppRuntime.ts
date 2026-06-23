import { app } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
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
import {
  initEvolution,
  evolutionService,
  planManager,
  SelfEvolutionService,
  ProposalValidator,
  EvolutionGitOps,
  RollbackLevel,
  setSandboxRoot,
} from '../evolution'
import { VerificationRunner } from '../evolution/VerificationRunner'
import { RegressionDetector } from '../evolution/RegressionDetector'
import { initInsight, insightService, insightStore } from '../insight'
import { initCreativity, creativityService } from '../creativity'
import { initInspiration } from '../inspiration'
import { setMemoryService } from '../mcp/LocalProvider'
import { setPlanManager, setCredentialsManager, setSkillManager as setToolSkillManager } from '../tool/deps'
import { PluginLoader, toolRegistry } from '../plugin'
import { SkillManager, setSkillManager as setSkillManagerSingleton } from '../skill'
import { loadEnvFile, setupTransformers } from '../core/ModelLoader'
import { setupStartupLogging, createWindow, setupWallpaperListener } from '../core/Lifecycle'
import { initUpdater, setUpdateWindow } from '../updater/UpdaterService'
import { initDatabase, closeDatabase } from '../db/connection'
import { ConstitutionEngine } from '../constitution'
import { CapabilityEngine, freezeDefaults } from '../capability'
import { CognitiveService } from '../cognitive'
import { AuditTrail } from '../plugin/AuditTrail'
import { MemoryIndexer } from '../memory/MemoryIndexer'
import { Kernel } from '../core/Kernel'
import { WorkerPool } from '../core/WorkerPool'
import { SessionGovernor } from '../governance'
import { CheckpointV2 } from '../governance'
import { systemBus } from '../core/SystemBus'
import { SyscallBus, HealthChecker } from '../core/lifecycle/index'
import type { IModule, SubsystemState } from '../core/lifecycle/types'
import { TelegramService } from '../telegram/TelegramService'
import { OutboxWorker } from '../telegram/OutboxWorker'
import { UumitService } from '../uumit/index'
import { TaskRunner } from '../core/tasks/unified/TaskRunner'
import { MetricsCollector } from '../observability/MetricsCollector'
import { SystemStabilityScore } from '../observability/SystemStabilityScore'
import { ResourceBudget } from '../core/ResourceBudget'
import { BudgetRebalancer } from '../core/BudgetRebalancer'
import { LazyServiceGroup } from './LazyServiceGroup'
import { SessionRecoveryManager } from '../agent/SessionRecoveryManager'
import { EventStore } from '../core/event-sourcing/EventStore'

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
  private pluginLoader?: PluginLoader
  private agentServiceRef?: AgentService
  private crashGuard: { flushMemory: (() => void) | null }
  private resourceBudget?: ResourceBudget
  private metricsCollector?: MetricsCollector
  private stabilityScore?: SystemStabilityScore
  private proposalValidator?: ProposalValidator
  private gitOps?: EvolutionGitOps
  private syscallBus?: SyscallBus
  private healthChecker?: HealthChecker
  private capabilityEngine?: CapabilityEngine
  private sessionGovernor?: SessionGovernor
  private checkpointV2?: CheckpointV2

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
      const pwMcpPath = require.resolve('@playwright/mcp')
      mcpManager
        .addServer({
          name: 'playwright',
          transport: 'stdio',
          command: 'node',
          args: [pwMcpPath, '--headless'],
        })
        .catch((err) => log('WARN', 'playwright_mcp_start_failed', { error: String(err) }))
    } catch {
      log('WARN', 'playwright_mcp_not_found')
    }

    const llmService = new LlmService(mcpManager)
    const gpuEngine = new WhisperGpuEngine()
    const baiduEngine = new BaiduEngine()
    const asrService = new AsrService(gpuEngine, baiduEngine)

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

    // Phase 1-3: 基础设施实例化
    this.resourceBudget = new ResourceBudget()
    this.stabilityScore = new SystemStabilityScore()
    this.metricsCollector = new MetricsCollector()
    this.proposalValidator = new ProposalValidator()
    this.gitOps = new EvolutionGitOps()

    const ttsService = new TtsService((state) => stateManager.update(state))
    const agentService = new AgentService(llmService, asrService, ttsService, eventBus, mcpManager)
    this.agentServiceRef = agentService
    const recoveryManager = new SessionRecoveryManager(join(WORKSPACE.evolution, 'recovery'))
    agentService.setRecoveryManager(recoveryManager)
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

    const win = createWindow(stateManager)
    agentService.setMainWindow(win)
    ttsService.setAudioSink((filePath) => {
      try {
        win.webContents.send('tts:play_audio_buffer', readFileSync(filePath))
      } catch {
        win.webContents.send('tts:play_audio', filePath)
      }
    })

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

    // Phase 4: WorkerPool — 后台工作线程池（ISubsystem，独立生命周期）
    await this.workerPool!.init()

    // Phase 4: SessionGovernor — 会话级健康治理
    this.sessionGovernor = new SessionGovernor()
    this.sessionGovernor.setStateManager(stateManager)
    await this.sessionGovernor.init()

    // Phase 4: CheckpointV2 — 带健康验证的检查点
    this.checkpointV2 = new CheckpointV2(join(WORKSPACE.evolution, 'recovery'), recoveryManager)
    this.checkpointV2.setHealthScorer(this.sessionGovernor.scorer)

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
    registerHandlers(agentService, stateManager, ttsService, evolutionRef)

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
    log('INFO', 'workerpool_ready', { workers: ['memory-indexer', 'verification', 'observer'] })
    log('INFO', 'health_checker_started')

    // === Stage 6: Task Runtime & Memory Indexer ===
    this.taskRunner = new TaskRunner()

    // 注册 stability.tick 到 TaskRunner（原 TaskScheduler 已弃用）
    let previousStabilityStatus: string | undefined
    this.taskRunner.register(
      'stability.tick' as any,
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
    log('INFO', 'cognitive_service_ready', {
      goals: cognitiveService.goals.getActiveGoals().length,
      tokenBalance: cognitiveService.tokenAccount.getBalance(),
    })

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
    this.registerLazyServices(agentService, llmService, memoryService, memoryIndexer, stateManager, planManager, cognitiveService)

    // 注册 Telegram outbox worker（在 taskRunner 启动前注册，start 后生效）
    const outboxUrl =
      credentialsManager.get('telegram_server_url') || process.env.TELEGRAM_SERVER_URL || 'https://skills.crlkcloud.cyou/telegram'
    const outboxWorker = new OutboxWorker(outboxUrl)
    this.taskRunner.register('telegram.outbox', () => outboxWorker.tick(), 2000, { cooldownMs: 10000 })

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
    app.on('before-quit', () => this.shutdown())
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })
  }

  private async shutdown(): Promise<void> {
    // Phase 4: Agent OS 生命周期 — 反向停止
    await this.sessionGovernor?.stop().catch(() => {})
    await this.healthChecker?.stop().catch(() => {})
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
    this.memoryService?.shutdown()
    this.memoryIndexer?.stop()
    evolutionService?.stop()
    insightService?.stop()
    creativityService?.stop()
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
  ): void {
    // 进化服务
    this.lazyInit!.add({
      name: 'evolution',
      priority: 'normal',
      delayMs: 200,
      fn: async () => {
        const evolution = initEvolution(agentService)
        const verifier = new VerificationRunner()
        verifier.setWorkerPool(this.workerPool!)
        evolution.setVerificationRunner(verifier, true)
        evolution.setRegressionDetector(new RegressionDetector())
        evolution.setCognitiveService(cognitiveService)
        evolution.setSafetyMode('auto')
        evolution.setGitOps(this.gitOps)
        evolution.setProposalValidator(this.proposalValidator)
        // 设置 sandbox 产物验证根目录
        setSandboxRoot(join(WORKSPACE.evolution, 'sandbox'))
        evolution.scheduleEvolution(2)
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
        )
        creativity.start()
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

    // EventBus 日志订阅
    this.lazyInit!.add({
      name: 'eventbus-log-subs',
      priority: 'normal',
      delayMs: 100,
      fn: async () => {
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
    const sources: any[] = [
      { name: 'Memory', content: '对话记忆系统', type: 'knowledge', weight: 0.9 },
      { name: 'MCP', content: '工具调用框架', type: 'knowledge', weight: 0.8 },
      { name: 'ASR', content: '语音识别', type: 'knowledge', weight: 0.7 },
      { name: 'TTS', content: '语音合成', type: 'knowledge', weight: 0.7 },
      { name: 'Agent', content: 'Agent 服务', type: 'knowledge', weight: 0.9 },
      { name: 'Evolution', content: '自进化系统', type: 'knowledge', weight: 0.8 },
      { name: 'Wallpaper', content: '桌面壁纸集成', type: 'knowledge', weight: 0.5 },
      { name: 'PiperTTS', content: '本地 TTS', type: 'knowledge', weight: 0.5 },
      { name: 'UserBehavior', content: `最近交互 ${memoryService?.getInteractionCount() || 0} 次`, type: 'behavior', weight: 0.7 },
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
      const baiduKey = process.env.BAIDU_ASR_API_KEY
      const baiduSecret = process.env.BAIDU_ASR_SECRET_KEY
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
        const baiduKey = process.env.BAIDU_ASR_API_KEY
        const baiduSecret = process.env.BAIDU_ASR_SECRET_KEY
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
