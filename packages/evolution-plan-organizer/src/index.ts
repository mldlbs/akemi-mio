/**
 * Plan Optimizer — 自进化计划优化器
 *
 * 定期分析所有计划文件，检测重复或冲突任务，
 * 自动生成优化重组方案。
 *
 * 核心组件：
 * - PlanOptimizerEngine: LLM 驱动的跨计划重叠分析
 * - PlanOptimizerCollector: SignalCollector（接入自动化管道）
 * - PlanOptimizerExecutor: FixExecutor（执行优化操作）
 * - PlanOptimizerSnapshotManager: 快照与回滚管理
 *
 * 集成方式：
 *   在 PipelineOrchestrator 中：
 *     registerCollector(buildCollector({...planOptimizerCollector}))
 *     registerExecutor(buildExecutor({...planOptimizerExecutor}))
 */

export { PlanOptimizerEngine, planOptimizerEngine } from './PlanOptimizerEngine'
export type { PlanAnalysisFn } from './PlanOptimizerEngine'

export { PlanOptimizerCollector, planOptimizerCollector } from './PlanOptimizerCollector'

export { PlanOptimizerExecutor, planOptimizerExecutor } from './PlanOptimizerExecutor'

export { PlanOptimizerSnapshotManager, planOptimizerSnapshotManager } from './PlanOptimizerSnapshot'

export type {
  OptimizationSuggestion,
  OptimizationAnalysis,
  OptimizationCategory,
  PlanTaskDescriptor,
  PlanOptimizerConfig,
  PlanOptimizerRollback,
} from './PlanOptimizerTypes'

export { DEFAULT_PLAN_OPTIMIZER_CONFIG } from './PlanOptimizerTypes'
