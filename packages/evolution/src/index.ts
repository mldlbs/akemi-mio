import { DrizzlePlanManager } from '@akemi-mio/evolution-core'
import { SelfEvolutionService } from './SelfEvolutionService'
import { type DevPlan } from './types'
import { AgentService } from '@akemi-mio/intelligence/agent/AgentService'
import { EvolutionHistoryManager } from '@akemi-mio/evolution-core'
import { EvolutionStateManager } from '@akemi-mio/evolution-core'
import { EvolutionGitOps, RollbackLevel } from '@akemi-mio/evolution-core'
import { ProposalValidator } from '@akemi-mio/evolution-core'
import { ANALYSIS_PROMPT, PLAN_EXECUTE_PROMPT, detectPlanMode, pickBestPlan, buildPlanInjection } from '@akemi-mio/evolution-core'
import type { AnalysisMode } from '@akemi-mio/evolution-core'
import type { PlanManagerLike } from './types'
import type { EvolutionSafetyMode } from './types'
import type { Proposal, ProposalValidation } from '@akemi-mio/evolution-core'

export { EvolutionHistoryManager } from '@akemi-mio/evolution-core'
export type { EvolutionHistoryEntry, EvolutionHistory } from '@akemi-mio/evolution-core'
export { StateBroadcaster } from '@akemi-mio/evolution-core'
export type { DashboardLiveSnapshot, DashboardLivePayload } from '@akemi-mio/evolution-core'
export { EvolutionStateManager } from '@akemi-mio/evolution-core'
export { EvolutionGitOps } from '@akemi-mio/evolution-core'
export { RollbackLevel } from '@akemi-mio/evolution-core'
export { EvolutionCheckpointManager, evolutionCheckpointManager } from '@akemi-mio/evolution-core'
export type { CheckpointContext, UnfinishedCheckpoint } from '@akemi-mio/evolution-core'
export { ProposalValidator } from '@akemi-mio/evolution-core'
export type { Proposal, ProposalValidation } from '@akemi-mio/evolution-core'
export { ANALYSIS_PROMPT, PLAN_EXECUTE_PROMPT, detectPlanMode, pickBestPlan, buildPlanInjection } from '@akemi-mio/evolution-core'
export type { AnalysisMode } from '@akemi-mio/evolution-core'
export { SelfEvolutionService, EvolutionSchedulerState as ServiceSchedulerState } from './SelfEvolutionService'
export { PipelineOrchestrator } from './automation'
export type { PipelineConfig, PipelineMetrics, Problem, SignalCollector, FixExecutor, FixResult } from './automation'
export type { EvolutionSafetyMode } from './types'
export type { PlanManagerLike } from './types'

// ═══════════════════════════════════════════
//  自进化文件整理引擎
// ═══════════════════════════════════════════
//
//  基于进化系统的自适应文件整理模块：
//  - Evolution 周期性扫描工作区文件并自动归类
//  - 规则基因池（JSON 条件-动作对）支持进化
//  - 用户行为反馈作为适应度函数
//  - 优胜劣汰，工作区结构逐渐适配个人习惯

export {
  GenePool,
  FileScanner,
  FeedbackTracker,
  FileOrganizerCollector,
  FileOrganizerExecutor,
  genePool,
  fileScanner,
  feedbackTracker,
} from '@akemi-mio/evolution-file-organizer'

export type {
  FileFeatures,
  OrganizerRule,
  RuleCondition,
  RuleAction,
  GenePoolData,
  FileMoveRecord,
  EvolutionConfig,
  ConditionType,
  ConditionOperator,
  ActionType,
} from '@akemi-mio/evolution-file-organizer'

export { DEFAULT_EVOLUTION_CONFIG, createDefaultRules } from '@akemi-mio/evolution-file-organizer'

// Pipeline 阶段导出
export { EvolutionAnalyzer, EvolutionStrategizer, EvolutionExecutor, EvolutionReviewer, setSandboxRoot } from '@akemi-mio/evolution-pipeline'
export type {
  AnalysisInput,
  AnalysisResult,
  StrategyContext,
  ExecutionInput,
  ExecutionResult,
  ReviewInput,
  ReviewResult,
  IEvolutionStage,
  IAnalyzer,
  IStrategizer,
  IExecutor,
  IReviewer,
} from '@akemi-mio/evolution-pipeline/types'

// ═══════════════════════════════════════════
//  Evolution Plugin System — Plugin 契约 + ServiceLoader
// ═══════════════════════════════════════════
//
// EvolutionPlugin 是 Evolution 能力的插件化接口。
// 插件通过 PluginServiceLoader 注册，Evolution 在运行时通过
// ServiceLoader 发现并加载插件，插件无需关心 Evolution 内部调度。
//
// 当前内置插件：
//   - WallpaperPlugin — 壁纸检测与优化

export { PluginServiceLoader, PluginCollectorAdapter, PluginExecutorAdapter, WallpaperPlugin } from '@akemi-mio/evolution-plugin-system'

