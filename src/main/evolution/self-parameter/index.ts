/**
 * Parameter Self-Evolution — 记忆驱动的参数自进化系统
 *
 * 模块入口，导出所有组件。
 *
 * 使用方式：
 * 1. 初始化：feedbackMetadataStore.init(); parameterHotReloader.init()
 * 2. 注入：parameterSelfEvolutionAnalyzer.setLlmService(llmService)
 * 3. 注册到管道：PipelineOrchestrator.initDefaults() 中调用
 *    registerCollector(parameterSelfEvolutionAnalyzer)
 *    registerExecutor(new ParameterSelfEvolutionExecutor())
 */

export { ParameterRegistry, parameterRegistry } from './ParameterRegistry'
export { FeedbackMetadataStore, feedbackMetadataStore } from './FeedbackMetadataStore'
export { ParameterSelfEvolutionAnalyzer, parameterSelfEvolutionAnalyzer } from './ParameterSelfEvolutionAnalyzer'
export { ParameterSelfEvolutionExecutor } from './ParameterSelfEvolutionExecutor'
export { ParameterHotReloader, parameterHotReloader } from './ParameterHotReloader'

export type {
  TunableParameter,
  ParameterCategory,
  FeedbackDataPoint,
  FeedbackMetricCategory,
  FeedbackMetricAnalysis,
  ParameterAdjustmentProposal,
  ParameterSelfEvolutionReport,
  ParameterSnapshot,
  RollbackRecord,
  ParameterAdjustedEvent,
  ParameterRollbackEvent,
} from './types'
