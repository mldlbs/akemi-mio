/**
 * pipeline/index.ts — Memory × PiperTTS 处理流水线公共导出
 *
 * 提供：
 * - PipelineEngine：流水线执行引擎（加载 JSON → 拓扑排序 → 缓存执行）
 * - CacheManager：中间结果缓存
 * - 所有内置 StageExecutor（含 ASR 交叉验证、MCP 工具执行等）
 * - 默认流水线定义导入（memory→piper + hybrid-tts-asr）
 * - 类型定义
 * - 工厂函数：createMemoryPiperPipeline() / createHybridTtsAsrPipeline() / createAsrPlanParallelPipeline()
 */

// @ts-ignore - JSON module not in tsconfig
import defaultPipelineDef from '@akemi-mio/intelligence/pipeline/definitions/memory-piper-pipeline.json'
// @ts-ignore - JSON module not in tsconfig
import hybridTtsAsrPipelineDef from '@akemi-mio/intelligence/pipeline/definitions/hybrid-tts-asr-pipeline.json'
// @ts-ignore - JSON module not in tsconfig
import asrPlanParallelPipelineDef from '@akemi-mio/intelligence/pipeline/definitions/asr-plan-parallel-pipeline.json'
import { PipelineEngine } from '@akemi-mio/intelligence/pipeline/PipelineEngine'
import { MemoryContextStage } from '@akemi-mio/intelligence/pipeline/stages/MemoryContextStage'
import { EmotionAnalysisStage } from '@akemi-mio/intelligence/pipeline/stages/EmotionAnalysisStage'
import { TextProcessingStage } from '@akemi-mio/intelligence/pipeline/stages/TextProcessingStage'
import { TtsParameterStage } from '@akemi-mio/intelligence/pipeline/stages/TtsParameterStage'
import { PiperSynthesisStage } from '@akemi-mio/intelligence/pipeline/stages/PiperSynthesisStage'
import { ASRCrossValidationStage } from '@akemi-mio/intelligence/pipeline/stages/ASRCrossValidationStage'
import { ASRProcessingStage } from '@akemi-mio/intelligence/pipeline/stages/ASRProcessingStage'
import { PlanParallelAdvancementStage } from '@akemi-mio/intelligence/pipeline/stages/PlanParallelAdvancementStage'

export { PipelineEngine } from '@akemi-mio/intelligence/pipeline/PipelineEngine'
export { CacheManager, cacheManager, computeInputHash } from '@akemi-mio/intelligence/pipeline/CacheManager'

// Stage 实现 (基础流水线)
export { MemoryContextStage } from '@akemi-mio/intelligence/pipeline/stages/MemoryContextStage'
export { EmotionAnalysisStage } from '@akemi-mio/intelligence/pipeline/stages/EmotionAnalysisStage'
export { TextProcessingStage } from '@akemi-mio/intelligence/pipeline/stages/TextProcessingStage'
export { TtsParameterStage } from '@akemi-mio/intelligence/pipeline/stages/TtsParameterStage'
export { PiperSynthesisStage } from '@akemi-mio/intelligence/pipeline/stages/PiperSynthesisStage'

// Stage 实现 (ASR / 交叉验证 / MCP)
export { ASRCrossValidationStage } from '@akemi-mio/intelligence/pipeline/stages/ASRCrossValidationStage'
export { ASRProcessingStage } from '@akemi-mio/intelligence/pipeline/stages/ASRProcessingStage'
export { MCPToolStage } from '@akemi-mio/intelligence/pipeline/stages/MCPToolStage'

// Stage 实现 (Plan:并行推进)
export { PlanParallelAdvancementStage } from '@akemi-mio/intelligence/pipeline/stages/PlanParallelAdvancementStage'
export type { PlanParallelOutput, RadarMergeOutput, SonggeBackupOutput, BlogAnalysisOutput } from '@akemi-mio/intelligence/pipeline/stages/PlanParallelAdvancementStage'

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
} from '@akemi-mio/intelligence/pipeline/types'
export { SCHEMA } from '@akemi-mio/intelligence/pipeline/types'

/** 默认流水线定义（memory→piper，可直接传给 engine.load()） */
export { defaultPipelineDef }

/** ASR-PiperTTS 混合流水线定义（可直接传给 engine.load()） */
export { hybridTtsAsrPipelineDef }

/** ASR × Plan:并行推进 流水线定义（可直接传给 engine.load()） */
export { asrPlanParallelPipelineDef }

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

/**
 * 创建预配置好的 ASR-PiperTTS 混合流水线引擎。
 *
 * 在 Memory → PiperTTS 基础上增加 ASR 交叉验证环节：
 * - PiperTTS 合成的音频通过 ASR 转写回文本
 * - 与原文进行相似度比较
 * - 不一致时触发仲裁机制（pass / warning / retry）
 *
 * 流水线路径：
 *   Text → PiperTTS (路径 A) ─────────┐
 *                                     ├→ ASR 交叉验证 → 仲裁
 *   Text → 文本处理 (路径 B) ──────────┘
 *
 * @returns 已注册并加载了混合流水线定义的 PipelineEngine
 */
export function createHybridTtsAsrPipeline(): PipelineEngine {
  const engine = new PipelineEngine()

  // 注册所有内置阶段（包括 ASR 交叉验证）
  engine.registerAll([
    new MemoryContextStage(),
    new EmotionAnalysisStage(),
    new TextProcessingStage(),
    new TtsParameterStage(),
    new PiperSynthesisStage(),
    new ASRCrossValidationStage(),
  ])

  // 加载混合流水线定义
  engine.load(hybridTtsAsrPipelineDef as any)

  return engine
}

/**
 * 创建预配置好的 ASR × Plan:并行推进 流水线引擎。
 *
 * 流水线路径：
 *   Audio/Text → ASR Processing → Plan:并行推进
 *                                  ├─ 雷达合并（创业信号扫描）
 *                                  ├─ 工业颂歌备份（内容风格分析）
 *                                  └─ 博客分析（效果分析与策略调整）
 *
 * 三个子任务并发执行，互不阻塞。
 * 每个子任务均可独立开关（通过 stage config 的 enable* 字段）。
 *
 * @returns 已注册并加载了 ASR-Plan 并行推进流水线定义的 PipelineEngine
 */
export function createAsrPlanParallelPipeline(): PipelineEngine {
  const engine = new PipelineEngine()

  // 注册所有内置阶段（ASR 处理 + Plan 并行推进）
  engine.registerAll([new ASRProcessingStage(), new PlanParallelAdvancementStage()])

  // 加载 ASR → Plan:并行推进 流水线定义
  engine.load(asrPlanParallelPipelineDef as any)

  return engine
}