export type { EvolutionPlugin, EvolutionPluginManifest, EvolutionCapability, PluginProblem, PluginFixResult } from '@akemi-mio/evolution-plugin-system'

// ═══════════════════════════════════════════
//  UserBehavior Layer — 可选的上层增强层
// ═══════════════════════════════════════════
//
// 通过环境变量 USER_BEHAVIOR_FEATURES 控制激活。
// 启用后，在 evolutionService 之上创建 UserBehaviorLayer 实例
// 作为装饰器，拦截 evolution 的输入输出进行预处理/后处理增强。
//
// 示例：
//   USER_BEHAVIOR_FEATURES=summary_enhance,metrics_enrich
//
// 所有特性默认关闭，仅在显式声明后激活。
//
// UserBehaviorLayer 不会修改核心 evolution 逻辑，
// 而是通过钩子机制在外部增强其行为。

export { UserBehaviorLayer } from '@akemi-mio/evolution/user-behavior/UserBehaviorLayer'
export { parseFeaturesFromEnv } from '@akemi-mio/evolution/user-behavior/types'
export type {
  UserBehaviorFeature,
  UserBehaviorConfig,
  PreProcessContext,
  PostProcessContext,
  PostProcessResult,
  PreProcessHook,
  PostProcessHook,
} from '@akemi-mio/evolution/user-behavior/types'

// ═══════════════════════════════════════════
//  Evolution × PiperTTS 深度融合
// ═══════════════════════════════════════════
//
// 通过 EvolutionPiperBridge 将 Evolution 的状态变化同步到 PiperTTS，
// 同时将 PiperTTS 的性能反馈作为 Evolution 的新输入维度。
//
// 导出：
//   - EvolutionPiperBridge / evolutionPiperBridge — 桥接器单例
//   - PiperEvolutionPlugin — Evolution 插件
//   - 所有共享类型

export { EvolutionPiperBridge, evolutionPiperBridge, PiperEvolutionPlugin } from '@akemi-mio/evolution-piper-evolution'

export type {
  EvolutionToPiperState,
  PiperToEvolutionFeedback,
  EvolutionPiperSharedContext,
  EvolutionPiperBridgeConfig,
  EvolutionSchedulerExposure,
  EvolutionSafetyExposure,
  PiperModelPerformanceSnapshot,
  PiperProblemDescriptor,
  PiperProblemCategory,
} from '@akemi-mio/evolution-piper-evolution'

export { DEFAULT_EVOLUTION_PIPER_BRIDGE_CONFIG } from '@akemi-mio/evolution-piper-evolution'

// ═══════════════════════════════════════════════
//  记忆驱动的参数自进化系统
// ═══════════════════════════════════════════════
//
// Parameter Self-Evolution — 利用 Memory 中的用户交互反馈
// (点赞/踩、重复提问、中断率) 自动调优系统参数。
//
// 核心组件：
//   - parameterRegistry — 可调参数注册中心
//   - feedbackMetadataStore — 带时间戳的反馈数据存储
//   - parameterSelfEvolutionAnalyzer — 24h 分析循环（Collector）
//   - ParameterSelfEvolutionExecutor — 提案执行器
//   - parameterHotReloader — 参数热更新 + 回滚
//
// 使用方式：
//   1. feedbackMetadataStore.init(); parameterHotReloader.init()
//   2. parameterSelfEvolutionAnalyzer.setLlmService(llmService)
//   3. 已自动注册到 PipelineOrchestrator.initDefaults()
//
// 安全措施：
//   - 所有参数有安全范围 (min/max)
//   - 单次调整幅度有上限 (maxDeltaPerAdjustment)
//   - 变更前自动创建快照，支持回滚
//   - 自动检测指标恶化并建议回滚

export {
  ParameterRegistry,
  parameterRegistry,
  FeedbackMetadataStore,
  feedbackMetadataStore,
  ParameterSelfEvolutionAnalyzer,
  parameterSelfEvolutionAnalyzer,
  ParameterSelfEvolutionExecutor,
  ParameterHotReloader,
  parameterHotReloader,
} from '@akemi-mio/evolution-self-parameter'

export type {
  TunableParameter,
  ParameterCategory,
  FeedbackDataPoint,
  FeedbackMetricCategory,
  FeedbackMetricAnalysis,
  ParameterAdjustmentProposal,
  ParameterSelfEvolutionReport,
  ParameterSnapshot,
  RollbackRecord,
} from '@akemi-mio/evolution-self-parameter'

