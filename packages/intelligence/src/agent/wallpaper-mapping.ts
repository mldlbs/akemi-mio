/**
 * Agent 模块 Wallpaper 化改造 — 子模块分解与能力映射
 *
 * 将 Agent 模块按独立程度拆分为子模块，标记每个子模块是否适合
 * 被 Wallpaper 的能力替代，指导增量迁移。
 *
 * 迁移策略（小步快跑）：
 * 1. 每轮替换一个边界清晰、影响面小的子模块
 * 2. 替换后运行一个月观察稳定性
 * 3. 新旧混合期保持接口兼容性
 * 4. 新代码优先通过 WallpaperPluginRegistry 获取能力
 *
 * 架构关系：
 *   WallpaperPluginRegistry (ServiceLoader)
 *       ↕  AgentWallpaperBridge (增量迁移桥梁)
 *   AgentPluginRegistry (ServiceLoader)
 *       ↕  各子模块实现
 *
 * @see AgentWallpaperBridge — 桥接两套 PluginRegistry 的迁移基础设施
 */

// ════════════════════════════════════════════════════════════
//  类型定义
// ════════════════════════════════════════════════════════════

/** 子模块独立程度 — 与核心 Chat 逻辑的耦合度 */
export type IndependenceLevel =
  | 'core' // 核心耦合，不可抽取
  | 'semi_independent' // 半独立，可抽象为接口
  | 'independent' // 完全独立，可安全替换

/** Wallpaper 替换适宜度 */
export type WallpaperSuitability =
  | 'ready' // 当前即适合替换（无需改造）
  | 'minor_refactor' // 小重构后可替换
  | 'major_refactor' // 需重大重构
  | 'not_suitable' // 不适合（核心逻辑，无 Wallpaper 等价物）

/** 迁移优先级 */
export type MigrationPriority = 1 | 2 | 3 | 4 | 5

/** 子模块 Wallpaper 能力映射 */
export interface AgentSubModuleMapping {
  /** 子模块名称 */
  name: string
  /** 源文件路径（相对于 src/main/） */
  sourcePath: string
  /** 简短功能描述 */
  description: string
  /** 独立程度 */
  independence: IndependenceLevel
  /** Wallpaper 替换适宜度 */
  wallpaperSuitability: WallpaperSuitability
  /** 迁移优先级（1=最高，5=最低） */
  priority: MigrationPriority
  /** 目标 Wallpaper 能力标识（如适用） */
  wallpaperCapability?: string
  /** 迁移前提条件 / 注意事项 */
  prereqs?: string[]
  /** 替换方案概述 */
  migrationPlan?: string
  /** 与核心 Chat/Task 逻辑的接口接触点 */
  integrationPoints?: string[]
}

// ════════════════════════════════════════════════════════════
//  完整子模块映射表
// ════════════════════════════════════════════════════════════
//
//  按替换优先级从高到低排列（Priority 1 = 最先替换）

