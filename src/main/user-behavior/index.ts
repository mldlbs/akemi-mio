/**
 * UserBehavior Layer — Evolution 上层增强层
 *
 * 提供非侵入式的预处理/后处理能力，通过 feature flag 控制。
 *
 * 使用示例：
 * ```ts
 * import { UserBehaviorLayer, parseFeaturesFromEnv } from './user-behavior'
 * import { evolutionService } from '../evolution'
 *
 * const behavior = new UserBehaviorLayer(evolutionService, {
 *   features: parseFeaturesFromEnv(),
 * })
 * ```
 *
 * 环境变量控制：
 *   USER_BEHAVIOR_FEATURES=summary_enhance,metrics_enrich
 *
 * @module user-behavior
 */

export { UserBehaviorLayer } from './UserBehaviorLayer'
export { parseFeaturesFromEnv } from './types'
export { BehaviorFeatureExtractor, behaviorFeatureExtractor, registerBehaviorRecordHook } from './BehaviorFeatureExtractor'
export { BehaviorHeatmapService, behaviorHeatmapService } from './BehaviorHeatmapService'

// ── MCP ↔ UserBehavior 强化回路 ──
export { MCPFeedbackLoopService, createMCPFeedbackLoop } from './feedback-loop'
export type { MCPFeedbackLoopConfig } from './feedback-loop'

export type {
  UserBehaviorFeature,
  UserBehaviorConfig,
  PreProcessContext,
  PostProcessContext,
  PostProcessResult,
  PreProcessHook,
  PostProcessHook,
  ModuleHeatmap,
  ModuleHeatmapEntry,
  ModuleTrend,
  ModulePriority,
} from './types'
export type {
  BehavioralFeatures,
  ToolSequence,
  PausePoint,
  FrequentToolStat,
  OptimizationSuggestion,
  OptimizationType,
} from './BehaviorFeatureExtractor'

// ── 反馈回路类型 ──
export type {
  ToolExecutionQuality,
  ToolQualitySnapshot,
  BehaviorParameterSet,
  ParameterAdjustment,
  ParameterAdjustmentType,
  DampingState,
  ConvergenceMetrics,
  ConvergenceState,
  FeedbackLoopMode,
  FeedbackLoopState,
  FeedbackLoopStateChangePayload,
  ParameterAdjustmentPayload,
} from './feedback-loop/types'
