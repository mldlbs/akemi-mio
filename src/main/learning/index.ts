/**
 * learning/index.ts — 学习系统模块导出
 *
 * 从 ASR 子系统提取的核心算法/策略的通用化版本。
 */

export { LearningVocabularyManager, learningVocabularyManager } from './LearningVocabularyManager'
export { LearningProgressTracker, learningProgressTracker } from './LearningProgressTracker'
export {
  buildFocusContext,
  buildPriorityItems,
  buildFocusSummary,
  isFocusMeaningful,
  formatFocusPrefix,
} from './LearningFocusBuilder'
export { PlanTypeScriptExecutor, planTypeScriptExecutor } from './PlanTypeScriptExecutor'

export { LearningAsrBridge, learningAsrBridge } from './LearningAsrBridge'
export type { LearningMatchResult } from './LearningAsrBridge'

export { OralCodeService, oralCodeService } from './OralCodeService'
export type { OralCodeInput, OralCodeResult, OralCodePattern, OralCodePatternDef } from './types'

// LearningTtsContract — Plan:TypeScript 对 TTS 的消费者合同
// 定义 TTS 输出格式、响应速度和容错要求的消费者视角规格
export * from './LearningTtsContract'

// LearningTtsAdapter — Plan:TypeScript → TTS 适配器
export { LearningTtsAdapter, learningTtsAdapter } from './LearningTtsAdapter'

export type {
  LearningItem,
  LearningCategory,
  ConceptDifficulty,
  MasteryLevel,
  LearningProgress,
  LearningDifficulty,
  DifficultyCategory,
  LearningEvalSnapshot,
  LearningFocusContext,
} from './types'

export {
  TYPESCRIPT_LEARNING_ITEMS,
  ALL_LEARNING_CATEGORIES,
} from './types'

export type {
  OralCodePattern,
  OralCodeInput,
  OralCodeResult,
  OralCodePatternDef,
} from './types'

export type {
  LearningStrategyChange,
  LearningStrategyType,
} from './LearningProgressTracker'

// ═══════════════════════════════════════════
//  类型挑战生成器 + 编译器服务导出
// ═══════════════════════════════════════════

export { TypeChallengeGenerator, typeChallengeGenerator } from './TypeChallengeGenerator'
export type { GeneratedChallenge, ChallengeResult } from './TypeChallengeGenerator'

export { TypeScriptCompilerService, typeScriptCompilerService } from './TypeScriptCompilerService'
export type { CompileResult, CompileDiagnostic, CompileOptions } from './TypeScriptCompilerService'

// ═══════════════════════════════════════════
//  混合流水线导出
// ═══════════════════════════════════════════

export { HybridPlanPipeline } from './HybridPlanPipeline'
export { HybridArbitrator } from './HybridArbitrator'

export type {
  HybridPathOutput,
  StepSuggestion,
  DifficultyAssessmentOutput,
  StrategySuggestion,
  ProgressEvaluationOutput,
  ConvergencePointName,
  ConvergenceResult,
  HybridPipelineConfig,
  HybridPipelineMetrics,
} from './HybridTypes'