export const AGENT_SUB_MODULE_MAPPINGS: AgentSubModuleMapping[] = [
  // ╔══════════════════════════════════════════════════════════╗
  //  ║  Priority 1: 可立即替换的独立子模块                      ║
  //  ╚══════════════════════════════════════════════════════════╝

  // ──────────── 1. ContentClassifier ────────────
  {
    name: 'ContentClassifier',
    sourcePath: 'agent/ContentClassifier.ts',
    description: '基于正则的消息内容类型分类（chat/writing/image_gen/evolution/creativity/dream）',
    independence: 'independent',
    wallpaperSuitability: 'ready',
    priority: 1,
    wallpaperCapability: 'content_classifier',
    migrationPlan:
      '将分类函数注册为 WallpaperPluginRegistry 的 content_classifier 能力插件。ChatExecutor 改为通过 WallpaperPluginRegistry 获取分类结果，保留回退路径。',
    integrationPoints: ['ChatExecutor.run() → classifyContent()', 'renderer store'],
  },

  // ──────────── 2. SleepCycle ────────────
  {
    name: 'SleepCycle',
    sourcePath: 'agent/SleepCycle.ts',
    description: '低负载时触发的后台维护循环（记忆固化、失败模式挖掘）',
    independence: 'independent',
    wallpaperSuitability: 'ready',
    priority: 1,
    wallpaperCapability: 'sleep_maintenance',
    prereqs: ['保留 AgentService.setDeps() 传入的 MemoryService 引用'],
    migrationPlan:
      'SleepCycle 的调度由 Wallpaper 接管，作为 periodic plugin 在系统空闲时触发。AgentService 不再维护 SleepCycle 实例，改为查询 WallpaperPluginRegistry 获取 sleep_maintenance 插件。',
    integrationPoints: ['AgentService.runSelfTask() → 完成后触发', 'AgentService.isBusy() 作为触发条件'],
  },

  // ╔══════════════════════════════════════════════════════════╗
  //  ║  Priority 2: 小重构后可替换的子模块                      ║
  //  ╚══════════════════════════════════════════════════════════╝

  // ──────────── 3. ErrorClassifier ────────────
  {
    name: 'ErrorClassifier',
    sourcePath: 'agent/ErrorClassifier.ts',
    description: 'LLM 错误分类（RETRYABLE/CONTEXT_OVERFLOW/INVALID_REQUEST/CORRUPTED_STATE 等）',
    independence: 'independent',
    wallpaperSuitability: 'minor_refactor',
    priority: 2,
    wallpaperCapability: 'error_classifier',
    migrationPlan: '将 classify 函数包装为 Wallpaper 插件。ChatExecutor.handleLlmError() 改为通过 Wallpaper 查询分类结果。',
    integrationPoints: ['ChatExecutor.handleLlmError()', 'AgentService.runSelfTask()'],
  },

  // ──────────── 4. CheckpointScheduler ────────────
  {
    name: 'CheckpointScheduler (evaluateMilestone)',
    sourcePath: 'agent/CheckpointScheduler.ts',
    description: '检查点调度决策 — 判断何时应创建恢复检查点',
    independence: 'independent',
    wallpaperSuitability: 'minor_refactor',
    priority: 2,
    wallpaperCapability: 'checkpoint_scheduler',
    migrationPlan: 'evaluateMilestone 函数注册为 Wallpaper 插件。ChatExecutor.checkMilestone() 改为通过 Wallpaper 查询调度决策。',
    integrationPoints: ['ChatExecutor.checkMilestone()'],
  },

  // ╔══════════════════════════════════════════════════════════╗
  //  ║  Priority 3: 可抽象为接口 / 插件化子模块                   ║
  //  ╚══════════════════════════════════════════════════════════╝

  // ──────────── 5. ExecutionGovernor ────────────
  {
    name: 'ExecutionGovernor',
    sourcePath: 'agent/ExecutionGovernor.ts',
    description: '工具执行批次的强制决策门（continue/stop/shift），与 Guardrail 互补',
    independence: 'semi_independent',
    wallpaperSuitability: 'major_refactor',
    priority: 3,
    wallpaperCapability: 'execution_governor',
    prereqs: ['需要定义 GovernorDecision 的标准化 Wallpaper 事件', 'AgentWallpaperBridge 需要支持决策型数据流（不仅是行为数据）'],
    migrationPlan: 'ExecutionGovernor 的状态机包装为 Wallpaper 插件，通过 WallpaperEventBridge 接收 tool batch 事件并返回决策。',
    integrationPoints: ['ChatExecutor.toolLoop() → 每轮 tool batch 后调用'],
  },

  // ──────────── 6. ProgressGuardrail ────────────
  {
    name: 'ProgressGuardrail',
    sourcePath: 'agent/ProgressGuardrail.ts',
    description: '跨轮进度停滞检测（Zero-Output Creep），与 Guardrail 类互补',
    independence: 'semi_independent',
    wallpaperSuitability: 'major_refactor',
    priority: 3,
    wallpaperCapability: 'progress_guardrail',
    prereqs: ['需要 EventBus 支持跨轮状态传递'],
    migrationPlan:
      '通过 WallpaperEventBridge 订阅 agent.progress 事件，状态机在 Wallpaper 侧维护停滞计数。当检测到停滞时通过 EventBus 通知 ChatExecutor。',
    integrationPoints: ['ChatExecutor.toolLoop() → Guardrail.apply() 后调用'],
  },

  // ──────────── 7. ProceduralMemory ────────────
  {
    name: 'ProceduralMemory',
    sourcePath: 'agent/ProceduralMemory.ts',
    description: '流程记忆：记录成功/失败的工具调用模式，提供上下文注入',
    independence: 'semi_independent',
    wallpaperSuitability: 'major_refactor',
    priority: 3,
    wallpaperCapability: 'procedural_memory',
    prereqs: ['需要定义 StandardizedProcedureRecord 接口'],
    migrationPlan: 'ProceduralMemory 包装为 IWallpaperPlugin（behavior_provider 能力），向 Wallpaper 系统提供工具调用模式数据。',
    integrationPoints: ['ChatExecutor.toolLoop() → runObserve() 读取', 'ObserveStagePluginAdapter 依赖'],
  },

  // ──────────── 8. FailureAnalyzer ────────────
  {
    name: 'FailureAnalyzer',
    sourcePath: 'agent/FailureAnalyzer.ts',
    description: '失败模式分析与持久化，与 ProceduralMemory 互补',
    independence: 'semi_independent',
    wallpaperSuitability: 'major_refactor',
    priority: 3,
    wallpaperCapability: 'failure_analyzer',
    prereqs: ['需要标准化 FailureRecord 接口'],
    migrationPlan: 'FailureAnalyzer 包装为 IWallpaperPlugin，通过行为插件契约提供失败模式数据给 Overlay 展示。',
    integrationPoints: [
      'ChatExecutor.toolLoop() → runObserve() 读取',
      'SleepCycle.mineFailurePatterns() 依赖',
      'ObserveStagePluginAdapter 依赖',
    ],
  },

  // ──────────── 9. ReflectLoop ────────────
  {
    name: 'ReflectLoop',
    sourcePath: 'agent/ReflectLoop.ts',
    description: '交互后反思：记录对话摘要、检测进化信号',
    independence: 'semi_independent',
    wallpaperSuitability: 'major_refactor',
    priority: 3,
    wallpaperCapability: 'reflect_loop',
    prereqs: ['需要 ReflectSignal 标准化为 Wallpaper 事件'],
    migrationPlan: 'ReflectLoop 注册为 Wallpaper 的 reflect_loop 能力插件，通过 EventBus 接收 agent.response.generated 事件。',
    integrationPoints: ['ChatExecutor.run() → 每轮对话后 trigger()', 'AgentService.refreshMemoryInContext() 依赖'],
  },

  // ╔══════════════════════════════════════════════════════════╗
  //  ║  Priority 4: 需要重大重构的子模块                         ║
  //  ╚══════════════════════════════════════════════════════════╝

  // ──────────── 10. UserBehaviorAnalyzer ────────────
  {
    name: 'UserBehaviorAnalyzer',
    sourcePath: 'agent/UserBehaviorAnalyzer.ts',
    description: '用户行为驱动的工具预激活、话题模式检测、场景分类与自适应回复模式',
    independence: 'semi_independent',
    wallpaperSuitability: 'major_refactor',
    priority: 4,
    wallpaperCapability: 'behavior_analyzer',
    prereqs: [
      'Wallpaper 端已有 UserBehaviorPluginAdapter（行为提供者）',
      'Agent 端的 UserBehaviorAnalyzer 是独立的行为分析器，与 Wallpaper 端的重复',
      '需要统一事件通道避免数据竞争',
    ],
    migrationPlan:
      'Agent 端的 UserBehaviorAnalyzer 逐步迁移为消费 Wallpaper 的行为数据。先做只读迁移：UserBehaviorAnalyzer 改为通过 WallpaperPluginRegistry.getBehaviorProvider() 获取行为快照。后续 Agent 端的行为分析由 Wallpaper 统一承担。',
    integrationPoints: [
      'ChatExecutor.refreshMemory() → analyze() 注入 extraModules',
      'ChatExecutor.toolLoop() → recordToolCall() 记录',
      'ChatExecutor.run() → 多行行为交互',
    ],
  },

  // ──────────── 11. Guardrail ────────────
  {
    name: 'Guardrail',
    sourcePath: 'agent/Guardrail.ts',
    description: '工具循环安全护栏：工具白名单、调用频率限制、内容安全过滤',
    independence: 'semi_independent',
    wallpaperSuitability: 'major_refactor',
    priority: 4,
    wallpaperCapability: 'guardrail_provider',
    prereqs: ['Guardrail 有实时决策需求（低延迟），Wallpaper 插件调用需满足延迟约束'],
    migrationPlan:
      'Guardrail 规则引擎包装为 Wallpaper 插件，但核心执行路径保持在内联（避免 IPC 延迟）。Wallpaper 插件仅做配置管理和规则热更新。',
    integrationPoints: ['ChatExecutor.toolLoop() → 每轮工具调用前/后'],
  },

  // ──────────── 12. PersonaStateManager ────────────
  {
    name: 'PersonaStateManager',
    sourcePath: 'agent/PersonaStateManager.ts',
    description: '人格仲裁管理：检测用户意图映射到对应人格级别',
    independence: 'semi_independent',
    wallpaperSuitability: 'major_refactor',
    priority: 4,
    wallpaperCapability: 'persona_manager',
    prereqs: ['PersonaStateManager 有实时决策需求'],
    migrationPlan:
      '包装为 Wallpaper 插件，人格状态通过 EventBus 发布到 Wallpaper 渲染层。Persona changes 通过 agent.persona.updated 事件通知 Wallpaper。',
    integrationPoints: ['ChatExecutor.resolvePersonaFor()', 'ChatExecutor.refreshMemory()'],
  },

  // ──────────── 13. PersonaDriftControlSystem ────────────
  {
    name: 'PersonaDriftControlSystem',
    sourcePath: 'agent/PersonaDriftControlSystem.ts',
    description: '人格漂移检测与修正，评估 Agent 输出是否符合当前人格',
    independence: 'semi_independent',
    wallpaperSuitability: 'major_refactor',
    priority: 4,
    wallpaperCapability: 'drift_control',
    prereqs: ['需要标准化 DriftEvaluation 接口'],
    migrationPlan: '通过 WallpaperEventBridge 接收 agent.response.generated 事件，漂移评估在 Wallpaper 侧运行。',
    integrationPoints: ['ChatExecutor.run() → 输出后 evaluateOutput()'],
  },

  // ╔══════════════════════════════════════════════════════════╗
  //  ║  Priority 5: 核心子模块（不适合 Wallpaper 替换）          ║
  //  ╚══════════════════════════════════════════════════════════╝

  // ──────────── 14. ChatExecutor ────────────
  {
    name: 'ChatExecutor',
    sourcePath: 'agent/ChatExecutor.ts',
    description: 'Chat Runtime 核心执行器：独立的 ConversationContext + toolLoop',
    independence: 'core',
    wallpaperSuitability: 'not_suitable',
    priority: 5,
    migrationPlan: '核心 Chat 执行器，不适合 Wallpaper 替换。但可消费 Wallpaper 插件提供的能力（行为数据、分类等）。',
    integrationPoints: ['所有子模块的消费端'],
  },

  // ──────────── 15. TaskExecutor ────────────
  {
    name: 'TaskExecutor',
    sourcePath: 'agent/TaskExecutor.ts',
    description: 'Evolution 循环执行引擎（P1 优先级，受 Budget 限流）',
    independence: 'core',
    wallpaperSuitability: 'not_suitable',
    priority: 5,
    migrationPlan: '核心任务执行器，不适合 Wallpaper 替换。其进度状态可通过 Wallpaper EvolutionDashboardService 展示。',
    integrationPoints: ['AgentService.runSelfTask() → TaskExecutor.run()'],
  },

  // ──────────── 16. AgentService ────────────
  {
    name: 'AgentService',
    sourcePath: 'agent/AgentService.ts',
    description: 'Agent 引擎主服务，实现 IEngineService，统筹所有子模块',
    independence: 'core',
    wallpaperSuitability: 'not_suitable',
    priority: 5,
    migrationPlan: 'Agent 引擎主入口，不适合 Wallpaper 替换。但其子模块消费接口逐步迁移到 WallpaperPluginRegistry。',
    integrationPoints: ['所有子模块的管理端'],
  },

  // ──────────── 17. SubAgentPool ────────────
  {
    name: 'SubAgentPool',
    sourcePath: 'agent/SubAgentPool.ts',
    description: '子 Agent 池：管理独立子 Agent 的生成、运行和回收',
    independence: 'core',
    wallpaperSuitability: 'not_suitable',
    priority: 5,
    migrationPlan: '核心基础设施，不适合 Wallpaper 替换。但子 Agent 状态可通过 Wallpaper 展示。',
    integrationPoints: ['AgentService.runAgentTask()', 'ChatExecutor 间接依赖'],
  },

  // ──────────── 18. WorkingMemory ────────────
  {
    name: 'WorkingMemory',
    sourcePath: 'agent/WorkingMemory.ts',
    description: 'Chat 工作记忆：管理当前会话的上下文、scratchpad 和 token budget',
    independence: 'core',
    wallpaperSuitability: 'not_suitable',
    priority: 5,
    migrationPlan: '核心数据结构，不适合 Wallpaper 替换。',
    integrationPoints: ['ChatExecutor 全程使用'],
  },

  // ──────────── 19. SessionRecoveryManager ────────────
  {
    name: 'SessionRecoveryManager',
    sourcePath: 'agent/SessionRecoveryManager.ts',
    description: '会话恢复管理：检查点创建、中断恢复、循环检测',
    independence: 'core',
    wallpaperSuitability: 'not_suitable',
    priority: 5,
    migrationPlan: '核心可靠性基础设施，不适合 Wallpaper 替换。',
    integrationPoints: ['AgentService.setRecoveryManager()', 'ChatExecutor.checkMilestone()'],
  },

  // ──────────── 20. AgentPluginRegistry ────────────
  {
    name: 'AgentPluginRegistry',
    sourcePath: 'agent/plugin/AgentPluginRegistry.ts',
    description: 'Agent 插件运行时加载器（ServiceLoader 模式），Agent 侧的能力市场',
    independence: 'semi_independent',
    wallpaperSuitability: 'not_suitable',
    priority: 5,
    migrationPlan:
      '保留作为 Agent 侧插件注册表。通过 AgentWallpaperBridge 与 WallpaperPluginRegistry 建立发现通道。不会被 Wallpaper 替换。',
    integrationPoints: ['AgentService.registerBuiltinPlugins()', 'AgentWallpaperBridge 连接目标'],
  },

  // ──────────── 21. ToolScheduler ────────────
  {
    name: 'ToolScheduler',
    sourcePath: 'agent/ToolScheduler.ts',
    description: 'MCP 工具执行调度器：并发执行、结果聚合、请求去重',
    independence: 'core',
    wallpaperSuitability: 'not_suitable',
    priority: 5,
    migrationPlan: '核心工具执行层，不适合 Wallpaper 替换。',
    integrationPoints: ['ChatExecutor.toolLoop() → executeAll()'],
  },

  // ──────────── 22. Cognitive Stage Plugins ────────────
  {
    name: 'CognitiveStagePlugins (Observe/Think/Reflect)',
    sourcePath: 'agent/plugin/ (ObserveStagePluginAdapter, ThinkStagePluginAdapter, ReflectStagePluginAdapter)',
    description: '认知阶段插件：OTPAR 管线中 Observe/Think/Reflect 的 AgentPluginRegistry 实现',
    independence: 'semi_independent',
    wallpaperSuitability: 'not_suitable',
    priority: 5,
    migrationPlan:
      '保留在 AgentPluginRegistry 中。认知阶段是 Agent 运行时的核心环节，不适合抽象到 Wallpaper 层。但阶段结果可通过 EventBus 广播到 Wallpaper 展示。',
    integrationPoints: ['ChatExecutor.toolLoop() → runObserve/runThink/runReflect'],
  },

  // ──────────── 23. AgentState ────────────
  {
    name: 'AgentState',
    sourcePath: 'agent/AgentState.ts',
    description: '通用 Agent 三维状态向量（mode × stage × lifecycle）',
    independence: 'independent',
    wallpaperSuitability: 'not_suitable',
    priority: 5,
    migrationPlan: '值类型/状态机，不适合 Wallpaper 替换。状态快照可通过 EventBus 同步到 Wallpaper 展示。',
    integrationPoints: ['ChatExecutor/TaskExecutor 内部使用'],
  },

  // ──────────── 24. ContextIntegrityChecker ────────────
  {
    name: 'ContextIntegrityChecker',
    sourcePath: 'agent/ContextIntegrityChecker.ts',
    description: '工具调用链完整性校验和回滚',
    independence: 'core',
    wallpaperSuitability: 'not_suitable',
    priority: 5,
    migrationPlan: '核心数据完整性校验，不适合 Wallpaper 替换。',
    integrationPoints: ['ChatExecutor.handleLlmError()'],
  },
]

