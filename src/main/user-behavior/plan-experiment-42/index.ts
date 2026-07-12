/**
 * Plan:实验42：并发Workflow隔离性测试 — 模块导出
 *
 * 渐进式引入计划：
 * - Phase 1 (当前): 旁路输出不做决策 (passive_monitor)
 * - Phase 2: 作为建议源影响部分决策 (suggestion_source)
 * - Phase 3: 替换 UserBehavior 核心模块 (core_replacement)
 */

export { PlanExperiment42Plugin } from './PlanExperiment42Plugin'
export type {
  ExperimentPhase,
  PlanExperiment42Config,
  ModeSwitchObservation,
  ConcurrencyObservation,
  EvolutionCycleObservation,
  ExperimentReport,
} from './types'
export {
  EXPERIMENT_PHASE_LABELS,
  DEFAULT_EXPERIMENT_CONFIG,
} from './types'
