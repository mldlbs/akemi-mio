/**
 * pipeline/index.ts — Memory × PiperTTS 处理流水线公共导出
 *
 * 提供：
 * - PipelineEngine：流水线执行引擎（加载 JSON → 拓扑排序 → 缓存执行）
 * - CacheManager：中间结果缓存
 * - 所有内置 StageExecutor
 * - 默认流水线定义导入
 * - 类型定义
 */

// @ts-ignore - JSON module not in tsconfig
import defaultPipelineDef from './definitions/memory-piper-pipeline.json'

export { PipelineEngine } from './PipelineEngine'
export { CacheManager, cacheManager, computeInputHash } from './CacheManager'

// Stage 实现
export { MemoryContextStage } from './stages/MemoryContextStage'
export { EmotionAnalysisStage } from './stages/EmotionAnalysisStage'
export { TextProcessingStage } from './stages/TextProcessingStage'
export { TtsParameterStage } from './stages/TtsParameterStage'
export { PiperSynthesisStage } from './stages/PiperSynthesisStage'

// 类型
export type {
  PipelineDefinition,
  StageDefinition,
  StageExecutor,
  StageOutput,
  StageExecutionContext,
  PipelineResult,
  SchemaFragment,
  CacheEntry,
  CacheStats,
  ICacheManager,
} from './types'
export { SCHEMA } from './types'

/** 默认流水线定义（可直接传给 engine.load()） */
export { defaultPipelineDef }

/**
 * 创建预配置好的 Memory → PiperTTS 流水线引擎。
 *
 * 注册所有内置 StageExecutor，加载默认 pipeline JSON 定义。
 * 外部只需注入 MemoryService 引用即可使用。
 *
 * @returns 已注册并加载了默认定义的 PipelineEngine
 */
export function createMemoryPiperPipeline(): PipelineEngine {
  const engine = new PipelineEngine()

  // 注册所有内置阶段
  engine.registerAll([
    new MemoryContextStage(),
    new EmotionAnalysisStage(),
    new TextProcessingStage(),
    new TtsParameterStage(),
    new PiperSynthesisStage(),
  ])

  // 加载默认流水线定义
  engine.load(defaultPipelineDef as any)

  return engine
}