// ════════════════════════════════════════════════════════════
//  便捷查询函数
// ════════════════════════════════════════════════════════════

/** 按独立程度过滤子模块映射 */
export function getByIndependence(level: IndependenceLevel): AgentSubModuleMapping[] {
  return AGENT_SUB_MODULE_MAPPINGS.filter((m) => m.independence === level)
}

/** 按 Wallpaper 替换适宜度过滤 */
export function getByWallpaperSuitability(suitability: WallpaperSuitability): AgentSubModuleMapping[] {
  return AGENT_SUB_MODULE_MAPPINGS.filter((m) => m.wallpaperSuitability === suitability)
}

/** 按迁移优先级过滤 */
export function getByPriority(priority: MigrationPriority): AgentSubModuleMapping[] {
  return AGENT_SUB_MODULE_MAPPINGS.filter((m) => m.priority === priority)
}

/** 优先替换队列（优先级 1+2，适合立即可替换或小重构的模块） */
export function getPriorityReplacementQueue(): AgentSubModuleMapping[] {
  return AGENT_SUB_MODULE_MAPPINGS.filter((m) => m.priority <= 2 && m.wallpaperSuitability !== 'not_suitable').sort(
    (a, b) => a.priority - b.priority,
  )
}

/** 获取指定名称的子模块映射 */
export function getByName(name: string): AgentSubModuleMapping | undefined {
  return AGENT_SUB_MODULE_MAPPINGS.find((m) => m.name === name || m.name.startsWith(name))
}

