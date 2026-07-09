export { PipelineOrchestrator } from './PipelineOrchestrator'
export type { PipelineConfig, PipelineMetrics } from './PipelineOrchestrator'
export { ProblemQueue } from './ProblemQueue'
export { TscCollector } from './TscCollector'
export { TestCollector } from './TestCollector'
export { EslintCollector } from './EslintCollector'
export { ClaudeCodeExecutor } from './ClaudeCodeExecutor'
export { CreativityCollector } from './CreativityCollector'
export { CreativityExecutor } from './CreativityExecutor'
export { MemoryAnalysisCollector } from './MemoryAnalysisCollector'
export { AsrLogCollector } from './AsrLogCollector'
export { AsrOptimizationExecutor } from './AsrOptimizationExecutor'
export { WallpaperCollector } from './WallpaperCollector'
export { WallpaperOptimizationExecutor } from './WallpaperOptimizationExecutor'
export { PlanLogCollector } from './PlanLogCollector'
export { AutoPatchExecutor } from './AutoPatchExecutor'
export { BehaviorCollector } from './BehaviorCollector'
export { BehaviorOptimizationExecutor } from './BehaviorOptimizationExecutor'
export { ToolEvolutionCollector } from './ToolEvolutionCollector'
export { ToolEvolutionExecutor } from './ToolEvolutionExecutor'
export { TtsPreferenceCollector } from './TtsPreferenceCollector'
export { TtsConfigOptimizationExecutor } from './TtsConfigOptimizationExecutor'

// ═══════════════════════════════════════════
//  MCP 模式迁移导出
// ═══════════════════════════════════════════

export { ProblemErrorType, classifyProblemError, shouldRetryOnError, shouldCacheErrorType } from './ProblemErrorType'
export { ProblemFixCache, problemFixCache } from './ProblemFixCache'
export {
  buildCollector,
  buildExecutor,
  collectorRegistry,
  executorRegistry,
  registerCollector,
  registerExecutor,
  getAllCollectors,
  getAllExecutors,
  getExecutorsBySource,
  getCollectorsBySource,
} from './registry'

export type { CollectorDef, ExecutorDef } from './registry'
export type { Problem, AssignedProblem, FixResult, SignalCollector, FixExecutor, ProblemSource, Severity, PipelineStats } from './types'
