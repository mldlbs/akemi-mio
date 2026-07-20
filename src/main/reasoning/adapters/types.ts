/**
 * reasoning/adapters/types — ASR 算法复用到 Plan:推理链 的接口定义
 *
 * ── 设计来源 ──
 * 从 ASR（Automatic Speech Recognition）系统提取的核心算法模式，
 * 泛化为不依赖语音领域的通用接口类型，供 Plan:推理链 及其他场景复用。
 *
 * 提取自以下 ASR 模块：
 * - AsrService.transcribe()      → FallbackChainStrategy  — GPU→CPU→Baidu 顺序降级
 * - FusionEngine                 → MultiPathFusion        — 多路解码器加权融合
 * - AsrConfidenceScorer          → ConfidenceScoring      — 文本+特征双通道打分
 * - AsrContextBuilder            → ContextBoost           — 热词/提示词动态增强
 * - AsrCrossValidationStage      → CrossValidation        — 编辑距离 + n-gram 重叠校验
 *
 * 适配目标领域：Plan:推理链 (Reasoning Planner) 的博客写作工作流
 *   ASR 算法模式             → 博客写作领域适配
 *   ──────────               ─────────────────
 *   GPU→CPU→Baidu 降级       LLM→Rule→Heuristic 评估降级
 *   多路解码器融合            多维度评分融合（技术深度+代码质量+可读性+…）
 *   文本+音频特征置信度       内容+元数据复合置信度
 *   对话上下文热词增强        话题/平台/受众动态权重增强
 *   编辑距离交叉验证          内容—大纲一致性校验
 */

import type { BlogDimensionScores, BlogAssessmentInput } from '../../agent/blog/PlanBlogWritingAdapter'

// ════════════════════════════════════════════════════════════════
//  0. ReasoningContext — 推理规划器输入（未在 reasoning/types.ts 中导出）
// ════════════════════════════════════════════════════════════════

/** 推理规划器输入上下文（与 ReasoningPlanner 使用的签名一致） */
export interface ReasoningContext {
  input: {
    /** 用户输入的文本 */
    text: string
    /** 输入内容分类（如 'blog', 'code', 'question'） */
    category?: string
    /** 场景标识（如 'deep_discussion', 'analysis', 'decision'） */
    scene?: string
    /** 附加元数据（博客写作场景下传递 topic/platform/audience 等） */
    metadata?: Record<string, unknown>
  }
}

// ════════════════════════════════════════════════════════════════
//  1. Fallback Chain — 顺序降级策略（源：AsrService GPU→CPU→Baidu）
// ════════════════════════════════════════════════════════════════

/** 降级链中的单步执行器 */
export interface FallbackStep<TIn, TOut> {
  /** 执行器名称（日志标识） */
  readonly name: string
  /** 是否可用于当前输入 */
  canHandle(input: TIn): boolean
  /** 执行处理 */
  execute(input: TIn): Promise<TOut>
  /** 超时时间（ms） */
  timeoutMs: number
}

/** 降级链执行结果 */
export interface FallbackResult<TOut> {
  /** 是否成功 */
  success: boolean
  /** 输出值（success=false 时为 null） */
  value: TOut | null
  /** 最终使用的执行器名称 */
  stepName: string
  /** 总耗时 */
  totalLatencyMs: number
  /** 各步骤执行记录 */
  steps: Array<{
    name: string
    success: boolean
    latencyMs: number
    error?: string
  }>
}

/** 降级链策略接口 */
export interface FallbackChainStrategy<TIn, TOut> {
  /** 策略名称 */
  readonly name: string
  /** 注册执行步骤（顺序=降级顺序，优先注册的优先执行） */
  addStep(step: FallbackStep<TIn, TOut>): void
  /** 执行降级链 */
  execute(input: TIn): Promise<FallbackResult<TOut>>
}

