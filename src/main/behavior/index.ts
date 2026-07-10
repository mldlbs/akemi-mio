export { UserBehaviorService } from './UserBehaviorService'
export type { UserBehaviorState, ActivityState, AppCategory, ActivityContext, EnrichedBehaviorState } from './UserBehaviorService'

// ── App Window Polling（前台窗口轮询子模块）──
export { AppWindowPolling, detectAppCategory } from './app-window-polling'
export type { AppWindowPollingOptions, WindowUpdateCallback } from './app-window-polling'

export { BehaviorStateMachine, behaviorStateMachine } from './BehaviorStateMachine'
export type { BehaviorMode, BehaviorModeSnapshot, AdaptiveThresholds, InteractionRecord, BehaviorStats } from './BehaviorStateMachine'

export { DualModeController, dualModeController } from './DualModeController'
export type {
  ModeType,
  SwitchDecision,
  SwitchReason,
  ModeStateSnapshot,
  ModeWorkingConditions,
  InputCharacteristics,
  LoadRange,
  ResponseTimeRequirement,
  DualModeSwitchEvent,
} from './DualModeTypes'
export { MODE_SPECIFICATIONS, MODE_LABELS } from './DualModeTypes'

// ── UserBehavior → TTS 消费者合同 ──
export {
  buildTtsNeed,
  isNeedDifferent,
  DEFAULT_TTS_NEED,
} from './UserBehaviorTtsContract'
export type {
  BehaviorTtsOutputMode,
  BehaviorTtsPriority,
  BehaviorTtsFaultTolerance,
  UserBehaviorTtsNeed,
} from './UserBehaviorTtsContract'
