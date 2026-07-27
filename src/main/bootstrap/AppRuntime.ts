import { app } from 'electron'
import { join, dirname } from 'path'
import { promises as fsp, readFileSync } from 'fs'
import { log, initLogFile, getLogFilePath, sanitizeForLog } from '../logger/Logger'
import { StateManager } from '../core/StateManager'
import { eventBus, SubscriptionTracker } from '../core/EventBus'
import {
  INITIAL_HOTWORDS,
  WORKSPACE,
  WORKSPACE_ROOT,
  RUNTIME_ROOT,
  TELEGRAM_SERVER_URL,
  TELEGRAM_POLL_INTERVAL_MS,
  TELEGRAM_OUTBOX_COOLDOWN_MS,
  TELEGRAM_ENABLED,
} from '../config'
import { ServerManager } from '../mcp/ServerManager'
import { mcpRegistry } from '../mcp/MCPRegistry'
import { LlmService } from '../llm/LlmService'
import { WhisperGpuEngine } from '../asr/WhisperGpuEngine'
import { BaiduEngine } from '../asr/BaiduEngine'
import { AsrService } from '../asr/AsrService'
import { asrEvolutionManager } from '../asr/AsrEvolutionManager'
import { TtsService } from '../tts/TtsService'
import { piperOrchestrator } from '../tts/PiperOrchestrator'
import { piperTtsEnvironmentMonitor } from '../tts/PiperTtsEnvironmentMonitor'
import { engineProvider } from '../engine'
import { ttsScheduler } from '../tts/TtsScheduler'
import { ttsTypographyFeedbackLoop } from '../tts/TtsTypographyFeedbackLoop'
import { voiceRoleManager } from '../tts/VoiceRoleManager'
import { AgentService } from '../agent/AgentService'
import { sleepOrchestrator } from '../agent/SleepOrchestrator'
import { MemoryService } from '../memory/MemoryService'
import { VoiceBookmarkService } from '../memory/VoiceBookmarkService'
import { memoryEvolutionBridge } from '../memory/MemoryEvolutionBridge'
import { memoryTtsBridge } from '../tts/MemoryTtsBridge'
import { registerHandlers, createServiceRef } from '../ipc/handlers'
import type { ServiceRef } from '../ipc/handlers'
import { credentialsManager } from '../credentials/CredentialsManager'
import { initEvolution, evolutionService, planManager, SelfEvolutionService } from '../evolution'
import { PipelineOrchestrator, CreativityCollector, CreativityExecutor, MemoryAnalysisCollector, ExecutionPolicy } from '../evolution/automation'
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
import { initTray, destroyTray, setDashboardToggle, setContextualTtsToggle, setUserContextOverride, setOrganizerPause, setOrganizerResume, setOrganizerSkip, setSubtitleToggle, setVoiceRoleSchemeSwitch, setTaskPanelToggle, setVoiceNoteToggle, setVoiceNoteSave, setEnginePreferenceToggle, updateEnginePreference } from '../core/TrayManager'
import { initUpdater, setUpdateWindow } from '../updater/UpdaterService'
import { EvolutionDashboardService, MemoryContextService, ConversationContextService, FileOrganizerProgressService } from '../wallpaper/WallpaperService'
import { TaskPanelService } from '../wallpaper/TaskPanelService'
import { WallpaperInteractiveService } from '../wallpaper/WallpaperInteractiveService'
import { VoiceNoteService } from '../voicenote/VoiceNoteService'
import { MonitoringService } from '../monitoring/MonitoringService'
import { WallpaperEventBridge } from '../wallpaper/WallpaperEventBridge'
import { initDatabase, closeDatabase, getRawDb, getEventRawDb } from '../db/connection'
import { ConstitutionEngine } from '../constitution'
import { CapabilityEngine, freezeDefaults, CapabilityCatalog, CapabilityResolver, CapabilityServiceImpl, CapabilitySchemaAdapter, CapabilityFunctionSchemaAdapter } from '../capability'
import { setCapabilityAdapter } from '../agent/context'
import { ToolSchemaProvider, ToolInvocationRouter } from '../tool'
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
import { EventArchiver } from '../core/evaluation/EventArchiver'
import { RetentionScheduler } from '../core/evaluation/RetentionScheduler'
import { UIBridge } from '../agent/UIBridge'
import { EventStore } from '../core/event-sourcing/EventStore'
import { RuntimeHealthManager } from '../health/RuntimeHealthManager'
import { EvaluationStore } from '../core/evaluation/EvaluationStore'
import { EvaluationEmitter } from '../core/evaluation/EvaluationEmitter'
import { RepositoryEventIterator } from '../core/evaluation/RepositoryEventIterator'
import { MetricsEngineImpl } from '../core/evaluation/MetricsEngine'
import { ToolEventBridge } from '../core/evaluation/ToolEventBridge'
import { GuardrailPipeline } from '../core/evaluation/GuardrailPipeline'
import { GuardrailProgressConsumer } from '../core/evaluation/progress-consumers/GuardrailProgressConsumer'
import { GuardrailConfigStore } from '../core/evaluation/GuardrailConfigStore'
import { GuardrailDecisionStore } from '../core/evaluation/GuardrailDecisionStore'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from '../core/evaluation/GuardrailTypes'
import { ProgressObserver } from '../core/evaluation/ProgressObserver'
import { GuardrailProgressAnalyzer } from '../core/evaluation/GuardrailProgressAnalyzer'
// ToolEventBridge 已在第 99 行作为值导入，类型自动可用
import type { MetricSnapshot, TimeWindow } from '../core/evaluation/types'
import type { ToolChainOrchestrator, ToolChainDecomposer } from '../orchestrator'
import type { OrchestrationBridge } from '../orchestrator/OrchestrationBridge'

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
  private progressObserver?: ProgressObserver
  private metricsEngine?: MetricsEngineImpl
  private comfyUI?: ComfyUIManager
  private pipeline?: PipelineOrchestrator
  private componentRegistry?: import('../runtime/ComponentRegistry').ComponentRegistryImpl
  private checkpointManager?: import('../runtime/SqliteCheckpointManager').SqliteCheckpointManager
  private runtimeRestoreService?: import('../runtime/RuntimeRestoreService').RuntimeRestoreServiceImpl
  private feedbackLoop?: import('../user-behavior/feedback-loop').MCPFeedbackLoopService
  private dashboardService?: EvolutionDashboardService
  private monitoringService?: MonitoringService
  private memoryContextService?: MemoryContextService
  private memoryContextRef: ServiceRef<MemoryContextService> = createServiceRef<MemoryContextService>()
  private conversationContextService?: ConversationContextService
  private conversationContextRef: ServiceRef<ConversationContextService> = createServiceRef<ConversationContextService>()
  private behaviorMemoryAnalyzer?: import('../behavior/BehaviorDrivenMemoryAnalyzer').BehaviorDrivenMemoryAnalyzer
  private organizerService?: FileOrganizerProgressService
  private organizerRef: ServiceRef<FileOrganizerProgressService> = createServiceRef<FileOrganizerProgressService>()
  private metricsStore?: import('../core/evaluation/GuardrailMetricsStore').GuardrailMetricsStore
  private metricsProjection?: import('../core/evaluation/GuardrailMetricsProjection').GuardrailMetricsProjection
  private metricsQueryRef: ServiceRef<import('../core/evaluation/GuardrailMetricsQueryService').GuardrailMetricsQueryService> =
    createServiceRef()
  private voiceBookmarkRef: ServiceRef<VoiceBookmarkService> = createServiceRef<VoiceBookmarkService>()
  private voiceBookmarkService?: VoiceBookmarkService
  private voiceNoteRef: ServiceRef<VoiceNoteService> = createServiceRef<VoiceNoteService>()
  private voiceNoteService?: VoiceNoteService

  constructor(crashGuard?: { flushMemory: (() => void) | null }) {
    this.crashGuard = crashGuard ?? { flushMemory: null }
  }

  async start(): Promise<void> {
    const startMs = Date.now()

    // === Stage 0: CLI flags & env ===
    setupStartupLogging()
    loadEnvFile()
    setupTransformers()

    const llmKey = process.env.LLM_KEY
    const llmCodeKey = process.env.LLM_CODE_KEY

    // === Stage 1: 核心基础设施 ===
    const stateManager = new StateManager()

    // Phase 4: Agent OS 子进程生命周期管理器 — 必须在 ServerManager 之前创建
    this.processManager = new ProcessManager()
    const mcpManager = new ServerManager(this.processManager)

    // MCP Registry: 启动时加载持久化配置，重建 Capability Catalog
    mcpRegistry.load()
    const capabilityCatalog = new CapabilityCatalog(mcpRegistry)

    // 手动注册 Playwright 和 fanqie-publish 的 manifest
    mcpRegistry.register({
      id: 'playwright',
      name: 'Playwright Browser Automation',
      version: '1.0.0',
      runtime: { command: 'node', args: [] },
      capabilities: ['browser.automation', 'web.scraping'],
      dependencies: [
        { capability: 'browser.automation', tool: 'browser_navigate' },
        { capability: 'web.scraping', tool: 'browser_navigate' },
      ],
      permissions: ['browser'],
    })
    mcpRegistry.register({
      id: 'fanqie-publish',
      name: 'Fanqie Novel Publishing',
      version: '1.0.0',
      runtime: { command: 'node', args: [] },
      capabilities: ['publishing', 'content.drafting'],
      dependencies: [
        { capability: 'publishing', tool: 'publish_novel' },
        { capability: 'content.drafting', tool: 'save_draft' },
      ],
      permissions: ['network.http'],
    })

    // M5.4: File system tools — grouped as file.management
    mcpRegistry.register({
      id: 'file-system', name: 'File System Operations', version: '1.0.0',
      runtime: { command: 'node', args: [] },
      capabilities: ['file.management'],
      capabilitySchemas: {
        'file.management': {
          type: 'object',
          properties: {
            operation: { type: 'string', description: 'Operation to perform: read, write, edit, delete, move, copy, list' },
            path: { type: 'string', description: 'File path relative to workspace root' },
            content: { type: 'string', description: 'File content for write/edit operations' },
          },
          required: ['operation', 'path'],
        },
      },
      dependencies: [
        { capability: 'file.management', tool: 'read_file' },
        { capability: 'file.management', tool: 'write_file' },
        { capability: 'file.management', tool: 'edit_file' },
        { capability: 'file.management', tool: 'delete_file' },
        { capability: 'file.management', tool: 'move_file' },
        { capability: 'file.management', tool: 'copy_file' },
        { capability: 'file.management', tool: 'create_directory' },
        { capability: 'file.management', tool: 'list_files' },
      ],
      permissions: ['file.read', 'file.write'],
    })

    // M5.4: Search engine tools — grouped as search.retrieval
    mcpRegistry.register({
      id: 'search-engine', name: 'Search and Retrieval', version: '1.0.0',
      runtime: { command: 'node', args: [] },
      capabilities: ['search.retrieval'],
      capabilitySchemas: {
        'search.retrieval': {
          type: 'object',
          properties: {
            operation: { type: 'string', description: 'Search operation: grep, glob, web_search, fetch' },
            query: { type: 'string', description: 'Search query, pattern, or URL depending on operation' },
            scope: { type: 'string', description: 'Search scope — file path pattern or domain filter' },
          },
          required: ['operation', 'query'],
        },
      },
      dependencies: [
        { capability: 'search.retrieval', tool: 'grep_search' },
        { capability: 'search.retrieval', tool: 'glob_find' },
        { capability: 'search.retrieval', tool: 'web_search' },
        { capability: 'search.retrieval', tool: 'web_fetch' },
      ],
      permissions: ['file.read', 'network.http'],
    })

    // M5.4: System execution tools — grouped as system.execution
    mcpRegistry.register({
      id: 'system-executor', name: 'System Command Execution', version: '1.0.0',
      runtime: { command: 'node', args: [] },
      capabilities: ['system.execution'],
      capabilitySchemas: {
        'system.execution': {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to execute' },
            cwd: { type: 'string', description: 'Working directory (optional, defaults to workspace root)' },
          },
          required: ['command'],
        },
      },
      dependencies: [
        { capability: 'system.execution', tool: 'run_command' },
        { capability: 'system.execution', tool: 'bash_execute' },
        { capability: 'system.execution', tool: 'execute_python' },
      ],
      permissions: ['shell.execute'],
    })

    capabilityCatalog.rebuild()
    const capabilityResolver = new CapabilityResolver(capabilityCatalog)
    const capabilityService = new CapabilityServiceImpl(capabilityResolver, mcpManager)
    const capabilitySchemaAdapter = new CapabilitySchemaAdapter(capabilityCatalog)
    setCapabilityAdapter(capabilitySchemaAdapter)

    // P1.3a: 创建 capability function schema adapter、tool schema provider、invocation router
    const capabilityFnSchemaAdapter = new CapabilityFunctionSchemaAdapter(capabilityCatalog)
    const toolSchemaProvider = new ToolSchemaProvider(mcpManager, capabilityFnSchemaAdapter)
    const toolInvocationRouter = new ToolInvocationRouter(mcpManager, toolSchemaProvider, capabilityService)

    // P1.3b: 注册 provider adapters（canonical input → provider-specific params）
    import('../capability/adapters').then(({ fanqiePublishAdapter, playwrightAdapter, fileSystemAdapter, searchAdapter, systemAdapter }) => {
      capabilityService.setAdapter('fanqie-publish', 'publish_novel', fanqiePublishAdapter)
      capabilityService.setAdapter('playwright', 'browser_navigate', playwrightAdapter)
      // M5.4: file system adapters
      capabilityService.setAdapter('file-system', 'read_file', fileSystemAdapter)
      capabilityService.setAdapter('file-system', 'write_file', fileSystemAdapter)
      capabilityService.setAdapter('file-system', 'edit_file', fileSystemAdapter)
      capabilityService.setAdapter('file-system', 'delete_file', fileSystemAdapter)
      capabilityService.setAdapter('file-system', 'move_file', fileSystemAdapter)
      capabilityService.setAdapter('file-system', 'copy_file', fileSystemAdapter)
      capabilityService.setAdapter('file-system', 'create_directory', fileSystemAdapter)
      capabilityService.setAdapter('file-system', 'list_files', fileSystemAdapter)
      // M5.4: search adapters
      capabilityService.setAdapter('search-engine', 'grep_search', searchAdapter)
      capabilityService.setAdapter('search-engine', 'glob_find', searchAdapter)
      capabilityService.setAdapter('search-engine', 'web_search', searchAdapter)
      capabilityService.setAdapter('search-engine', 'web_fetch', searchAdapter)
      // M5.4: system adapters
      capabilityService.setAdapter('system-executor', 'run_command', systemAdapter)
      capabilityService.setAdapter('system-executor', 'bash_execute', systemAdapter)
      capabilityService.setAdapter('system-executor', 'execute_python', systemAdapter)
    }).catch(() => {
      log('WARN', 'capability_adapters_load_failed', {})
    })

    // P1.3b Phase B: capability-first mode 为默认（CAPABILITY_FIRST_MODE=false 回退到 dual）
    if (process.env.CAPABILITY_FIRST_MODE !== 'false') {
      toolSchemaProvider.setMode('capability-first')
    }

    // 注册 Playwright MCP 服务器，赋予 AI 浏览器自动化能力
    try {
      const pwMcpDir = dirname(require.resolve('@playwright/mcp/package.json'))
      const cliPath = join(pwMcpDir, 'cli.js')
      const userDataDir = join(app.getPath('userData'), 'playwright-profile')

      // 启动前清理 mcp_servers.json 中的脏数据，防止与持久化配置冲突
      const sandboxDir = join(app.getPath('userData'), 'projects', '__sandbox__')
      try { require('fs').unlinkSync(join(sandboxDir, 'mcp_servers.json')) } catch {}

      mcpManager
        .addServer({
          name: 'playwright',
          transport: 'stdio',
          command: 'node',
          args: [cliPath, '--headless', `--user-data-dir=${userDataDir}`],
        })
        .catch((err) => log('WARN', 'playwright_mcp_start_failed', { error: String(err) }))
    } catch {
      log('WARN', 'playwright_mcp_not_found')
    }

    // 注册 Fanqie MCP Server（番茄小说发布）
    try {
      const fanqieMcpPath = join(process.cwd(), 'extensions', 'fanqie-mcp', 'fanqie-mcp.mjs')
      mcpManager
        .addServer({
          name: 'fanqie-publish',
          transport: 'stdio',
          command: 'node',
          args: [fanqieMcpPath],
        })
        .catch((err) => log('WARN', 'fanqie_mcp_start_failed', { error: String(err) }))
    } catch {
      log('WARN', 'fanqie_mcp_not_found')
    }

    const llmService = new LlmService(mcpManager)
    // P1.3a: 将 ToolSchemaProvider 注入 LlmService（启用 capability function schema）
    llmService.setSchemaProvider(toolSchemaProvider)
    const gpuEngine = new WhisperGpuEngine()
    const baiduEngine = new BaiduEngine()
    const asrService = new AsrService(gpuEngine, baiduEngine)
    // 初始化长时个性化词表（从持久化存储加载）
    asrService.initVocabulary()
    // 将 TypeScript 学习知识点注入 ASR 热词管理器
    import('../learning/LearningAsrBridge')
      .then(({ learningAsrBridge }) => {
        learningAsrBridge.seedLearningVocab()
      })
      .catch((err) => {
        log('WARN', 'seed_learning_vocab_failed', { error: String(err) })
      })
    // 将 ASR 服务注入进化管理器（供 ASR 自优化使用）
    asrEvolutionManager.setAsrService(asrService)
    // 将 ASR 引擎注册为 SpeechPluginRegistry 插件
    asrService.registerPlugins()

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
        updateEnginePreference(savedPref)
        log('INFO', 'tts_preference_restored', { preference: savedPref })
      }
    } catch (err) {
      // 凭据存储可能尚未就绪
      log('DEBUG', 'tts_preference_restore_skipped', { error: String(err).slice(0, 60) })
    }
    // 将 TTS 引擎注册为 SpeechPluginRegistry 插件
    ttsService.registerPlugins()

    // ── 任务完成→欢快语音反馈桥接器初始化 ──
    // 监听 EventBus 的任务完成事件，任务完成时临时切换 TTS 为欢快风格
    ttsService.initTaskCompletionHook()

    // ── 预检测网络状态（后台异步，不阻塞启动） ──
    import('../tts/NetworkMonitor').then(({ networkMonitor }) => {
      networkMonitor.refresh().catch(() => {})
    })

    const agentService = new AgentService(llmService, asrService, ttsService, eventBus, mcpManager)
    this.agentServiceRef = agentService

    // P1.3a: 将 ToolInvocationRouter 注入 AgentService 的 toolScheduler
    agentService['toolScheduler'].setInvocationRouter(toolInvocationRouter)

    // ── 注册引擎到统一抽象层（通过 IEngineQueryable/IEngineService 接口管理） ──
    // 调用方可通过 engineProvider.getAll() 遍历所有引擎，无需感知具体实现
    engineProvider.register(agentService)       // name='agent'
    engineProvider.register(piperOrchestrator)   // name='piper-tts'

    // ── 启动 PiperTTS 环境信号监控（屏幕亮度、系统静音状态） ──
    // 用于 PiperTtsStateMachine 的深夜/静默模式自动切换
    piperTtsEnvironmentMonitor.start()

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
      interruptAgent: (id) => agentService['subAgentPool'].interrupt(id),
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
      injectPrompt: (prompt) => {
        eventBus.emit('agent.input.received', { text: prompt, requestId: `wf_${Date.now()}`, source: 'workflow' });
      },
      getCompletedAgentResults: () =>
        agentService['subAgentPool'].collectCompleted().map((r) => ({ id: r.id, summary: r.summary, error: r.error })),
      peekCompletedAgentResults: () =>
        agentService['subAgentPool'].peekCompleted().map((r) => ({ id: r.id, summary: r.summary, error: r.error })),
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

    // ── Runtime v2: ComponentRegistry — Stage 1 (descriptor registration) ──
    // WorkflowSchedulerV2 must exist before WorkflowRuntimeCheckpointableComponent
    // because descriptor.create() captures scheduler + workflowStore in closure.
    const { ComponentRegistryImpl } = await import('../runtime/ComponentRegistry')
    const { WorkflowRuntimeCheckpointableComponent } = await import('../runtime/WorkflowRuntimeCheckpointableComponent')
    this.componentRegistry = new ComponentRegistryImpl()
    this.componentRegistry.register({
      id: 'workflow-runtime',
      version: '1.0',
      create: () => new WorkflowRuntimeCheckpointableComponent(scheduler, workflowStore),
    })
    log('INFO', 'runtime_v2_component_registry_initialized', {
      components: this.componentRegistry.list().length,
    })

    // 初始化 WorkflowTriggerManager（cron + event 触发）
    // 注意: .start() 延后到 initDatabase() 之后调用，避免 DB 未就绪的竞态
    const { WorkflowTriggerManager } = await import('../workflow/WorkflowTriggerManager')
    const triggerManager = new WorkflowTriggerManager()

    const telegramService = new TelegramService(agentService)

    // === Stage 2: Electron 窗口 ===
    await app.whenReady()
    log('PERF', 'startup_stage', { stage: 'app_ready', ms: Date.now() })
    initLogFile(WORKSPACE.logs)
    log('INFO', 'log_file_ready', { path: getLogFilePath() })

    const win = createWindow(stateManager)
    const t0 = Date.now()
    agentService.setMainWindow(win)
    ttsService.setAudioSink(async (filePath) => {
      try {
        const buf = await fsp.readFile(filePath)
        win.webContents.send('tts:play_audio_buffer', buf)
      } catch {
        win.webContents.send('tts:play_audio', filePath)
      }
    })
    initTray(() => getMainWindow())

    // ── 角色化语音引擎初始化 ──
    // 初始化 VoiceRoleManager，预加载当前方案涉及的 Piper 模型。
    // 注册托盘角色方案切换回调。
    voiceRoleManager.initialize().catch((err) => {
      log('WARN', 'voice_role_manager_init_failed', { error: String(err) })
    })
    setVoiceRoleSchemeSwitch((schemeId: string) => {
      voiceRoleManager.setActiveScheme(schemeId).catch((err) => {
        log('WARN', 'voice_role_scheme_switch_failed', { error: String(err) })
      })
    })

    // ── TTS 引擎偏好 → 托盘菜单 ──
    setEnginePreferenceToggle((pref: 'auto' | 'cloud' | 'local') => {
      ttsService.setEnginePreference(pref)
      updateEnginePreference(pref)
      credentialsManager.set('tts_mode', pref)
      log('INFO', 'tts_engine_tray_selection', { preference: pref })
    })

    // ── [混合 TTS 调度器] 初始化缓存 + 高频短语预生成 ──
    // 在后台异步完成，不阻塞启动流程
    ttsScheduler.initialize(join(WORKSPACE_ROOT, 'tts_cache')).catch((err) => {
      log('WARN', 'tts_scheduler_init_failed', { error: String(err) })
    })

    const uiBridge = new UIBridge()
    uiBridge.bind(win)
    log('PERF', 'startup_stage', { stage: 'window_created', ms: Date.now() - t0, total: Date.now() - startMs })

    // DB 初始化
    await initDatabase()
    log('PERF', 'startup_stage', { stage: 'db_ready', ms: Date.now() - t0, total: Date.now() - startMs })
    log('INFO', 'database_ready')

    // Workflow 触发器管理器在 DB 就绪后启动
    triggerManager.start()
    credentialsManager.migrate()
    log('INFO', 'credential_migration_done')
    setCredentialsManager(credentialsManager)
    llmService.refreshFromCredentials((key) => credentialsManager.get(key))
    log('INFO', 'llm_config_loaded_from_credentials')

    // ── Runtime v2: Storage + RestoreService — Stage 2 (after DB init) ──
    // SqliteCheckpointManager needs DB connection. RuntimeRestoreService needs
    // ComponentRegistry from Stage 1. Activator needs WorkflowScheduler from Stage 1.
    const { SqliteCheckpointManager } = await import('../runtime/SqliteCheckpointManager')
    this.checkpointManager = new SqliteCheckpointManager()

    const { RuntimeRestoreServiceImpl } = await import('../runtime/RuntimeRestoreService')
    const { RuntimeRecoveryActivator } = await import('../runtime/RuntimeRecoveryActivator')
    this.runtimeRestoreService = new RuntimeRestoreServiceImpl(
      this.checkpointManager,
      this.componentRegistry!,
    )
    this.runtimeRestoreService.setActivator(new RuntimeRecoveryActivator(scheduler))
    log('INFO', 'runtime_v2_restore_service_initialized', {
      storageReady: !!this.checkpointManager,
      registryComponents: this.componentRegistry?.list().length ?? 0,
    })

    // Evaluation 子系统：Store → Emitter → Bridge
    this.evaluationStore = new EvaluationStore()
    log('INFO', 'evaluation_store_init_start')
    await Promise.race([
      this.evaluationStore.init(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('evaluationStore.init timeout')), 15000)),
    ])
    log('INFO', 'evaluation_store_init_done')
    const sessionId = `runtime_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.evaluationEmitter = new EvaluationEmitter(this.evaluationStore, 'runtime', sessionId)
    llmService.setEvaluationEmitter(this.evaluationEmitter)
    this.toolEventBridge = new ToolEventBridge(this.evaluationEmitter, eventBus)
    this.toolEventBridge.start()
    // GuardrailPipeline — 注入 ChatExecutor 的 GuardrailPipeline（需要 emitter 就绪）
    const guardrailDecisionStore = new GuardrailDecisionStore()
    const guardrailPipeline = new GuardrailPipeline(undefined, undefined, this.evaluationEmitter, guardrailDecisionStore)
    agentService.setGuardrailPipeline(guardrailPipeline)
    // 注入 EvaluationEmitter 用于写入 Delivery Trace 事件
    agentService.setEvaluationEmitter(this.evaluationEmitter)

    // GuardrailConfigStore — 从 EvaluationEvent 日志重建 Event Projection
    const guardrailConfigStore = new GuardrailConfigStore()

    // 启动时扫描 config events 重建 state
    try {
      const activatedEvents = await this.evaluationStore.query({ since: 0, type: 'guardrail.config.activated' })
      const initializedEvents = await this.evaluationStore.query({ since: 0, type: 'guardrail.config.initialized' })
      const rollbackEvents = await this.evaluationStore.query({ since: 0, type: 'guardrail.config.rollback' })
      // 合并并按 timestamp 排序
      const allConfigEvents = [...activatedEvents, ...initializedEvents, ...rollbackEvents].sort((a, b) => a.timestamp - b.timestamp)

      guardrailConfigStore.loadFromEvents(allConfigEvents)

      if (guardrailConfigStore.getVersionHistory().length === 0) {
        // 首次启动，无历史 config — seed 并 emit 初始事件
        const version = guardrailConfigStore.allocateVersion()
        guardrailConfigStore.applyActivated(version, DEFAULT_GUARDRAIL_POLICY_CONFIG, Date.now())
        this.evaluationEmitter.emit('guardrail.config.initialized', {
          type: 'guardrail.config.initialized',
          version,
          config: DEFAULT_GUARDRAIL_POLICY_CONFIG,
          activatedAt: Date.now(),
        })
        log('INFO', 'guardrail_config_seeded', { version })
      } else {
        log('INFO', 'guardrail_config_reconstructed', {
          version: guardrailConfigStore.getActiveConfig().version,
          eventCount: allConfigEvents.length,
        })
      }
    } catch (err: any) {
      log('WARN', 'guardrail_config_reconstruction_failed', {
        error: err.message,
        fallback: 'DEFAULT_GUARDRAIL_POLICY_CONFIG',
      })
      // 重建失败时 fallback 到 DEFAULT（init 跳过 seed，getActiveConfig 自动回退 DEFAULT）
    }

    // GuardrailProgressConsumer 接入 ProgressObserver
    // ADR-004 Option A: Consumer 通过 callback 将 GuardrailDecision 交付给 Pipeline
    const guardrailConsumer = new GuardrailProgressConsumer(
      undefined,
      (decision) => {
        guardrailPipeline.onGuardrailDecision(decision)
      },
      guardrailConfigStore,
    )

    // M5.4: replayWindowMs 从环境变量读取（默认 60000ms）
    const replayWindowMsRaw = parseInt(process.env.GUARDRAIL_REPLAY_WINDOW_MS ?? '60000', 10)
    const replayWindowMs = Number.isFinite(replayWindowMsRaw) && replayWindowMsRaw >= 1000 ? replayWindowMsRaw : 60000

    // ProgressObserver — Event Pipeline Observer（单例）
    this.progressObserver = new ProgressObserver(this.evaluationStore, new GuardrailProgressAnalyzer(this.evaluationStore), replayWindowMs)
    this.progressObserver.register(guardrailConsumer)
    this.progressObserver.start()
    log('INFO', 'evaluation_ready', { sessionId, guardrailConsumerReady: true })

    // ── M6.2 Metrics Projection Startup ──
    const { GuardrailMetricsStore } = await import('../core/evaluation/GuardrailMetricsStore')
    const { GuardrailMetricsProjection } = await import('../core/evaluation/GuardrailMetricsProjection')
    this.metricsStore = new GuardrailMetricsStore()
    this.metricsProjection = new GuardrailMetricsProjection(this.evaluationStore, this.metricsStore)

    const GUARDRAIL_METRICS_REBUILD = process.env.GUARDRAIL_METRICS_REBUILD === 'true'
    try {
      if (GUARDRAIL_METRICS_REBUILD) {
        await this.metricsProjection.rebuild()
        log('INFO', 'guardrail_metrics_rebuilt')
      } else {
        const lastUpdate = await this.metricsStore.getLastUpdateTimestamp()
        if (lastUpdate !== null) {
          await this.metricsProjection.build(lastUpdate)
          log('INFO', 'guardrail_metrics_built', { since: lastUpdate })
        } else {
          await this.metricsProjection.rebuild()
          log('INFO', 'guardrail_metrics_initial_build')
        }
      }
    } catch (err: any) {
      log('WARN', 'guardrail_metrics_startup_failed', { error: err.message })
      // Metrics projection 启动失败 → degrade（不阻塞 runtime）
    }

    // M6.3: GuardrailMetricsQueryService — 只读查询层
    const { GuardrailMetricsQueryService } = await import('../core/evaluation/GuardrailMetricsQueryService')
    this.metricsQueryRef.current = new GuardrailMetricsQueryService(this.metricsStore, this.metricsProjection)

    // 运行时增量构建：每 5 分钟 replay 新 events → 刷新 metrics
    const METRICS_REFRESH_MS = 5 * 60 * 1000
    const metricsTimer = setInterval(async () => {
      try {
        const lastUpdate = await this.metricsStore!.getLastUpdateTimestamp()
        if (lastUpdate !== null) {
          await this.metricsProjection!.build(lastUpdate)
        }
      } catch {
        // metrics 刷新失败 → 静默降级（不干扰主流程）
      }
    }, METRICS_REFRESH_MS)
    this.subs.add(() => clearInterval(metricsTimer))

    // DecisionQueryService — 只读查询层（M5.3）
    const { DecisionQueryService } = await import('../core/evaluation/DecisionQueryService')
    const decisionQueryRef = createServiceRef<DecisionQueryService>()
    decisionQueryRef.current = new DecisionQueryService(guardrailDecisionStore)

    // evolutionRef/dashboardRef — 延迟注入
    const evolutionRef = createServiceRef<SelfEvolutionService>()
    const dashboardRef = createServiceRef<EvolutionDashboardService>()
    const taskPanelRef = createServiceRef<TaskPanelService>()
    const wallpaperInteractiveRef = createServiceRef<WallpaperInteractiveService>()

    // 注册 IPC Handler
    const restoreRef = createServiceRef<import('../runtime/RuntimeRestoreService').RuntimeRestoreService>()
    restoreRef.current = this.runtimeRestoreService ?? null
    registerHandlers(
      agentService,
      stateManager,
      ttsService,
      evolutionRef,
      undefined,
      dashboardRef,
      this.memoryContextRef,
      decisionQueryRef,
      this.metricsQueryRef,
      this.organizerRef,
      this.voiceBookmarkRef,
      taskPanelRef,
      wallpaperInteractiveRef,
      restoreRef,
      this.conversationContextRef,
      this.voiceNoteRef,
    )

    // === Stage 3: 核心服务（内存、插件、技能） ===
    const memoryService = new MemoryService()
    this.memoryService = memoryService
    this.crashGuard.flushMemory = () => memoryService.flush()
    // Memory × Evolution 深度融合桥接器：注入 MemoryService 引用
    memoryEvolutionBridge.setMemoryService(memoryService)
    // Memory × TTS 深度融合桥接器：注入双方向引用 + 注册合成回调
    memoryTtsBridge.setMemoryService(memoryService)
    memoryTtsBridge.setTtsService(ttsService)
    // SleepOrchestrator：注入 TTS 服务引用用于唤醒语音问候
    sleepOrchestrator.setTtsService(ttsService)
    // 注册 TTS 合成完成回调：每次合成后，桥接器决定是否记录到 Memory
    ttsService.setOnSynthesisComplete((record) => {
      memoryTtsBridge.recordSynthesis(record)
    })
    const skillManager = new SkillManager()
    await skillManager.initialize()
    agentService.setSkillManager(skillManager)
    setSkillManagerSingleton(skillManager)
    agentService.setMemoryService(memoryService)
    setMemoryService(memoryService)

    // ── 行为预测式记忆预热：注入 MemoryService 依赖 ──
    {
      const { behaviorPredictiveMemoryPrewarmer } = await import('../behavior/BehaviorPredictiveMemoryPrewarmer')
      behaviorPredictiveMemoryPrewarmer.setDependencies({
        getRecentInteractions: (limit: number) => memoryService.interactionTracker.getRecent(limit),
        getAllInteractions: () => memoryService.interactionTracker.getAll(),
        predictNextTopics: (currentTopics: string[], topK: number) =>
          memoryService.topicTransitionPredictor.predictNextTopics(currentTopics, topK),
        getBehaviorWeightedEntries: (tier?: string, limit?: number) =>
          memoryService.getBehaviorWeightedEntries(tier as any, limit),
        getEntries: () => memoryService.getEntries(),
        getTopicTransitionStats: () => memoryService.getTopicTransitionStats(),
      })
      log('INFO', 'predictive_prewarmer_initialized', {
        transitionStats: memoryService.getTopicTransitionStats(),
      })
    }

    // ── 行为预测记忆引擎：持续分析行为模式，预加载 >80% 匹配的记忆 ──
    {
      const { behaviorPredictionMemoryEngine } = await import('../behavior/BehaviorPredictionMemoryEngine')

      // 跟踪最新的行为状态（UserBehaviorService 通过 EventBus 发布）
      const latestBehaviorState: { appCategory: string; activityState: string; idleTimeMs: number } = {
        appCategory: 'other',
        activityState: 'active',
        idleTimeMs: 0,
      }
      this.subs.add(eventBus.on('behavior.state.updated' as any, (state: any) => {
        latestBehaviorState.appCategory = state.appCategory ?? 'other'
        latestBehaviorState.activityState = state.activityState ?? 'active'
        latestBehaviorState.idleTimeMs = state.idleTimeMs ?? 0
      }))

      behaviorPredictionMemoryEngine.setDependencies({
        getBehaviorContext: () => {
          const now = new Date()
          return {
            hour: now.getHours(),
            dayOfWeek: now.getDay(),
            appCategory: latestBehaviorState.appCategory,
            activityState: latestBehaviorState.activityState as 'active' | 'idle' | 'away',
            idleTimeMs: latestBehaviorState.idleTimeMs,
          }
        },
        getRecentInteractions: (limit: number) => memoryService.interactionTracker.getRecent(limit),
        getRecentInteractionTopics: (limit: number) => {
          const recents = memoryService.interactionTracker.getRecent(limit)
          const topics = new Set<string>()
          for (const r of recents) {
            if (r.topics) r.topics.forEach((t: string) => topics.add(t))
          }
          return [...topics].slice(0, 10)
        },
        getMemoryEntries: () => memoryService.getEntries(),
        getBehaviorWeightedEntries: (tier?: string, limit?: number) =>
          memoryService.getBehaviorWeightedEntries(tier as any, limit),
      })

      // 启动引擎（5 分钟周期）
      behaviorPredictionMemoryEngine.start()
      log('INFO', 'prediction_memory_engine_started')
    }

    setPlanManager(planManager)
    setToolSkillManager(skillManager)

    // ── 智能并行任务协调器 ──
    // 集成 plan-scheduler 到 Agent：自动管理多计划的 DAG 调度、心跳推进、对话干预
    const { PlanSchedulerCoordinator, createAndStartSchedulerNotificationBridge } = await import('../plan-scheduler')
    const { setPlanSchedulerCoordinator } = await import('../tool/deps')
    const planSchedulerCoordinator = new PlanSchedulerCoordinator(
      llmService,
      agentService['toolScheduler'],
      {
        planManager,
        llmService: { chatJson: (prompt: string, opts?: any) => llmService.chatJson(prompt, opts) },
        emitEvent: (event) => {
          const eventName = event.type.replace(/\./g, '_')
          eventBus.emit(`plan_scheduler.${eventName}` as any, event as any)
        },
        log: (level, msg, meta) => log(level, msg, meta),
      },
      {
        autoLoadActivePlans: true,
        enableNotifications: true,
        heartbeatIntervalMs: 30_000,
        autoSyncIntervalMs: 60_000,
      },
    )
    planSchedulerCoordinator.start()
    setPlanSchedulerCoordinator(planSchedulerCoordinator)
    // 启动调度事件 → TTS 通知桥接
    createAndStartSchedulerNotificationBridge()

    // ── 工具链编排即服务（ToolChainOrchestrator）──
    {
      const { ToolChainOrchestrator, ToolChainDecomposer, OrchestrationBridge } = await import('../orchestrator')
      const { setToolChainOrchestrator } = await import('../tool/deps')
      const mcpManager = (llmService as any).mcpManager
      const decomposer = new ToolChainDecomposer(
        llmService,
        () => {
          try {
            return mcpManager?.getAllSchemas()?.map((s: any) => ({
              name: s.function.name,
              description: s.function.description,
              parameters: Object.entries(s.function.parameters?.properties || {})
                .map(([key, val]: [string, any]) => `${key}: ${val.type}${val.description ? ` - ${val.description}` : ''}`)
                .join('; '),
              required: s.function.required || [],
            })) || []
          } catch { return [] }
        },
      )
      const orchestrator = new ToolChainOrchestrator(decomposer, mcpManager)
      setToolChainOrchestrator(orchestrator)
      // 启动编排事件桥接（EventBus → IPC）
      const bridge = new OrchestrationBridge()
      bridge.start(getMainWindow())
      log('INFO', 'toolchain_orchestrator_initialized')
    }

    // ── 语音记忆书签服务 ──
    const voiceBookmarkSvc = new VoiceBookmarkService()
    voiceBookmarkSvc.setMemoryService(memoryService)
    voiceBookmarkSvc.setSynthesizeFn(async (text: string, outputPath: string): Promise<boolean> => {
      try {
        // 通过 TtsPiperBridge 使用 PiperTTS 合成语音
        // 若有 Piper 不可用，回退到 edge-tts
        const { ttsPiperBridge } = await import('../tts/TtsPiperBridge')
        const result = await ttsPiperBridge.synthesizeWithPiper(text, {
          voice: 'zh-CN-XiaoxiaoNeural',
          rate: '+10%',
          pitch: '+8Hz',
          label: '书签语音',
        })
        if (result.success && result.audioFile) {
          const { promises: fsp } = await import('fs')
          await fsp.copyFile(result.audioFile, outputPath)
          // 清理源临时文件
          fsp.unlink(result.audioFile).catch(() => {})
          return true
        }
        return false
      } catch {
        // Piper 不可用，尝试 edge-tts
        try {
          const { execFile } = await import('child_process')
          await new Promise<void>((resolve, reject) => {
            execFile(
              'edge-tts',
              ['--voice', 'zh-CN-XiaoxiaoNeural', '--text', text, '--write-media', outputPath],
              { timeout: 30000, windowsHide: true },
              (err, _stdout, stderr) => {
                if (err) reject(new Error(stderr || String(err)))
                else resolve()
              },
            )
          })
          return true
        } catch (err) {
          log('ERROR', 'voice_bookmark_tts_fallback_failed', { error: String(err) })
          return false
        }
      }
    })
    await voiceBookmarkSvc.init()
    this.voiceBookmarkService = voiceBookmarkSvc
    this.voiceBookmarkRef.current = voiceBookmarkSvc
    log('INFO', 'voice_bookmark_service_ready')

    // ── Plan:工业颂歌 公众号排版处理 上层增强层（由 GONGYE_SONGE_FEATURES 控制）──
    try {
      const { IndustrialOdeLayer } = await import('../gongye-songge/IndustrialOdeLayer')
      const { parseFeaturesFromEnv } = await import('../gongye-songge/types')
      const gongyeFeatures = parseFeaturesFromEnv()
      if (gongyeFeatures.length > 0) {
        const preHooks: any[] = []
        const postHooks: any[] = []

        // 预处理：检测排版需求
        if (gongyeFeatures.includes('style_inject')) {
          preHooks.push(IndustrialOdeLayer.createDetectNeedPreHook())
          preHooks.push(IndustrialOdeLayer.createStyleInjectPreHook())
        } else if (gongyeFeatures.includes('content_format') || gongyeFeatures.includes('publish_ready')) {
          preHooks.push(IndustrialOdeLayer.createDetectNeedPreHook())
        }

        // 后处理：公众号排版格式化
        if (gongyeFeatures.includes('content_format')) {
          postHooks.push(IndustrialOdeLayer.createFormatPostHook())
        }
        if (gongyeFeatures.includes('publish_ready')) {
          // publish_ready 强制对所有内容添加发布就绪标记
          postHooks.push(IndustrialOdeLayer.createFormatPostHook())
        }
        if (gongyeFeatures.includes('summary_format') && llmService) {
          postHooks.push(
            IndustrialOdeLayer.createLlmFormatPostHook({
              chatJson: (prompt: string, opts?: any) => llmService.chatJson(prompt, opts),
            }),
          )
        }

        const industrialOdeLayer = new IndustrialOdeLayer({
          features: gongyeFeatures,
          preHooks: preHooks.length > 0 ? preHooks : undefined,
          postHooks: postHooks.length > 0 ? postHooks : undefined,
          llmService: llmService
            ? {
                chatJson: (prompt: string, opts?: any) => llmService.chatJson(prompt, opts),
              }
            : undefined,
          debug: process.env.GONGYE_SONGE_DEBUG === 'true',
        })

        agentService.setIndustrialOdeLayer(industrialOdeLayer)
      }
    } catch (err) {
      log('WARN', 'industrial_ode_layer_init_failed', { error: String(err) })
    }

    // ── Plan Memory Blog：记忆增强博客时光机 ──
    try {
      const { initBlogMemoryRecorder, initBlogMemoryRetriever } = await import('../memory/plan-memory-blog')
      const { setBlogMemoryRecorder, setBlogMemoryRetriever } = await import('../tool/deps')
      const recorder = initBlogMemoryRecorder()
      const retriever = initBlogMemoryRetriever(memoryService)
      setBlogMemoryRecorder(recorder)
      setBlogMemoryRetriever(retriever)
      log('INFO', 'blog_memory_recorder_initialized', {
        enabled: process.env.BLOG_MEMORY_ENABLED !== 'false',
      })
    } catch (err) {
      log('WARN', 'blog_memory_recorder_init_failed', { error: String(err) })
    }

    // ── Experience Memory Service：经验记忆工作流引擎 ──
    try {
      const { initExperienceMemoryService } = await import('../memory/plan-memory-blog')
      initExperienceMemoryService()
      log('INFO', 'experience_memory_service_initialized')
    } catch (err) {
      log('WARN', 'experience_memory_service_init_failed', { error: String(err) })
    }

    // ── Blog Dual-Mode Switching Service：博客写作双模式切换引擎 ──
    try {
      const { blogModeService } = await import('../agent/blog/BlogModeService')
      const { setBlogModeService } = await import('../tool/deps')
      setBlogModeService(blogModeService)
      // 注册模式切换事件总线日志
      eventBus.track(
        'blog.mode.switched',
        (p: any) => log('INFO', 'blog_mode_switched', {
          sessionId: p.sessionId,
          from: p.fromMode,
          to: p.toMode,
          reason: p.reason,
          snapshotId: p.snapshotId,
        }),
        this.subs,
        'runtime:blog_mode_switched',
      )
      log('INFO', 'blog_dual_mode_service_initialized', { defaultMode: blogModeService.getDefaultMode() })
    } catch (err) {
      log('WARN', 'blog_dual_mode_service_init_failed', { error: String(err) })
    }

    // ── Plan:清理工作区 - 整理文件目录 上层增强层（由 WORKSPACE_CLEANUP_FEATURES 控制）──
    try {
      const { WorkspaceCleanupLayer } = await import('../workspace-cleanup/WorkspaceCleanupLayer')
      const { parseFeaturesFromEnv } = await import('../workspace-cleanup/types')
      const wsFeatures = parseFeaturesFromEnv()
      if (wsFeatures.length > 0) {
        const preHooks: any[] = []
        const postHooks: any[] = []

        // 预处理：意图检测
        if (wsFeatures.includes('intent_detect')) {
          preHooks.push(WorkspaceCleanupLayer.createIntentDetectPreHook())
        }

        // 预处理：工作区统计注入（需 layer 实例方法，在构造后添加）
        // inject_stats 钩子通过构造函数参数注入的 createInjectStatsPreHook 处理

        // 后处理：扫描并报告
        if (wsFeatures.includes('scan_and_report')) {
          // scan_and_report 是实例方法，在构造后动态注册
        }

        // 后处理：整理报告
        if (wsFeatures.includes('report_summary')) {
          postHooks.push(WorkspaceCleanupLayer.createCleanupReportPostHook())
        }

        const workspaceCleanupLayer = new WorkspaceCleanupLayer({
          features: wsFeatures,
          preHooks: preHooks.length > 0 ? preHooks : undefined,
          postHooks: postHooks.length > 0 ? postHooks : undefined,
          llmService: llmService
            ? {
                chatJson: (prompt: string, opts?: any) => llmService.chatJson(prompt, opts),
              }
            : undefined,
          debug: process.env.WORKSPACE_CLEANUP_DEBUG === 'true',
        })

        // 动态注册实例方法钩子（需要在构造后，因为实例方法捕获了 this）
        if (wsFeatures.includes('inject_stats')) {
          const injectHook = workspaceCleanupLayer.createInjectStatsPreHook()
          workspaceCleanupLayer.addPreHook(injectHook)
        }
        if (wsFeatures.includes('scan_and_report')) {
          const scanHook = workspaceCleanupLayer.createScanAndReportPostHook()
          workspaceCleanupLayer.addPostHook(scanHook)
        }

        agentService.setWorkspaceCleanupLayer(workspaceCleanupLayer)
      }
    } catch (err) {
      log('WARN', 'workspace_cleanup_layer_init_failed', { error: String(err) })
    }

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

    // === Stage 5: 宪法 ===
    const constitutionEngine = new ConstitutionEngine()
    await constitutionEngine.initialize(join(WORKSPACE.evolution, 'constitution'))
    constitutionEngine.setEnforcementMode('enforce')
    // Phase 4: 延迟注入 GoalGuardrail 依赖（ConstitutionEngine 在此阶段可用）
    agentService.goalGuardrail.setConstitutionEngine(constitutionEngine)
    // Phase 3B: 连接 ProposalValidator → ConstitutionEngine
    this.proposalValidator.setConstitution(constitutionEngine)
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

    // ── 行为驱动的主动记忆填充（TF-IDF + 意图聚类 + 时间序列分析）──
    const { behaviorDrivenMemoryAnalyzer: bdma } = await import('../behavior/BehaviorDrivenMemoryAnalyzer')
    this.behaviorMemoryAnalyzer = bdma
    bdma.setMemoryService(memoryService)
    // 启动延迟到 stage 5（懒加载服务组）

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
    const telegramEnabledFlag = credentialsManager.get('telegram_enabled')
    const isTelegramEnabled = telegramEnabledFlag !== null ? telegramEnabledFlag === 'true' : TELEGRAM_ENABLED
    if (isTelegramEnabled) {
      const outboxUrl = credentialsManager.get('telegram_server_url') || TELEGRAM_SERVER_URL
      const outboxWorker = new OutboxWorker(outboxUrl)
      this.taskRunner.register('telegram.outbox', () => outboxWorker.tick(), TELEGRAM_POLL_INTERVAL_MS, {
        cooldownMs: TELEGRAM_OUTBOX_COOLDOWN_MS,
      })
      // 当 TelegramService 写入新 outbox 消息时，自动恢复被禁用的 outbox 任务
      telegramService.setReactivateOutbox(() => {
        this.taskRunner?.reactivate('telegram.outbox')
      })
    }

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

    // 休眠编排检测（每 10 分钟检查用户是否 60 分钟无交互）
    this.taskRunner.register(
      'sleep.orchestration',
      () => sleepOrchestrator.tick(),
      10 * 60 * 1000,
      { cooldownMs: 60 * 1000 },
    )

    // Phase 5D: 注入 Task 健康提供者（此时所有 task 已注册）
    this.runtimeHealthManager?.setTaskHealthProvider(this.taskRunner)

    // 启动！
    this.lazyInit.start()
    this.taskRunner.start()
    log('INFO', 'task_runtime_started')

    // === Heartbeat: 5s 间隔检测主进程事件循环是否存活 ===
    let beatId = 0
    const heartbeat = setInterval(() => {
      log('DEBUG', 'heartbeat', { tick: ++beatId, uptime: Date.now() - startMs })
    }, 5000)
    // 注册到清理函数防止泄漏
    const { addGlobalDisposer } = await import('../core/Lifecycle')
    addGlobalDisposer(() => clearInterval(heartbeat))

    // === Stage 8: Retention & Archive（R1） ===
    this.initRetentionScheduler()

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
    this.progressObserver?.stop()
    await this.evaluationStore?.shutdown().catch(() => {})
    ttsTypographyFeedbackLoop.stop()
    this.memoryService?.shutdown()
    this.memoryIndexer?.stop()
    this.behaviorMemoryAnalyzer?.stop()
    await this.evaluationStore?.shutdown().catch(() => {})
    this.feedbackLoop?.dispose()
    evolutionService?.stop()
    insightService?.stop()
    creativityService?.stop()
    this.dashboardService?.destroy()
    this.organizerService?.destroy()
    this.memoryContextService?.destroy()
    this.lazyInit?.cancel()
    this.subs.dispose()
    closeDatabase()
    log('INFO', 'memory_flushed_on_quit')
  }

  /**
   * 启动每日归档 + retention 调度。
   * R1: 使用 setTimeout 模式，免改 TaskRunner。
   */
  private initRetentionScheduler(): void {
    try {
      const mainRawDb = getRawDb()
      const eventRawDb = getEventRawDb()

      const mainRaw: { run: (sql: string, params?: any[]) => void; query: (sql: string, params?: any[]) => Record<string, any>[] } = {
        run: (s, p) => mainRawDb.run(s, p),
        query: (s, p) => {
          const stmt = mainRawDb.prepare(s)
          p && stmt.bind(p)
          const rows: any[] = []
          while (stmt.step()) rows.push(stmt.getAsObject())
          stmt.free()
          return rows
        },
      }

      const eventRaw: { run: (sql: string, params?: any[]) => void; query: (sql: string, params?: any[]) => Record<string, any>[] } = {
        run: (s, p) => eventRawDb.run(s, p),
        query: (s, p) => {
          const stmt = eventRawDb.prepare(s)
          p && stmt.bind(p)
          const rows: any[] = []
          while (stmt.step()) rows.push(stmt.getAsObject())
          stmt.free()
          return rows
        },
      }

      const archiver = new EventArchiver(this.evaluationStore!, eventRaw, WORKSPACE_ROOT)
      const scheduler = new RetentionScheduler(
        archiver,
        mainRaw,
        this.evaluationStore!,
        this.evaluationStore!,
        this.metricsStore!,
        WORKSPACE_ROOT,
      )

      const scheduleNext = () => {
        const now = Date.now()
        const next = new Date()
        next.setHours(2, 0, 0, 0) // 02:00 local
        if (next.getTime() <= now) next.setDate(next.getDate() + 1)
        setTimeout(async () => {
          try {
            const result = await scheduler.runCycle()
            if (result.archive.length > 0 || result.retention.some((r) => r.deletedCount > 0)) {
              const { markDirty } = require('../../db/connection')
              markDirty()
            }
            log('INFO', 'retention_cycle_completed', {
              archive: result.archive.length,
              decisionsDeleted: result.retention[0]?.deletedCount ?? 0,
              metricsDeleted: result.retention[1]?.deletedCount ?? 0,
            })
          } catch (err: any) {
            log('WARN', 'retention_cycle_failed', { error: err.message })
          }
          scheduleNext()
        }, next.getTime() - now)
      }

      // 首次启动检查：如果归档目录没有今日文件，立即执行
      const { existsSync } = require('fs')
      const { join } = require('path')
      const today = new Date()
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      const todayArchive = join(WORKSPACE_ROOT, 'archive', 'evaluation_events', `evaluation_events_${todayStr}.ndjson.gz`)
      if (!existsSync(todayArchive)) {
        log('INFO', 'retention_first_run_no_today_archive')
        scheduler
          .runCycle()
          .then((result: any) => {
            log('INFO', 'retention_first_run_completed', {
              archive: result.archive.length,
              decisionsDeleted: result.retention[0]?.deletedCount ?? 0,
              metricsDeleted: result.retention[1]?.deletedCount ?? 0,
            })
          })
          .catch((err: any) => {
            log('WARN', 'retention_first_run_failed', { error: err.message })
          })
      }

      scheduleNext()
      log('INFO', 'retention_scheduler_initialized')
    } catch (err: any) {
      log('WARN', 'retention_scheduler_init_failed', { error: err.message })
    }
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
        if (process.env.EVOLUTION_SERVICE_DISABLED === 'true') {
          log('INFO', 'evolution_disabled', { reason: 'EVOLUTION_SERVICE_DISABLED=true' })
          // 确保被其他模块引用的子目录仍存在
          const { ensureEssentialDirs } = await import('../evolution/EvolutionUtils')
          ensureEssentialDirs()
          return
        }
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
        // 注册基础 collector 和 executor（注入 SubAgentPoolAdapter 替代旧 SubAgentPool）
        pipeline.initDefaults(agentService.getSubAgentPool())
        // Phase 3C.3: 注入 v1.1.0 Shadow Mode ExecutionPolicy（策略策略校准期）
        pipeline.setExecutionPolicy(new ExecutionPolicy({ mode: 'shadow', policyVersion: '1.1.0' }))
        // 注册 Evolution 插件（ServiceLoader 模式）
        const { PluginServiceLoader, WallpaperPlugin, PluginCollectorAdapter, PluginExecutorAdapter } = await import('../evolution/plugin')
        const pluginLoader = PluginServiceLoader.getInstance()
        const wallpaperPlugin = new WallpaperPlugin(process.cwd())
        pluginLoader.register(wallpaperPlugin)
        // 注册 Evolution × PiperTTS 深度融合插件
        const { PiperEvolutionPlugin } = await import('../evolution/piper')
        pluginLoader.register(new PiperEvolutionPlugin())
        await pluginLoader.loadAll()
        // 将插件适配为管道 Collector / Executor 并注册
        const collectPlugins = pluginLoader.getByCapability('collect')
        for (const p of collectPlugins) {
          pipeline.addCollector(new PluginCollectorAdapter(p))
        }
        const optimizePlugins = pluginLoader.getByCapability('optimize')
        for (const p of optimizePlugins) {
          pipeline.addExecutor(new PluginExecutorAdapter(p))
        }
        log('INFO', 'evolution_plugins_wired', {
          registered: pluginLoader.getAll().length,
          collectors: collectPlugins.length,
          executors: optimizePlugins.length,
        })
        // 注册记忆分析采集器（从对话记录中检测用户不满意模式）
        pipeline.addCollector(new MemoryAnalysisCollector())
        // 注册记忆优化采集器和执行器（自适应调参：分析统计 → 生成建议 → 应用变更）
        const { MemoryOptimizationCollector, MemoryOptimizationExecutor } = await import('../evolution/automation')
        const memOptCollector = new MemoryOptimizationCollector()
        const memOptExecutor = new MemoryOptimizationExecutor()
        memOptCollector.setMemoryService(memoryService)
        memOptExecutor.setMemoryService(memoryService)
        pipeline.addCollector(memOptCollector)
        pipeline.addExecutor(memOptExecutor)
        // 注册行为特征采集器和优化执行器（行为驱动自进化）
        const { BehaviorCollector, BehaviorOptimizationExecutor } = await import('../evolution/automation')
        pipeline.addCollector(new BehaviorCollector())
        pipeline.addExecutor(new BehaviorOptimizationExecutor())
        // 启动 TTS↔排版强化回路（初始为 manual 模式，collector/executor 已在 initDefaults 中注册）
        ttsTypographyFeedbackLoop.start()

        // ── [反 ASR 原型] 排版计划上下文 → ASR 热词增强 ──
        // 反转假设：排版计划不再只是 ASR 输出结果的被动消费者，
        // 而是通过播种领域词汇热词来主动影响 ASR 的识别倾向。
        import('../typing/TypographyAsrBridge')
          .then(({ typographyAsrBridge }) => {
            typographyAsrBridge.seedFromActiveTypography()
          })
          .catch((err) => {
            log('WARN', 'seed_typography_asr_failed', { error: String(err) })
          })

        // 注册行为记录钩子（增强时序数据采集）
        const { registerBehaviorRecordHook } = await import('../user-behavior/BehaviorFeatureExtractor')
        registerBehaviorRecordHook()
        // 附加到进化系统（SelfEvolutionService 将消费管道指标）
        evolution.setPipeline(pipeline)
        // Memory × Evolution 深度融合：注入桥接器
        evolution.setMemoryBridge(memoryEvolutionBridge)

        // ★ 自进化计划优化器初始化
        {
          const { planOptimizerEngine, planOptimizerCollector, planOptimizerExecutor } = await import('../evolution/plan-optimizer')
          // 注入 LLM 分析能力
          planOptimizerEngine.setAnalyzeFn((prompt: string, opts?: any) =>
            llmService.chatJson(prompt, opts),
          )
          // 注入 PlanManager（与 evolution 共享同一实例）
          planOptimizerCollector.setPlanManager(planManager)
          planOptimizerExecutor.setPlanManager(planManager)
          // 注册到管道（作为 Feature 来源的 Collector 和 Executor）
          pipeline.addCollector(planOptimizerCollector)
          pipeline.addExecutor(planOptimizerExecutor)
          log('INFO', 'plan_optimizer_initialized')
        }

        // Phase 3C.2: 将 policy.decision 事件持久化为 EvaluationEvent
        const { PolicyDecisionObserver } = await import('../core/evaluation/observers/PolicyDecisionObserver')
        if (this.evaluationEmitter) {
          new PolicyDecisionObserver(this.evaluationEmitter).start()
        }

        // ★ CI/CD Orchestrator 初始化：加载 MCP CI/CD 工具集
        const { CicdOrchestrator } = await import('../evolution/cicd')
        const cicdOrchestrator = new CicdOrchestrator({
          runQualityGateBeforeSteps: false,
          autoDeployOnSuccess: false,
          maxParallelChecks: 4,
        })
        await cicdOrchestrator.init()
        evolution.setCicdOrchestrator(cicdOrchestrator)
        log('INFO', 'cicd_orchestrator_initialized', { toolsLoaded: cicdOrchestrator.isReady() })

        this.pipeline = pipeline
        evolution.scheduleEvolution(2)
        if (evolutionRef) evolutionRef.current = evolution
        // 创建 UserBehavior 上层增强层（由环境变量 USER_BEHAVIOR_FEATURES 控制）
        const { UserBehaviorLayer } = await import('../user-behavior/UserBehaviorLayer')
        const { parseFeaturesFromEnv } = await import('../user-behavior/types')
        const features = parseFeaturesFromEnv()
        if (features.length > 0) {
          const preHooks: any[] = []
          const postHooks: any[] = []

          if (features.includes('summary_enhance')) {
            preHooks.push(UserBehaviorLayer.createSummaryEnhancePreHook())
            postHooks.push(UserBehaviorLayer.createSummaryEnhancePostHook())
          }
          if (features.includes('metrics_enrich')) {
            postHooks.push(UserBehaviorLayer.createMetricsEnrichPostHook())
          }
          if (features.includes('dynamic_pipeline_tuning')) {
            postHooks.push(UserBehaviorLayer.createDynamicTuningPostHook())
          }
          if (features.includes('behavior_driven_optimization') || features.includes('behavior_sequence_analysis')) {
            preHooks.push(UserBehaviorLayer.createBehaviorFeaturePreHook())
            postHooks.push(UserBehaviorLayer.createBehaviorAnalysisPostHook())
          }

          const userBehaviorLayer = new UserBehaviorLayer(evolution, {
            features,
            preHooks: preHooks.length > 0 ? preHooks : undefined,
            postHooks: postHooks.length > 0 ? postHooks : undefined,
            debug: process.env.USER_BEHAVIOR_DEBUG === 'true',
          })

          evolution.setUserBehaviorLayer(userBehaviorLayer)
        }

        // ── MCP ↔ UserBehavior 强化回路 ──
        // 由 USER_BEHAVIOR_FEATURES 中的 mcp_feedback_loop 特性控制
        if (features.includes('mcp_feedback_loop')) {
          const { createMCPFeedbackLoop } = await import('../user-behavior/feedback-loop')
          const loopDebug = process.env.MCP_FEEDBACK_LOOP_DEBUG === 'true'
          this.feedbackLoop = createMCPFeedbackLoop({ initialMode: 'monitor', debug: loopDebug })
          // 如果启用了自动切换，监听收敛事件自动切到 auto
          if (features.includes('feedback_loop_auto_switch')) {
            eventBus.track(
              'feedback_loop.state_changed',
              (payload: any) => {
                if (payload.convergenceState === 'converged' && this.feedbackLoop?.getMode() === 'monitor') {
                  this.feedbackLoop?.setMode('auto')
                  log('INFO', 'mcp_feedback_loop_auto_switched', {
                    from: 'monitor',
                    to: 'auto',
                    adjustments: payload.totalAdjustments,
                  })
                }
              },
              this.subs,
              'runtime:feedback_loop_auto_switch',
            )
          }
          log('INFO', 'mcp_feedback_loop_initialized', {
            features,
            autoSwitch: features.includes('feedback_loop_auto_switch'),
            debug: loopDebug,
          })
        }
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

    // 行为驱动的主动记忆填充（在记忆索引之后启动）
    this.lazyInit!.add({
      name: 'behavior-memory-analyzer',
      priority: 'normal',
      delayMs: 1500,
      fn: async () => {
        this.behaviorMemoryAnalyzer?.start()
        log('INFO', 'behavior_memory_analyzer_started')
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
        // 用户情境语音覆盖回调（系统托盘菜单）
        setUserContextOverride((mode: string) => {
          const chatExec = agentService.getChatExecutor()
          if (chatExec) {
            chatExec.setUserContextOverride(mode as any)
          }
        })
        // 语音引擎偏好切换回调（系统托盘菜单）
        setEnginePreferenceToggle((pref: 'auto' | 'cloud' | 'local') => {
          ttsService.setEnginePreference(pref)
          credentialsManager.set('tts_mode', pref)
          updateEnginePreference(pref)
          log('INFO', 'tts_engine_preference_tray', { preference: pref })
        })
        log('INFO', 'evolution_dashboard_started')
      },
    })

    // 桌面悬浮任务面板 — 在壁纸 overlay 上显示 Agent 状态、计划进度与快捷操作
    this.lazyInit!.add({
      name: 'task-panel',
      priority: 'normal',
      delayMs: 150,
      fn: async () => {
        const taskPanel = new TaskPanelService()
        taskPanel.setAgentService(agentService)
        try {
          const { planManager } = await import('../evolution')
          taskPanel.setPlanManager(planManager)
        } catch {
          // planManager 不可用时降级
        }
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          taskPanel.setWindow(win)
          taskPanel.setVisible(true)
        }
        taskPanelRef.current = taskPanel
        // 托盘切换回调
        setTaskPanelToggle(() => {
          const tp = taskPanelRef.current
          if (tp) tp.toggleVisibility()
        })
        log('INFO', 'task_panel_service_started')
      },
    })

    // 自进化监控服务 — 定期推送系统指标和进化状态到壁纸
    this.lazyInit!.add({
      name: 'monitoring',
      priority: 'normal',
      delayMs: 300,
      fn: async () => {
        const monitoring = new MonitoringService()
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          monitoring.setWindow(win)
        }
        monitoring.start()
        this.monitoringService = monitoring
        log('INFO', 'monitoring_service_started')
      },
    })

    // 文件整理可视化进度服务 — 监听组织事件推送到壁纸 overlay
    this.lazyInit!.add({
      name: 'organizer-progress',
      priority: 'normal',
      delayMs: 400,
      fn: async () => {
        const organizer = new FileOrganizerProgressService()
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          organizer.setWindow(win)
        }
        this.organizerService = organizer
        this.organizerRef.current = organizer
        // 托盘控制回调
        setOrganizerPause(() => organizer.pause())
        setOrganizerResume(() => organizer.resume())
        setOrganizerSkip(() => organizer.skipCurrent())
        log('INFO', 'organizer_progress_service_started')
      },
    })

    // ── 语音字幕托盘切换 ──
    setSubtitleToggle(() => {
      const current = credentialsManager.get('tts_subtitle_enabled')
      const newState = current === 'false' ? 'true' : 'false'
      credentialsManager.set('tts_subtitle_enabled', newState)
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('tts:subtitle:toggle', { enabled: newState === 'true' })
      }
      log('INFO', 'tts_subtitle_toggled', { enabled: newState })
    })

    // 桌面记忆浮窗 — 定期从 Memory 获取高关联记忆推送到桌面 overlay
    this.lazyInit!.add({
      name: 'memory-context',
      priority: 'normal',
      delayMs: 500,
      fn: async () => {
        const memoryCtx = new MemoryContextService()
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          memoryCtx.setWindow(win)
        }
        memoryCtx.start()
        this.memoryContextService = memoryCtx
        this.memoryContextRef.current = memoryCtx
        log('INFO', 'memory_context_service_started')
      },
    })

    // 对话语境信息浮层 — 从 Memory 采集对话摘要、待办和进度，推送到桌面 overlay
    this.lazyInit!.add({
      name: 'conversation-context',
      priority: 'normal',
      delayMs: 600,
      fn: async () => {
        const convCtx = new ConversationContextService()
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          convCtx.setWindow(win)
        }
        convCtx.start()
        this.conversationContextService = convCtx
        this.conversationContextRef.current = convCtx
        log('INFO', 'conversation_context_service_started')
      },
    })

    // 壁纸事件总线桥接器 — 将壁纸状态变化以标准化 Schema 转发到 EventBus
    // Plan:TypeScript 执行器通过订阅这些事件实现松耦合响应
    this.lazyInit!.add({
      name: 'wallpaper-event-bridge',
      priority: 'normal',
      delayMs: 400,
      fn: async () => {
        const bridge = new WallpaperEventBridge()
        if (this.monitoringService) {
          bridge.start(this.monitoringService)
        } else {
          bridge.start()
        }
        // 同时订阅 PlanTypeScriptExecutor 到壁纸事件
        const { planTypeScriptExecutor } = await import('../learning/PlanTypeScriptExecutor')
        planTypeScriptExecutor.subscribeToWallpaperEvents()
        log('INFO', 'wallpaper_event_bridge_wired', {
          monitoringConnected: !!this.monitoringService,
        })
      },
    })

    // 壁纸监听 + CSS 热重载
    this.lazyInit!.add({
      name: 'wallpaper-listener',
      priority: 'background',
      delayMs: 3000,
      fn: async () => {
        setupWallpaperListener(stateManager)
        // 启动 CSS 热重载监听
        const { startWallpaperCssWatcher } = await import('../wallpaper/WallpaperService')
        const win = getMainWindow()
        if (win) {
          startWallpaperCssWatcher(process.cwd(), [win])
        }
      },
    })

    // 壁纸交互模式 — 全局快捷键 Ctrl+Space 切换桌面 Agent 面板
    this.lazyInit!.add({
      name: 'wallpaper-interactive',
      priority: 'normal',
      delayMs: 500,
      fn: async () => {
        const service = new WallpaperInteractiveService()
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          service.setWindow(win)
        }
        service.start()
        wallpaperInteractiveRef.current = service
        log('INFO', 'wallpaper_interactive_service_started', {})
      },
    })

    // 语音便签壁纸 — 全局快捷键 Ctrl+Shift+V + 托盘控制
    this.lazyInit!.add({
      name: 'voicenote',
      priority: 'normal',
      delayMs: 600,
      fn: async () => {
        const svc = new VoiceNoteService()
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          svc.setWindowRef(() => getMainWindow())
        }
        svc.start()
        this.voiceNoteService = svc
        this.voiceNoteRef.current = svc
        // 托盘回调
        setVoiceNoteToggle(() => {
          const s = this.voiceNoteRef.current
          if (s) s.toggle()
        })
        setVoiceNoteSave(async () => {
          const s = this.voiceNoteRef.current
          if (s) await s.save()
        })
        log('INFO', 'voicenote_service_started', {})
      },
    })

    // 用户行为追踪 — 驱动行为感知壁纸
    this.lazyInit!.add({
      name: 'user-behavior',
      priority: 'normal',
      delayMs: 2000,
      fn: async () => {
        const { UserBehaviorService } = await import('../behavior/UserBehaviorService')
        const behavior = new UserBehaviorService()
        behavior.start()

        // ── 注册 UserBehavior 为 Wallpaper 插件 ──
        // UserBehaviorPluginAdapter 实现 IBehaviorProvider 契约，
        // WallpaperPluginRegistry 在运行时发现并加载此插件。
        // UserBehavior 只需实现契约，不关心 Wallpaper 的内部调度。
        const { WallpaperPluginRegistry, UserBehaviorPluginAdapter } = await import('../wallpaper/plugin')
        const wpRegistry = WallpaperPluginRegistry.getInstance()
        wpRegistry.register(new UserBehaviorPluginAdapter(behavior))
        await wpRegistry.loadAll()
        log('INFO', 'user_behavior_wallpaper_plugin_registered', {
          hasProvider: !!wpRegistry.getBehaviorProvider(),
        })

        log('INFO', 'user_behavior_service_started')
      },
    })

    // 行为周期性预测预加载服务（行为预测 + 哑提醒推送）
    this.lazyInit!.add({
      name: 'periodic-prediction',
      priority: 'normal',
      delayMs: 5000,
      fn: async () => {
        const { behaviorPeriodicPreloadService } = await import('../behavior/BehaviorPeriodicPreloadService')
        const mainWindow = getMainWindow()

        // 注入渲染进程通知函数（通过 IPC 推送哑提醒）
        behaviorPeriodicPreloadService.setNotifyRenderer((event) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('behavior:prediction', event)
          }
        })

        // 启动周期性检查（每 15 分钟）
        behaviorPeriodicPreloadService.start()
        log('INFO', 'periodic_prediction_service_started')
      },
    })

    // 行为频率计数器（桌面快捷入口）
    this.lazyInit!.add({
      name: 'behavior-action-counter',
      priority: 'normal',
      delayMs: 3000,
      fn: async () => {
        const { behaviorActionCounter } = await import('../behavior/BehaviorActionCounter')
        behaviorActionCounter.start()
        log('INFO', 'behavior_action_counter_started')
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