// ════════════════════════════════════════════════════════════════
//  2. Multi-Path Fusion — 多路径加权融合（源：FusionEngine）
// ════════════════════════════════════════════════════════════════

/** 单路径执行结果 */
export interface PathResult<T> {
  /** 路径名称 */
  name: string
  /** 路径输出值 */
  value: T
  /** 置信度 (0–1) */
  confidence: number
  /** 基础权重 */
  weight: number
  /** 延迟（ms） */
  latencyMs: number
}

/** 融合策略枚举 */
export type FusionStrategy = 'weighted_vote' | 'best_confidence' | 'single'

/** 融合结果 */
export interface FusionResult<T> {
  /** 融合后的值 */
  value: T
  /** 综合置信度 (0–1) */
  confidence: number
  /** 使用的融合方法 */
  method: FusionStrategy
  /** 活跃路径数 */
  activePathCount: number
  /** 各路径的原始结果 */
  pathResults: PathResult<T>[]
  /** 是否降级运行（部分路径失败） */
  degraded: boolean
  /** 总耗时 */
  totalLatencyMs: number
}

/** 多路径融合配置 */
export interface MultiPathFusionConfig {
  /** 融合策略 */
  strategy: FusionStrategy
  /** 路径权重表 */
  weights: Record<string, number>
  /** 置信度阈值 — 低于此值的路径被排除 */
  confidenceThreshold: number
  /** 是否启用历史准确率动态调整 */
  enableDynamicWeights: boolean
}

/** 默认融合配置 */
export const DEFAULT_FUSION_CONFIG: MultiPathFusionConfig = {
  strategy: 'weighted_vote',
  weights: {},
  confidenceThreshold: 0.3,
  enableDynamicWeights: false,
}

/** 多路径融合策略接口 */
export interface MultiPathFusionStrategy<T> {
  /** 策略名称 */
  readonly name: string
  /** 注册一个计算路径 */
  registerPath(name: string, weight: number): void
  /** 执行多路径融合 */
  fuse(paths: Array<() => Promise<PathResult<T>>>): Promise<FusionResult<T>>
  /** 更新配置 */
  updateConfig(config: Partial<MultiPathFusionConfig>): void
}

// ════════════════════════════════════════════════════════════════
//  3. Context Boost — 上下文感知权重增强（源：AsrContextBuilder）
// ════════════════════════════════════════════════════════════════

/** 上下文增强因子 */
export interface BoostFactor {
  /** 因子名称 */
  name: string
  /** 基础增量值 */
  baseBoost: number
  /** 是否命中上下文 */
  matches(context: Record<string, unknown>): boolean
  /** 动态调整系数（基于匹配强度） */
  dynamicMultiplier(context: Record<string, unknown>): number
}

/** 上下文增强结果 */
export interface BoostResult {
  /** 应用的增强因子列表 */
  appliedBoosts: Array<{
    name: string
    value: number
    reason: string
  }>
  /** 总增强值 */
  totalBoost: number
  /** 增强后分值 */
  boostedScore: number
}

/** 上下文增强策略接口 */
export interface ContextBoostStrategy {
  /** 策略名称 */
  readonly name: string
  /** 注册增强因子 */
  addFactor(factor: BoostFactor): void
  /** 计算上下文增强 */
  boost(score: number, context: Record<string, unknown>): BoostResult
  /** 清除所有因子 */
  clearFactors(): void
}

// ════════════════════════════════════════════════════════════════
//  4. Confidence Scoring — 复合置信度评分（源：AsrConfidenceScorer）
// ════════════════════════════════════════════════════════════════

/** 评分通道 */
export interface ScoringChannel {
  /** 通道名称 */
  name: string
  /** 通道权重（所有通道权重和=1） */
  weight: number
  /** 执行评分，返回 0–1 */
  score(input: Record<string, unknown>): number
}

