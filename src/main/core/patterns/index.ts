/**
 * core/patterns — 通用可复用模式
 *
 * 这些是从各领域组件中提取的无偏见通用逻辑，
 * 不依赖具体业务知识，通过策略/插件注入领域差异。
 */

export {
  ok,
  err,
  isOk,
  isErr,
  map,
  mapErr,
  flatMap,
  tryCatch,
  tryCatchAsync,
  unwrapOr,
  unwrapOrElse,
  collectOk,
  all,
} from './Result'
export type { Result, Success, Failure } from './Result'

export { AsyncQueue } from './AsyncQueue'
export type { AsyncQueueOptions, QueueStatus } from './AsyncQueue'

export { FallbackChain } from './FallbackChain'
export type {
  Resolver,
  ResolveAttempt,
  ResolveResult,
  FallbackChainOptions,
} from './FallbackChain'

export { DebounceGate } from './DebounceGate'
export type { DebounceGateOptions, GateStatus } from './DebounceGate'

export { SlidingWindow } from './SlidingWindow'

export { ServiceRegistry } from './ServiceRegistry'
export type {
  ServiceManifest,
  ServicePlugin,
  ServiceRegistryOptions,
  CapabilityReader,
} from './ServiceRegistry'

export { computeBackoff, retryWithBackoff, retryWithBackoffOrThrow } from './RetryBackoff'
export type { RetryOptions } from './RetryBackoff'

export {
  ThresholdTracker,
  createThresholdTracker,
} from './ThresholdTracker'
export type { ThresholdAction, ThresholdTrackerOptions } from './ThresholdTracker'

// ════════════════════════════════════════════════════════════════
//  新增通用模式 v2
//  （从 MCP Tool / WorkspaceCleanupLayer / IndustrialOdeLayer 共性中提取）
// ════════════════════════════════════════════════════════════════

export { HookChain, MapHookChain, createDefaultMerge } from './HookChain'
export type {
  Hook,
  MapHook,
  HookChainOptions,
  MergeStrategy,
  MapHookChainOptions,
} from './HookChain'

export { FeatureFlagSet, parseFeaturesFromEnv } from './FeatureFlagSet'
export type { ParseFeaturesFromEnvOptions } from './FeatureFlagSet'

export { applyDefaults, createWithDefaults, buildWithDefaults } from './DefaultsBuilder'

// ════════════════════════════════════════════════════════════════
//  新增通用模式 v3
//  （从 Evolution FeedbackLoop + Plan 反馈回路共性中提取）
// ════════════════════════════════════════════════════════════════

export { clamp } from './clamp'

export { StateMachine } from './StateMachine'
export type { TransitionGuard, TransitionHook, StateMachineOptions } from './StateMachine'

export { BoundedBuffer, createBoundedBuffer } from './BoundedBuffer'

export { dampValue, isInBounds, isSignificantChange, DampedAdjuster, createDampedAdjuster } from './DampedAdjuster'
export type { ParameterBounds, DampedAdjusterOptions, DampedAdjusterState } from './DampedAdjuster'

export { mean, stdDev, isStable, isDiverging, evaluateConvergence, ConvergenceDetector, createConvergenceDetector } from './ConvergenceDetector'
export type { ConvergenceState, ConvergenceDetectorOptions, ConvergenceSnapshot } from './ConvergenceDetector'
