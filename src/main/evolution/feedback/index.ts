/**
 * Evolution Feedback Loop — 模块出口
 *
 * 自进化行为反馈闭环的核心组件：
 * - EvolutionFeedbackCollector: 采集用户对进化计划的拒绝信号
 * - ModuleFeedbackManager: 管理模块级反馈状态和优先级
 */

export { EvolutionFeedbackCollector, evolutionFeedbackCollector } from './EvolutionFeedbackCollector'
export { ModuleFeedbackManager, moduleFeedbackManager } from './ModuleFeedbackManager'
export type {
  EvolutionModuleChange,
  EvolutionPlanRecord,
  RejectionSignalType,
  RejectionSignal,
  ModuleFeedbackState,
  FeedbackStore,
  EvolutionFeedbackSignalEvent,
  ModuleWeightAdjustedEvent,
} from './types'