/** 复合评分结果 */
export interface CompositeScoreResult {
  /** 综合评分 (0–1) */
  score: number
  /** 各通道评分明细 */
  channels: Array<{
    name: string
    score: number
    weight: number
    weightedScore: number
  }>
  /** 评分置信度 (0–1)，反映评分依据的充分性 */
  confidence: number
}

/** 复合评分策略接口 */
export interface CompositeScoringStrategy {
  /** 策略名称 */
  readonly name: string
  /** 注册评分通道 */
  addChannel(channel: ScoringChannel): void
  /** 执行复合评分 */
  evaluate(input: Record<string, unknown>): CompositeScoreResult
  /** 获取阈值判断（低于阈值=不通过） */
  getThreshold(): number
  /** 设置阈值 */
  setThreshold(threshold: number): void
}

// ════════════════════════════════════════════════════════════════
//  5. Cross Validation — 交叉验证（源：ASRCrossValidationStage）
// ════════════════════════════════════════════════════════════════

/** 文本比较结果 */
export interface TextCompareResult {
  /** 相似度 (0–1) */
  similarity: number
  /** 字符错误率 (0–1) */
  cer: number
  /** n-gram 重叠率 (0–1) */
  overlapScore: number
  /** 是否通过验证 */
  validated: boolean
}

/** 交叉验证策略接口 */
export interface CrossValidationStrategy {
  /** 策略名称 */
  readonly name: string
  /** 比较两段文本的相似度 */
  compare(original: string, target: string): TextCompareResult
  /** 设置通过阈值 */
  setThreshold(threshold: number): void
}

// ════════════════════════════════════════════════════════════════
//  6. ASR→Reasoning 领域适配映射
// ════════════════════════════════════════════════════════════════

/**
 * ASR 算法模式 → 博客写作领域 映射表。
 * 纯数据映射，供适配器内部使用。
 */
export const ASR_TO_BLOG_MAPPING = {
  /** 降级链映射：ASR 引擎 → 博客评估策略 */
  fallbackChain: {
    asrGpu: 'llm_evaluation' as const,
    asrCpu: 'rule_based_evaluation' as const,
    asrBaidu: 'heuristic_fallback' as const,
  },
  /** 多路径融合映射：ASR 解码器 → 博客评估维度 */
  fusionPaths: {
    whisperGpu: 'content_depth' as keyof BlogDimensionScores,
    whisperCpu: 'code_quality' as keyof BlogDimensionScores,
    baidu: 'readability' as keyof BlogDimensionScores,
  },
  /** 上下文增强映射：ASR 上下文 → 博客元信息 */
  contextBoost: {
    conversationTopics: 'topic' as keyof BlogAssessmentInput,
    keyEntities: 'targetAudience' as keyof BlogAssessmentInput,
    recentUserText: 'style' as keyof BlogAssessmentInput,
  },
} as const

// ════════════════════════════════════════════════════════════════
//  7. 适配器统一配置
// ════════════════════════════════════════════════════════════════

/** ASR→Reasoning 适配器配置 */
export interface AsrReasoningAdapterConfig {
  /** 降级链配置 */
  fallback: {
    enabled: boolean
    stepTimeoutsMs: number[]
  }
  /** 融合配置 */
  fusion: MultiPathFusionConfig
  /** 上下文增强配置 */
  contextBoost: {
    enabled: boolean
    maxBoost: number
    decayFactor: number
  }
  /** 置信度评分配置 */
  scoring: {
    threshold: number
    minDataPoints: number
  }
}

/** 默认适配器配置 */
export const DEFAULT_ADAPTER_CONFIG: AsrReasoningAdapterConfig = {
  fallback: {
    enabled: true,
    stepTimeoutsMs: [8000, 12000, 5000],
  },
  fusion: { ...DEFAULT_FUSION_CONFIG },
  contextBoost: {
    enabled: true,
    maxBoost: 0.15,
    decayFactor: 0.85,
  },
  scoring: {
    threshold: 0.6,
    minDataPoints: 1,
  },
}