// ════════════════════════════════════════════════════════════
//  迁移阶段概览
// ════════════════════════════════════════════════════════════

/**
 * 建议的迁移阶段：
 *
 * Phase 0 (当前): 搭建 AgentWallpaperBridge + 扩展 Wallpaper 类型
 * Phase 1: 替换 ContentClassifier（纯函数，无状态）
 * Phase 2: 替换 SleepCycle（独立后台任务）
 * Phase 3: 替换 ErrorClassifier + CheckpointScheduler
 * Phase 4: 插件化 ExecutionGovernor + ProgressGuardrail
 * Phase 5: 整合 UserBehaviorAnalyzer → Wallpaper 统一行为源
 */
export const MIGRATION_PHASES = [
  {
    phase: 0,
    name: '基础设施搭建',
    description: '扩展 WallpaperPluginCapability 类型、创建 AgentWallpaperBridge',
    modules: ['（无模块替换）'],
  },
  {
    phase: 1,
    name: '纯函数替换',
    description: '替换无状态的纯函数子模块',
    modules: ['ContentClassifier'],
  },
  {
    phase: 2,
    name: '独立后台任务替换',
    description: '替换有状态但独立运行的后台任务',
    modules: ['SleepCycle'],
  },
  {
    phase: 3,
    name: '工具型函数替换',
    description: '替换有明确输入/输出边界的工具函数',
    modules: ['ErrorClassifier', 'CheckpointScheduler'],
  },
  {
    phase: 4,
    name: '状态机插件化',
    description: '将有状态的状态机包装为 Wallpaper 插件',
    modules: ['ExecutionGovernor', 'ProgressGuardrail'],
  },
  {
    phase: 5,
    name: '行为分析统一',
    description: '将 Agent 端的行为分析逐步迁移到 Wallpaper 统一行为源',
    modules: ['UserBehaviorAnalyzer', 'ProceduralMemory', 'FailureAnalyzer'],
  },
]
