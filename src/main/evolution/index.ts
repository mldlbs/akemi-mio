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
export { EvolutionStateManager } from './EvolutionStateManager'
export { EvolutionGitOps } from './EvolutionGitOps'
export { RollbackLevel } from './EvolutionGitOps'
export { ProposalValidator } from './ProposalValidator'
export type { Proposal, ProposalValidation } from './ProposalValidator'
export { ANALYSIS_PROMPT, PLAN_EXECUTE_PROMPT, detectPlanMode, pickBestPlan, buildPlanInjection } from './EvolutionPromptBuilder'
export type { AnalysisMode } from './EvolutionPromptBuilder'
export { SelfEvolutionService, EvolutionSchedulerState as ServiceSchedulerState } from './SelfEvolutionService'
export { PipelineOrchestrator } from './automation'
export type { PipelineConfig, PipelineMetrics, Problem, SignalCollector, FixExecutor, FixResult } from './automation'
export type { EvolutionSafetyMode } from './types'
export type { PlanManagerLike } from './types'

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

export type { MemoryEvolutionBridge, EvolutionMemoryContext, MemoryEvolutionResult } from '../memory/MemoryEvolutionBridge'
export { memoryEvolutionBridge } from '../memory/MemoryEvolutionBridge'

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
