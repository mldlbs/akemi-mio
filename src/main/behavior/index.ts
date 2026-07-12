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

// ── TTS/Plan:清理工作区 双模切换 ──
export { TtsCleanupDualModeController, ttsCleanupDualModeController } from './TtsCleanupDualModeController'
export type {
  TtsCleanupBehaviorInput,
  TtsCleanupWorkspaceInput,
  TtsCleanupTtsInput,
} from './TtsCleanupDualModeController'
export {
  TTS_CLEANUP_MODE_SPECIFICATIONS,
  TTS_CLEANUP_MODE_LABELS,
} from './TtsCleanupDualModeTypes'
export type {
  TtsCleanupModeType,
  TtsCleanupSwitchDecision,
  TtsCleanupSwitchReason,
  TtsCleanupModeStateSnapshot,
  TtsCleanupDualModeSwitchEvent,
  TtsCleanupModeWorkingConditions,
  CleanupInputCharacteristics,
  CleanupLoadRange,
  CleanupResponseTimeRequirement,
} from './TtsCleanupDualModeTypes'

// ── 行为序列学习器（语音触发的行为模式自动化） ──
export { BehaviorSequenceLearner, behaviorSequenceLearner } from './BehaviorSequenceLearner'
export type { LearnedPattern, LearnerConfig, LearnerStats } from './BehaviorSequenceLearner'

// ── 行为驱动的主动记忆填充（TF-IDF + 意图聚类 + 时间序列分析）──
export { BehaviorDrivenMemoryAnalyzer, behaviorDrivenMemoryAnalyzer } from './BehaviorDrivenMemoryAnalyzer'
export type {
  TfIdfResult,
  IntentCluster,
  TimePattern,
  AnalysisResult,
} from './BehaviorDrivenMemoryAnalyzer'
