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
  LearningStrategyChange,
  LearningStrategyType,
} from './LearningProgressTracker'
