/**
 * writing — 写作策略自进化模块
 *
 * 提供改写参数空间、文本质量评估器以及自动化管道的 Collector / Executor，
 * 实现每 2 小时分析改写质量、自动优化改写参数的闭环。
 *
 * 导出：
 * - WritingParameterSpace（单例）— 改写参数空间管理
 * - WritingQualityEvaluator — 文本质量多维度评估
 * - WritingStrategyCollector — 管道采集器
 * - WritingStrategyExecutor — 管道执行器
 */

export { WritingParameterSpace, writingParameterSpace } from './WritingParameterSpace'
export type {
  ParameterDef,
  ParameterSnapshot,
  ParameterScoreEntry,
} from './WritingParameterSpace'

export { WritingQualityEvaluator } from './WritingQualityEvaluator'
export type {
  QualityDimensions,
  QualityEvalResult,
  EvaluatorConfig,
} from './WritingQualityEvaluator'

export { WritingStrategyCollector } from './WritingStrategyCollector'
export { WritingStrategyExecutor } from './WritingStrategyExecutor'