// ═══════════════════════════════════════════════════════════════
//  进化行为反馈闭环 — Evolution Feedback Loop
// ═══════════════════════════════════════════════════════════════
//
// 自进化行为反馈闭环：让 Evolution 系统利用用户行为数据自动调整策略。
// 在进化计划执行后，收集用户交互反馈（撤销操作、重试请求）作为负样本，
// 用于调整代码分析器的权重。
//
// 核心组件：
//   - moduleFeedbackManager — 模块级反馈状态管理器
//   - evolutionFeedbackCollector — 进化反馈采集器（SignalCollector）
//
// 集成方式：
//   1. moduleFeedbackManager.init() 在 SelfEvolutionService.init() 中调用
//   2. ModuleFeedbackManager 在管道执行周期中自动被 BehaviorPriorityWeighter 读取
//   3. EvolutionFeedbackCollector 作为 SignalCollector 注册到 PipelineOrchestrator
//
// 反馈策略：
//   - Git 回滚: 降低 modificationPriority (-0.2), 提高 regressionPriority (+0.3)
//   - 错误率飙升: 降低 modificationPriority (-0.15), 提高 regressionPriority (+0.2)
//   - 工具重试: 降低 modificationPriority (-0.1), 提高 regressionPriority (+0.15)
//   - 权重每日向默认值衰减 10%, 防止策略永久偏移

export { ModuleFeedbackManager, moduleFeedbackManager, EvolutionFeedbackCollector, evolutionFeedbackCollector } from '@akemi-mio/evolution-feedback'

export type {
  EvolutionModuleChange,
  EvolutionPlanRecord,
  RejectionSignalType,
  RejectionSignal,
  ModuleFeedbackState,
  FeedbackStore,
  EvolutionFeedbackSignalEvent,
  ModuleWeightAdjustedEvent,
} from '@akemi-mio/evolution-feedback'

// ═══════════════════════════════════════════
//  Memory × Evolution 深度融合桥接器
// ═══════════════════════════════════════════
//
// MemoryEvolutionBridge 是 Memory 和 Evolution 之间的统一接口层。
// 通过 setMemoryBridge() 注入到 SelfEvolutionService，
// 实现双向往来数据融合：
//   - Memory → Evolution：长时记忆上下文注入
//   - Evolution → Memory：进化结果持久化
//
// 桥接器单例定义在 src/main/memory/MemoryEvolutionBridge.ts

export type {
  MemoryEvolutionBridge,
  EvolutionMemoryContext,
  MemoryEvolutionResult,
  EvolutionPriority,
  MemoryChangeEvent,
  MemoryEvolutionCorrelation,
} from '@akemi-mio/intelligence-memory/MemoryEvolutionBridge'
export { memoryEvolutionBridge } from '@akemi-mio/intelligence-memory/MemoryEvolutionBridge'

// ═══════════════════════════════════════════
//  Evolution Consumer Bridge — 消费者驱动契约
// ═══════════════════════════════════════════
//
// 从消费者视角定义 Evolution 的输出格式、响应速度和容错要求。
// 消费者通过 EvolutionConsumerBridge 获取裁剪后的上下文，
// 不直接访问 Evolution 内部实现。
//
// 当前已注册消费者：
//   - plan_reasoning_chain: create_reasoning_chain tool
//   - plan_asr: AsrReasoningChainExecutor
//
// 使用方式：
//   import { evolutionConsumerBridge } from './evolution/consumer'
//   const ctx = evolutionConsumerBridge.getContext('plan_reasoning_chain')
//   if (ctx?.knownIssues) { ... }

export { evolutionConsumerBridge, EvolutionConsumerBridge } from '@akemi-mio/evolution-consumer'
export { PLAN_CONSUMER_REQUIREMENTS, ASR_PLAN_CONSUMER_REQUIREMENTS, BLOG_PLAN_CONSUMER_REQUIREMENTS } from '@akemi-mio/evolution-consumer'
export type {
  EvolutionConsumerContext,
  ConsumerId,
  ConsumerRequirements,
  ConsumerOutputFormat,
  ConsumerFaultTolerance,
  IEvolutionConsumerBridge,
  KnownIssue,
  PipelineSummary,
  SchedulerStatus,
} from '@akemi-mio/evolution-consumer'

// ═══════════════════════════════════════════
//  CI/CD Orchestrator — Evolution × MCP 工具桥接
// ═══════════════════════════════════════════
//
// CicdOrchestrator 将 Evolution 计划执行与 MCP CI/CD 工具集桥接。
// PlanStepMapper 自动将计划步骤描述映射到对应 CI/CD 工具调用。
// CicdCollector 作为 Pipeline 采集器定期执行 CI/CD 检查。
//
// 使用方式：
//   1. CicdOrchestrator 注入 EvolutionExecutor 作为可选的执行后端
//   2. 计划步骤含 "typecheck"、"lint"、"test" 等关键词时自动映射
//   3. 结果反馈给 Evolution 系统决定回滚或继续

export { CicdOrchestrator, CicdCollector, PlanStepMapper, planStepMapper } from '@akemi-mio/evolution-cicd'
export type { CicdAction, CicdStepResult, CicdCycleReport, CicdOrchestratorConfig, StepMapping } from '@akemi-mio/evolution-cicd/types'

export const planManager = new DrizzlePlanManager()
export let evolutionService: SelfEvolutionService | null = null

export function initEvolution(agentService: AgentService): SelfEvolutionService {
  if (!evolutionService) {
    evolutionService = new SelfEvolutionService(agentService, undefined, undefined, planManager)
  }
  return evolutionService
}

export function getPlanContext(): string {
  return planManager.getFormattedContext()
}
