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

// ── 行为偏好键值存储 ──
export { BehaviorPreferenceStore, behaviorPreferenceStore } from './BehaviorPreferenceStore'
export type {
  PreferenceStat,
  PreferenceValue,
  PreferenceSnapshot,
} from './BehaviorPreferenceStore'

// ── 用户纠正模式学习器 ──
export { CorrectionPatternLearner, correctionPatternLearner } from './CorrectionPatternLearner'
export type {
  ToolCallSnapshot,
  CorrectionEvent,
  LearnedPreference,
} from './CorrectionPatternLearner'

// ── 工具默认参数调整器 ──
export { ToolDefaultAdjuster, toolDefaultAdjuster } from './ToolDefaultAdjuster'
export type {
  ToolDefaultHint,
  WorkflowRecommendation,
  AdjustmentResult,
} from './ToolDefaultAdjuster'

// ── 行为驱动博客工作流桥接 ──
export { BehaviorBlogBridge, behaviorBlogBridge } from './BehaviorBlogBridge'
export type {
  BehaviorSummary,
  ActiveTimeDistribution,
  PublishRecommendation,
} from './BehaviorBlogBridge'

// ── 行为周期性预测（查询内容 × 时间周期预测模型）──
export { BehaviorPeriodicPredictor, behaviorPeriodicPredictor } from './BehaviorPeriodicPredictor'
export type {
  PeriodicQueryPrediction,
  TimeSlotPrediction,
  PeriodicPredictionModel,
  PeriodicPredictionEvent,
} from './BehaviorPeriodicPredictor'

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
export type {
  ActionCategory,
  ActionEntry,
  ActionEntryWithFrequency,
  TopActionsPayload,
} from './BehaviorActionCounter'

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
export {
  BehaviorPredictiveMemoryPrewarmer,
  behaviorPredictiveMemoryPrewarmer,
} from './BehaviorPredictiveMemoryPrewarmer'
export type {
  PrewarmedMemory,
  PrewarmResult,
  TopicScoreDetail,
  InteractionIntervalResult,
  PrewarmerDependencies,
} from './BehaviorPredictiveMemoryPrewarmer'

// ── 行为驱动的动态任务编排模式管理器 ──
export { TaskOrchestrationModeManager, taskOrchestrationModeManager } from './TaskOrchestrationModeManager'

// ── 行为预测记忆引擎（5 分钟周期 + 80% 阈值 + 时间戳标签匹配）──
export {
  BehaviorPredictionMemoryEngine,
  behaviorPredictionMemoryEngine,
} from './BehaviorPredictionMemoryEngine'
export type {
  BehaviorContext,
  MatchScoreDetail,
  PreloadBufferEntry,
  EngineStats,
  EngineDependencies,
} from './BehaviorPredictionMemoryEngine'
export type {
  TaskOrchestrationMode,
  BehaviorSignalType,
  BehaviorSignal,
  OrchestrationModeChangedEvent,
  OrchestrationConfig,
} from './TaskOrchestrationModeManager'

// ── ASR 关键词动作跟踪（语音习惯 → 壁纸动作预测）──
export { AsrKeywordActionTracker, asrKeywordActionTracker } from './AsrKeywordActionTracker'
export type {
  AsrActionCategory,
  AsrActionPrediction,
  TimeSlotActionPrediction,
  AsrKeywordTrackerStats,
} from './AsrKeywordActionTracker'
