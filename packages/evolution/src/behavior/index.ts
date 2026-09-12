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
export { buildTtsNeed, isNeedDifferent, DEFAULT_TTS_NEED } from './UserBehaviorTtsContract'
export type { BehaviorTtsOutputMode, BehaviorTtsPriority, BehaviorTtsFaultTolerance, UserBehaviorTtsNeed } from './UserBehaviorTtsContract'

// ── TTS/Plan:清理工作区 双模切换 ──
export { TtsCleanupDualModeController, ttsCleanupDualModeController } from '@akemi-mio/evolution-tts-cleanup-dualmode'
export type { TtsCleanupBehaviorInput, TtsCleanupWorkspaceInput, TtsCleanupTtsInput } from '@akemi-mio/evolution-tts-cleanup-dualmode'
export { TTS_CLEANUP_MODE_SPECIFICATIONS, TTS_CLEANUP_MODE_LABELS } from '@akemi-mio/evolution-tts-cleanup-dualmode'
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
} from '@akemi-mio/evolution-tts-cleanup-dualmode'

// ── 行为序列学习器（语音触发的行为模式自动化） ──
export { BehaviorSequenceLearner, behaviorSequenceLearner } from './BehaviorSequenceLearner'
export type { LearnedPattern, LearnerConfig, LearnerStats } from './BehaviorSequenceLearner'

// ── 行为规则引擎 ──
export { BehaviorRuleEngine, behaviorRuleEngine } from './BehaviorRuleEngine'

// ── 行为驱动的主动记忆填充（TF-IDF + 意图聚类 + 时间序列分析）──
export { BehaviorDrivenMemoryAnalyzer, behaviorDrivenMemoryAnalyzer } from '@akemi-mio/evolution-behavior-prediction'
export type { TfIdfResult, IntentCluster, TimePattern, AnalysisResult } from '@akemi-mio/evolution-behavior-prediction'

// ── 行为偏好键值存储 ──
export { BehaviorPreferenceStore, behaviorPreferenceStore } from './BehaviorPreferenceStore'
export type { PreferenceStat, PreferenceValue, PreferenceSnapshot } from './BehaviorPreferenceStore'

// ── 用户纠正模式学习器 ──
export { CorrectionPatternLearner, correctionPatternLearner } from './CorrectionPatternLearner'
export type { ToolCallSnapshot, CorrectionEvent, LearnedPreference } from './CorrectionPatternLearner'

// ── 工具默认参数调整器 ──
export { ToolDefaultAdjuster, toolDefaultAdjuster } from './ToolDefaultAdjuster'
export type { ToolDefaultHint, WorkflowRecommendation, AdjustmentResult } from './ToolDefaultAdjuster'

// ── 行为驱动博客工作流桥接 ──
export { BehaviorBlogBridge, behaviorBlogBridge } from './BehaviorBlogBridge'
export type { BehaviorSummary, ActiveTimeDistribution, PublishRecommendation } from './BehaviorBlogBridge'

// ── 行为周期性预测（查询内容 × 时间周期预测模型）──
export { BehaviorPeriodicPredictor, behaviorPeriodicPredictor } from '@akemi-mio/evolution-behavior-prediction'
export type {
  PeriodicQueryPrediction,
  TimeSlotPrediction,
  PeriodicPredictionModel,
  PeriodicPredictionEvent,
} from '@akemi-mio/evolution-behavior-prediction'

// ── 行为周期性预加载服务（空闲时段预加载 + 哑提醒推送）──
export { BehaviorPeriodicPreloadService, behaviorPeriodicPreloadService } from './BehaviorPeriodicPreloadService'

// ── 使用模式分析（行为驱动的自进化参数调整）──
export { BehaviorUsagePatternAnalyzer, behaviorUsagePatternAnalyzer } from './BehaviorUsagePatternAnalyzer'
export type {
  UsagePatternReport,
  TimePatternAnalysis,
  QuestionTypeAnalysis,
  SentimentAnalysis,
  RepeatedPatternAnalysis,
  QuestionType,
  SentimentLabel,
  AnalyzeOptions,
} from './BehaviorUsagePatternAnalyzer'

// ── 行为动作频率计数器（桌面快捷入口）──
export { BehaviorActionCounter, behaviorActionCounter } from './BehaviorActionCounter'
export type { ActionCategory, ActionEntry, ActionEntryWithFrequency, TopActionsPayload } from './BehaviorActionCounter'

// ── 行为调整日志（记录每次调整及其效果）──
export { BehaviorAdjustmentJournal, behaviorAdjustmentJournal } from './BehaviorAdjustmentJournal'
export type {
  AdjustmentRecord,
  AdjustmentType,
  AdjustmentContext,
  AdjustmentEffect,
  AdjustmentJournalData,
} from './BehaviorAdjustmentJournal'

// ── 行为预测式记忆预热（交互间隔分析 + 话题转移预测 + Top-3 记忆预取）──
export { BehaviorPredictiveMemoryPrewarmer, behaviorPredictiveMemoryPrewarmer } from '@akemi-mio/evolution-behavior-prediction'
export type {
  PrewarmedMemory,
  PrewarmResult,
  TopicScoreDetail,
  InteractionIntervalResult,
  PrewarmerDependencies,
} from '@akemi-mio/evolution-behavior-prediction'

// ── 行为驱动的动态任务编排模式管理器 ──
export { TaskOrchestrationModeManager, taskOrchestrationModeManager } from './TaskOrchestrationModeManager'
export type {
  TaskOrchestrationMode,
  BehaviorSignalType,
  BehaviorSignal,
  OrchestrationModeChangedEvent,
  OrchestrationConfig,
} from './TaskOrchestrationModeManager'

// ── 行为模式预编排系统（PrefixSpan + 预编排引擎）──
export { PatternMiner, patternMiner } from '@akemi-mio/evolution-behavior-patterns'
export type { MiningConfig, MiningResult } from './types'

export { ToolPatternStore, toolPatternStore } from '@akemi-mio/evolution-behavior-patterns'

export { PreOrchestrationEngine, preOrchestrationEngine } from '@akemi-mio/evolution-behavior-patterns'
export type { ToolCallContext, ConfirmationCallback, OrchestratorConfig } from '@akemi-mio/evolution-behavior-patterns'

export type {
  BehaviorPattern,
  PatternStep,
  PatternMatchResult,
  PreOrchestrationPlan,
  ResolvedStep,
  ExecutionEntry,
  ToolCallLogEntry,
} from './types'
