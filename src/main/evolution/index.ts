import { DrizzlePlanManager } from './DrizzlePlanManager'
import { SelfEvolutionService } from './SelfEvolutionService'
import { DevPlan } from './types'
import { AgentService } from '../agent/AgentService'
import { EvolutionHistoryManager } from './EvolutionHistory'
import { EvolutionStateManager } from './EvolutionStateManager'
import { EvolutionGitOps, RollbackLevel } from './EvolutionGitOps'
import { ProposalValidator } from './ProposalValidator'
import { ANALYSIS_PROMPT, PLAN_EXECUTE_PROMPT, detectPlanMode, pickBestPlan, buildPlanInjection } from './EvolutionPromptBuilder'
import type { AnalysisMode } from './EvolutionPromptBuilder'
import type { PlanManagerLike } from './types'
import type { EvolutionSafetyMode } from './types'
import type { Proposal, ProposalValidation } from './ProposalValidator'

export { EvolutionHistoryManager } from './EvolutionHistory'
export type { EvolutionHistoryEntry, EvolutionHistory } from './EvolutionHistory'
export { StateBroadcaster } from './StateBroadcaster'
export type { DashboardLiveSnapshot, DashboardLivePayload } from './StateBroadcaster'
export { EvolutionStateManager } from './EvolutionStateManager'
export { EvolutionGitOps } from './EvolutionGitOps'
export { RollbackLevel } from './EvolutionGitOps'
export { EvolutionCheckpointManager, evolutionCheckpointManager } from './EvolutionCheckpointManager'
export type { CheckpointContext, UnfinishedCheckpoint } from './EvolutionCheckpointManager'
export { ProposalValidator } from './ProposalValidator'
export type { Proposal, ProposalValidation } from './ProposalValidator'
export { ANALYSIS_PROMPT, PLAN_EXECUTE_PROMPT, detectPlanMode, pickBestPlan, buildPlanInjection } from './EvolutionPromptBuilder'
export type { AnalysisMode } from './EvolutionPromptBuilder'
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
} from './file-organizer'

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
} from './file-organizer'

export { DEFAULT_EVOLUTION_CONFIG, createDefaultRules } from './file-organizer'

// Pipeline 阶段导出
export { EvolutionAnalyzer, EvolutionStrategizer, EvolutionExecutor, EvolutionReviewer, setSandboxRoot } from './pipeline'
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
} from './pipeline/types'

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

export {
  PluginServiceLoader,
  PluginCollectorAdapter,
  PluginExecutorAdapter,
  WallpaperPlugin,
} from './plugin'

export type {
  EvolutionPlugin,
  EvolutionPluginManifest,
  EvolutionCapability,
  PluginProblem,
  PluginFixResult,
} from './plugin'

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

export { UserBehaviorLayer } from '../user-behavior/UserBehaviorLayer'
export { parseFeaturesFromEnv } from '../user-behavior/types'
export type {
  UserBehaviorFeature,
  UserBehaviorConfig,
  PreProcessContext,
  PostProcessContext,
  PostProcessResult,
  PreProcessHook,
  PostProcessHook,
} from '../user-behavior/types'

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

export {
  EvolutionPiperBridge,
  evolutionPiperBridge,
  PiperEvolutionPlugin,
} from './piper'

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
} from './piper'

export { DEFAULT_EVOLUTION_PIPER_BRIDGE_CONFIG } from './piper'

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

export type { MemoryEvolutionBridge, EvolutionMemoryContext, MemoryEvolutionResult, EvolutionPriority, MemoryChangeEvent, MemoryEvolutionCorrelation } from '../memory/MemoryEvolutionBridge'
export { memoryEvolutionBridge } from '../memory/MemoryEvolutionBridge'

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

export { evolutionConsumerBridge, EvolutionConsumerBridge } from './consumer'
export { PLAN_CONSUMER_REQUIREMENTS, ASR_PLAN_CONSUMER_REQUIREMENTS, BLOG_PLAN_CONSUMER_REQUIREMENTS } from './consumer'
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
} from './consumer'

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

export { CicdOrchestrator, CicdCollector, PlanStepMapper, planStepMapper } from './cicd'
export type { CicdAction, CicdStepResult, CicdCycleReport, CicdOrchestratorConfig, StepMapping } from './cicd/types'

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
