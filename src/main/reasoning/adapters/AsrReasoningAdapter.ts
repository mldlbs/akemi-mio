/**
 * AsrReasoningAdapter — ASR 算法 → Plan:推理链 兼容适配层
 *
 * ── 设计目的 ──
 * 提取 ASR（Automatic Speech Recognition）核心算法的输入输出接口，
 * 为「Plan:推理链: 为项目的技术博客内容设计一套从写作到发布的完整工作流」
 * 上下文实现兼容适配层。
 *
 * 复用不追求 1:1 精确移植，而是保留算法核心逻辑并用 Plan:推理链 的
 * 数据格式做输入输出转换。
 *
 * ── 复用的 ASR 算法模式 ──
 *
 * 1. Multi-Engine Fallback Chain（来自 AsrService.transcribe()）
 *    - 原始：GPU Whisper → CPU Whisper → Baidu（顺序降级）
 *    - 适配：LLM Evaluation → Rule-Based Evaluation → Heuristic Fallback
 *
 * 2. Multi-Path Weighted Fusion（来自 FusionEngine）
 *    - 原始：多个解码器并行执行，加权投票融合
 *    - 适配：多维度评分并行计算，加权融合为综合质量评分
 *
 * 3. Context-Aware Hotword Boosting（来自 AsrContextBuilder）
 *    - 原始：对话上下文主题/实体 → 热词列表/提示词
 *    - 适配：博客话题/平台/受众 → 维度权重动态调整
 *
 * 4. Composite Confidence Scoring（来自 AsrConfidenceScorer）
 *    - 原始：文本特征 × 音频特征 → 综合置信度 (0–1)
 *    - 适配：内容特征 × 元数据特征 → 综合质量评分 (0–1)
 *
 * 5. Cross-Validation with Edit Distance（来自 ASRCrossValidationStage）
 *    - 原始：原始文本 vs ASR 转写文本 → 编辑距离 + CER + n-gram 重叠
 *    - 适配：大纲 vs 成文 → 内容一致性校验
 *
 * ── 架构关系 ──
 *   Plan:推理链 (ReasoningPlanner)
 *       ↓
 *   AsrReasoningAdapter (this class)
 *       ↓  复用 ASR 算法模式
 *   ASR 系统（AsrService / FusionEngine / AsrConfidenceScorer / …）
 *
 * ── 使用示例 ──
 * ```ts
 * import { asrReasoningAdapter } from './reasoning/adapters'
 *
 * // 博客写作推理链场景
 * const ctx: ReasoningContext = { input: { text: '写一篇关于 TypeScript 泛型的博客', category: 'blog' } }
 * const result = asrReasoningAdapter.planForBlog(ctx)
 * // result.directive — 推理指令（思考模式+目标+约束）
 * // result.fallbackResult — 降级链执行记录
 * // result.boostResult — 上下文增强记录
 * ```
 */

import { log } from '../../logger/Logger'
import type { BlogAssessmentInput, BlogDimensionScores } from '../../agent/blog/PlanBlogWritingAdapter'
import type { ReasoningDirective, ThinkingPattern } from '../types'
import type { ReasoningContext } from './types'
import { EMPTY_DIRECTIVE } from '../types'
import type {
  FallbackChainStrategy,
  FallbackStep,
  FallbackResult,
  ContextBoostStrategy,
  BoostFactor,
  BoostResult,
  CompositeScoringStrategy,
  CompositeScoreResult,
  ScoringChannel,
  CrossValidationStrategy,
  TextCompareResult,
  AsrReasoningAdapterConfig,
} from './types'
import { DEFAULT_ADAPTER_CONFIG } from './types'

// ════════════════════════════════════════════════════════════════
//  工具函数 — 适配自 ASRCrossValidationStage 的编辑距离算法
// ════════════════════════════════════════════════════════════════

/**
 * Levenshtein 编辑距离（滚动数组优化）。
 * 移植自 ASRCrossValidationStage.levenshteinDistance()。
 */
function levenshteinDistance(a: string, b: string): number {
  const an = a.length
  const bn = b.length
  if (an === 0) return bn
  if (bn === 0) return an
  const [shorter, longer] = an < bn ? [a, b] : [b, a]
  const [sn, ln] = [shorter.length, longer.length]
  let prevRow = new Array<number>(sn + 1)
  let currRow = new Array<number>(sn + 1)
  for (let j = 0; j <= sn; j++) prevRow[j] = j
  for (let i = 1; i <= ln; i++) {
    currRow[0] = i
    for (let j = 1; j <= sn; j++) {
      const cost = shorter[j - 1] === longer[i - 1] ? 0 : 1
      currRow[j] = Math.min(
        prevRow[j] + 1,
        currRow[j - 1] + 1,
        prevRow[j - 1] + cost,
      )
    }
    ;[prevRow, currRow] = [currRow, prevRow]
  }
  return prevRow[sn]
}

/**
 * 计算 CER（Character Error Rate）。
 * 移植自 ASRCrossValidationStage.computeCER()。
 */
function computeCER(original: string, target: string): number {
  const maxLen = Math.max(original.length, target.length)
  if (maxLen === 0) return 0
  return levenshteinDistance(original, target) / maxLen
}

/**
 * 计算 bigram 重叠相似度（Jaccard）。
 * 移植自 ASRCrossValidationStage.computeOverlapSimilarity()。
 */
function computeOverlapSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1.0
  if (a.length === 0 || b.length === 0) return 0.0
  const bigramsA = new Set<string>()
  const bigramsB = new Set<string>()
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2))
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2))
  const intersection = new Set<string>()
  for (const bg of bigramsA) if (bigramsB.has(bg)) intersection.add(bg)
  const union = new Set([...bigramsA, ...bigramsB])
  if (union.size === 0) return 1.0
  return intersection.size / union.size
}

// ════════════════════════════════════════════════════════════════
//  FallbackChainStrategy — 顺序降级策略实现（适配自 AsrService）
// ════════════════════════════════════════════════════════════════

export class GenericFallbackChain<TIn, TOut> implements FallbackChainStrategy<TIn, TOut> {
  readonly name: string
  private steps: FallbackStep<TIn, TOut>[] = []

  constructor(name: string) {
    this.name = name
  }

  addStep(step: FallbackStep<TIn, TOut>): void {
    this.steps.push(step)
  }

  async execute(input: TIn): Promise<FallbackResult<TOut>> {
    const records: FallbackResult<TOut>['steps'] = []
    const t0 = Date.now()

    for (const step of this.steps) {
      if (!step.canHandle(input)) {
        records.push({ name: step.name, success: false, latencyMs: 0, error: 'canHandle returned false' })
        continue
      }

      const t1 = Date.now()
      try {
        const result = await Promise.race([
          step.execute(input),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${step.name} timeout after ${step.timeoutMs}ms`)), step.timeoutMs),
          ),
        ])

        const latency = Date.now() - t1
        records.push({ name: step.name, success: true, latencyMs: latency })

        log('DEBUG', 'asr_adapter_fallback_step_ok', {
          adapter: this.name,
          step: step.name,
          latencyMs: latency,
        })

        return {
          success: true,
          value: result,
          stepName: step.name,
          totalLatencyMs: Date.now() - t0,
          steps: records,
        }
      } catch (err) {
        const latency = Date.now() - t1
        const errMsg = err instanceof Error ? err.message : String(err)
        records.push({ name: step.name, success: false, latencyMs: latency, error: errMsg })

        log('WARN', 'asr_adapter_fallback_step_failed', {
          adapter: this.name,
          step: step.name,
          error: errMsg,
          latencyMs: latency,
        })
      }
    }

    return {
      success: false,
      value: null,
      stepName: 'all_failed',
      totalLatencyMs: Date.now() - t0,
      steps: records,
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  ContextBoostStrategy — 上下文感知权重增强（适配自 AsrContextBuilder）
// ════════════════════════════════════════════════════════════════

export class GenericContextBoost implements ContextBoostStrategy {
  readonly name: string
  private factors: BoostFactor[] = []
  private maxBoost: number
  private decayFactor: number

  constructor(name: string, maxBoost = 0.15, decayFactor = 0.85) {
    this.name = name
    this.maxBoost = maxBoost
    this.decayFactor = decayFactor
  }

  addFactor(factor: BoostFactor): void {
    this.factors.push(factor)
  }

  boost(score: number, context: Record<string, unknown>): BoostResult {
    const appliedBoosts: BoostResult['appliedBoosts'] = []
    let totalBoost = 0

    for (const factor of this.factors) {
      if (factor.matches(context)) {
        const multiplier = factor.dynamicMultiplier(context)
        const boostValue = factor.baseBoost * multiplier * this.decayFactor
        const clamped = Math.min(boostValue, this.maxBoost)
        totalBoost += clamped
        appliedBoosts.push({
          name: factor.name,
          value: clamped,
          reason: `factor matched, base=${factor.baseBoost}, multiplier=${multiplier.toFixed(2)}`,
        })
      }
    }

    const clampedTotal = Math.min(totalBoost, this.maxBoost)

    log('DEBUG', 'asr_adapter_context_boost', {
      adapter: this.name,
      factorsApplied: appliedBoosts.length,
      totalBoost: clampedTotal.toFixed(3),
      originalScore: score.toFixed(3),
    })

    return {
      appliedBoosts,
      totalBoost: clampedTotal,
      boostedScore: Math.min(1, Math.max(0, score + clampedTotal)),
    }
  }

  clearFactors(): void {
    this.factors = []
  }
}

// ════════════════════════════════════════════════════════════════
//  CompositeScoringStrategy — 复合评分（适配自 AsrConfidenceScorer）
// ════════════════════════════════════════════════════════════════

export class GenericCompositeScoring implements CompositeScoringStrategy {
  readonly name: string
  private channels: ScoringChannel[] = []
  private threshold = 0.6

  constructor(name: string) {
    this.name = name
  }

  addChannel(channel: ScoringChannel): void {
    this.channels.push(channel)
  }

  evaluate(input: Record<string, unknown>): CompositeScoreResult {
    const channelResults: CompositeScoreResult['channels'] = []
    let weightedSum = 0
    let totalWeight = 0

    for (const ch of this.channels) {
      const rawScore = ch.score(input)
      const clampedScore = Math.max(0, Math.min(1, rawScore))
      const weighted = clampedScore * ch.weight
      weightedSum += weighted
      totalWeight += ch.weight
      channelResults.push({
        name: ch.name,
        score: clampedScore,
        weight: ch.weight,
        weightedScore: weighted,
      })
    }

    const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0
    // 置信度：有多少通道有足够数据做出评分
    const dataPoints = channelResults.filter(c => c.score > 0 || c.weight > 0).length
    const confidence = Math.min(1, dataPoints / Math.max(1, this.channels.length))

    log('DEBUG', 'asr_adapter_composite_score', {
      adapter: this.name,
      score: finalScore.toFixed(3),
      confidence: confidence.toFixed(3),
      channels: channelResults.length,
      dataPoints,
    })

    return {
      score: Math.max(0, Math.min(1, finalScore)),
      channels: channelResults,
      confidence,
    }
  }

  getThreshold(): number {
    return this.threshold
  }

  setThreshold(threshold: number): void {
    this.threshold = threshold
  }
}

// ════════════════════════════════════════════════════════════════
//  CrossValidationStrategy — 交叉验证（适配自 ASRCrossValidationStage）
// ════════════════════════════════════════════════════════════════

export class GenericCrossValidation implements CrossValidationStrategy {
  readonly name: string
  private threshold = 0.7

  constructor(name: string) {
    this.name = name
  }

  compare(original: string, target: string): TextCompareResult {
    // 直接移植 ASRCrossValidationStage 算法
    const cer = computeCER(original, target)
    const overlapScore = computeOverlapSimilarity(original, target)
    const fromCer = 1 - cer
    const similarity = fromCer * 0.6 + overlapScore * 0.4

    const result: TextCompareResult = {
      similarity: Math.max(0, Math.min(1, similarity)),
      cer,
      overlapScore,
      validated: similarity >= this.threshold,
    }

    log('DEBUG', 'asr_adapter_cross_validation', {
      adapter: this.name,
      similarity: result.similarity.toFixed(3),
      cer: result.cer.toFixed(3),
      validated: result.validated,
      originalLen: original.length,
      targetLen: target.length,
    })

    return result
  }

  setThreshold(threshold: number): void {
    this.threshold = threshold
  }
}

// ════════════════════════════════════════════════════════════════
//  AsrReasoningAdapter — 核心适配器
// ════════════════════════════════════════════════════════════════

/**
 * AsrReasoningAdapter — ASR 算法 → Plan:推理链 兼容适配层。
 *
 * 将 ASR 系统（AsrService / FusionEngine / AsrConfidenceScorer）
 * 的核心算法模式，适配到 Plan:推理链（Reasoning Planner）的
 * 博客写作工作流场景。
 *
 * 每一个适配的方法都标注了其原始 ASR 算法来源，
 * 方便追踪算法版本和后续更新。
 */
export class AsrReasoningAdapter {
  readonly name = 'asr-reasoning-adapter'

  /** 降级链实例（源：AsrService.transcribe()） */
  readonly fallbackChain: FallbackChainStrategy<BlogAssessmentInput, BlogDimensionScores>

  /** 上下文增强实例（源：AsrContextBuilder） */
  readonly contextBoost: ContextBoostStrategy

  /** 复合评分实例（源：AsrConfidenceScorer） */
  readonly compositeScoring: CompositeScoringStrategy

  /** 交叉验证实例（源：ASRCrossValidationStage） */
  readonly crossValidation: CrossValidationStrategy

  private config: AsrReasoningAdapterConfig

  constructor(config?: Partial<AsrReasoningAdapterConfig>) {
    this.config = { ...DEFAULT_ADAPTER_CONFIG, ...config }

    // ── 初始化 ASR 算法组件 ──

    // 1. 降级链（源：AsrService GPU→CPU→Baidu）
    this.fallbackChain = this.buildFallbackChain()

    // 2. 上下文增强（源：AsrContextBuilder）
    this.contextBoost = this.buildContextBoost()

    // 3. 复合评分（源：AsrConfidenceScorer）
    this.compositeScoring = this.buildCompositeScoring()

    // 4. 交叉验证（源：ASRCrossValidationStage）
    this.crossValidation = new GenericCrossValidation('blog-content-crossval')
    this.crossValidation.setThreshold(0.7)

    log('INFO', 'asr_reasoning_adapter_init', {
      fallbackEnabled: this.config.fallback.enabled,
      fusionStrategy: this.config.fusion.strategy,
      contextBoostEnabled: this.config.contextBoost.enabled,
      scoreThreshold: this.config.scoring.threshold,
    })
  }

  // ═══════════════════════════════════════════════════════════════
  //  Plan:推理链 入口
  // ═══════════════════════════════════════════════════════════════

  /**
   * 为博客写作推理链场景生成推理指令。
   *
   * 输入：ReasoningContext（博客写作请求）
   * 输出：推理指令 + 适配层执行记录
   *
   * ASR 算法贡献：
   * - 上下文增强 → 动态决定 ThinkingPattern（源：AsrContextBuilder）
   * - 降级链 → 质量评估多策略（源：AsrService）
   * - 复合评分 → 综合质量评分（源：AsrConfidenceScorer）
   */
  async planForBlog(ctx: ReasoningContext): Promise<{
    directive: ReasoningDirective
    scoreResult: CompositeScoreResult | null
    boostResult: BoostResult | null
    fallbackResult: FallbackResult<BlogDimensionScores> | null
  }> {
    const t0 = Date.now()
    const blogInput = this.toBlogInput(ctx)

    // 1. 上下文增强（源：AsrContextBuilder）
    const basePattern = this.selectBasePattern(ctx)
    let boostResult: BoostResult | null = null
    if (this.config.contextBoost.enabled) {
      const patternScore = { cause_effect: 0.6, hypothesis_verification: 0.5, option_evaluation: 0.6, goal_constraint_tradeoff: 0.7, none: 0.3 }
      const rawScore = patternScore[basePattern] ?? 0.5
      boostResult = this.contextBoost.boost(rawScore, this.toBoostContext(ctx))
    }

    // 2. 降级链评估（源：AsrService 顺序降级）
    let fallbackResult: FallbackResult<BlogDimensionScores> | null = null
    if (this.config.fallback.enabled) {
      fallbackResult = await this.fallbackChain.execute(blogInput)
    }

    // 3. 复合评分（源：AsrConfidenceScorer）
    let scoreResult: CompositeScoreResult | null = null
    if (fallbackResult?.value) {
      scoreResult = this.compositeScoring.evaluate(fallbackResult.value as unknown as Record<string, unknown>)
    } else {
      scoreResult = this.compositeScoring.evaluate(blogInput as unknown as Record<string, unknown>)
    }

    // 4. 推理指令生成
    const selectedPattern = this.determinePattern(basePattern, boostResult, scoreResult)
    const directive = this.buildDirective(selectedPattern, ctx)

    const elapsed = Date.now() - t0
    log('INFO', 'asr_reasoning_adapter_plan', {
      pattern: selectedPattern,
      score: scoreResult?.score.toFixed(3),
      confidence: scoreResult?.confidence.toFixed(3),
      boostApplied: boostResult?.totalBoost.toFixed(3),
      fallbackUsed: fallbackResult?.stepName,
      durationMs: elapsed,
    })

    return { directive, scoreResult, boostResult, fallbackResult }
  }

  /**
   * 对博客内容进行质量评分（直接调用复合评分+上下文增强）。
   *
   * ASR 算法来源：AsrConfidenceScorer.score()
   */
  assessContent(input: BlogAssessmentInput): {
    score: number
    confidence: number
    details: CompositeScoreResult['channels']
    boostApplied: number
  } {
    const rawScore = this.compositeScoring.evaluate(input as unknown as Record<string, unknown>)
    const boostResult = this.contextBoost.boost(rawScore.score, input as unknown as Record<string, unknown>)

    return {
      score: boostResult.boostedScore,
      confidence: rawScore.confidence,
      details: rawScore.channels,
      boostApplied: boostResult.totalBoost,
    }
  }

  /**
   * 校验大纲与成文的一致性（使用 ASR 交叉验证算法）。
   *
   * ASR 算法来源：ASRCrossValidationStage — 编辑距离 + bigram 重叠
   */
  validateOutlineConsistency(outline: string, draft: string): TextCompareResult {
    return this.crossValidation.compare(outline, draft)
  }

  // ═══════════════════════════════════════════════════════════════
  //  内部方法
  // ═══════════════════════════════════════════════════════════════

  /**
   * 构建降级链（源：AsrService GPU→CPU→Baidu 顺序降级）。
   *
   * 适配映射：
   *   GPU Whisper  → LLM Evaluation（精确但慢）
   *   CPU Whisper  → Rule-Based Evaluation（中等精度和速度）
   *   Baidu        → Heuristic Fallback（快速但粗略）
   */
  private buildFallbackChain(): FallbackChainStrategy<BlogAssessmentInput, BlogDimensionScores> {
    const chain = new GenericFallbackChain<BlogAssessmentInput, BlogDimensionScores>('blog-fallback-chain')

    // Step 1: LLM 级评估（适配自 GPU Whisper — 高精度，适合复杂分析）
    chain.addStep({
      name: 'llm_evaluation',
      timeoutMs: this.config.fallback.stepTimeoutsMs[0] ?? 8000,
      canHandle: (input) => !!input.content && input.content.length >= 100,
      execute: async (input) => {
        // 模拟 LLM 评估的降级维度评分
        // 在实际使用中，此处应调用 LLM 评估服务
        const scores = await this.simulateLlmEvaluation(input)
        return scores
      },
    })

    // Step 2: 规则评估（适配自 CPU Whisper — 中等精度，快速）
    chain.addStep({
      name: 'rule_based_evaluation',
      timeoutMs: this.config.fallback.stepTimeoutsMs[1] ?? 12000,
      canHandle: (input) => !!input.content,
      execute: async (input) => {
        const scores = this.ruleBasedEvaluation(input)
        return scores
      },
    })

    // Step 3: 启发式兜底（适配自 Baidu — 快速估算，低精度）
    chain.addStep({
      name: 'heuristic_fallback',
      timeoutMs: this.config.fallback.stepTimeoutsMs[2] ?? 5000,
      canHandle: () => true,
      execute: async (input) => {
        const scores = this.heuristicEvaluation(input)
        return scores
      },
    })

    return chain
  }

  /**
   * 构建上下文增强器（源：AsrContextBuilder 热词/提示词）。
   *
   * 适配映射：
   *   对话主题 → 话题权重增强
   *   关键实体 → 受众适配增强
   *   最近文本 → 风格对齐增强
   */
  private buildContextBoost(): ContextBoostStrategy {
    const booster = new GenericContextBoost('blog-context-boost',
      this.config.contextBoost.maxBoost,
      this.config.contextBoost.decayFactor,
    )

    // 因子 1：话题权重增强（源：AsrContextBuilder.topics → hotwords）
    booster.addFactor({
      name: 'topic_relevance',
      baseBoost: 0.08,
      matches: (ctx) => !!(ctx.topic as string)?.length,
      dynamicMultiplier: (ctx) => {
        const topic = (ctx.topic as string) || ''
        return Math.min(1, topic.length / 50)
      },
    })

    // 因子 2：平台适配增强（源：AsrContextBuilder.keyEntities → entities 热词）
    booster.addFactor({
      name: 'platform_adaptation',
      baseBoost: 0.05,
      matches: (ctx) => !!(ctx.platform as string)?.length,
      dynamicMultiplier: (ctx) => {
        const platform = (ctx.platform as string) || ''
        const knownPlatforms = ['博客园', 'CSDN', '知乎', '掘金', '公众号', 'Medium', 'Dev.to']
        return knownPlatforms.includes(platform) ? 1.0 : 0.5
      },
    })

    // 因子 3：受众适配增强（源：AsrContextBuilder.recentUserText → initial_prompt）
    booster.addFactor({
      name: 'audience_alignment',
      baseBoost: 0.05,
      matches: (ctx) => !!(ctx.targetAudience as string)?.length,
      dynamicMultiplier: (ctx) => {
        const level = (ctx.audienceLevel as string) || ''
        if (level === 'beginner') return 0.8
        if (level === 'advanced') return 1.2
        return 1.0
      },
    })

    return booster
  }

  /**
   * 构建复合评分器（源：AsrConfidenceScorer — 文本+音频双通道）。
   *
   * 适配映射：
   *   文本特征评分 → 内容深度评分
   *   音频特征评分 → 发布就绪评分
   */
  private buildCompositeScoring(): CompositeScoringStrategy {
    const scorer = new GenericCompositeScoring('blog-composite-scorer')

    // 通道 1：内容深度评分（源：text features → confidence）
    scorer.addChannel({
      name: 'content_depth',
      weight: 0.30,
      score: (input) => {
        const content = (input.content as string) || ''
        if (!content) return 0.4
        const codeBlocks = (content.match(/```[\s\S]*?```/g) || []).length
        const headings = (content.match(/^#{1,4}\s+.+/gm) || []).length
        const length = content.length
        let s = 0.5
        if (codeBlocks >= 3) s += 0.15
        else if (codeBlocks >= 1) s += 0.08
        if (headings >= 3) s += 0.10
        if (length >= 2000) s += 0.10
        else if (length < 500) s -= 0.15
        return Math.max(0, Math.min(1, s))
      },
    })

    // 通道 2：结构质量评分（源：audio features → confidence）
    scorer.addChannel({
      name: 'structural_quality',
      weight: 0.25,
      score: (input) => {
        const content = (input.content as string) || ''
        if (!content) return 0.5
        const h2Count = (content.match(/^##\s+.+/gm) || []).length
        const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim()).length
        let s = 0.5
        if (h2Count >= 2) s += 0.12
        if (paragraphs >= 5 && paragraphs <= 30) s += 0.10
        const hasIntro = /^(#|##)\s*.*(介绍|概述|前言|背景|引言)/im.test(content)
        const hasConclusion = /^(#|##)\s*.*(总结|结论|回顾|结语|小结)/im.test(content)
        if (hasIntro) s += 0.08
        if (hasConclusion) s += 0.08
        return Math.max(0, Math.min(1, s))
      },
    })

    // 通道 3：发布就绪评分（源：hallucination detection → low confidence）
    scorer.addChannel({
      name: 'publish_readiness',
      weight: 0.20,
      score: (input) => {
        const content = (input.content as string) || ''
        if (!content) return 0.4
        let s = 0.5
        const hasTitle = /^#\s+.+/m.test(content)
        if (hasTitle) s += 0.12
        const placeholders = /TODO|FIXME|XXX|待定|待补充|TBD/i
        if (placeholders.test(content)) s -= 0.12
        const brokenLinks = (content.match(/\[.+?\]\(\)/g) || []).length
        if (brokenLinks > 0) s -= 0.10
        const hasCopyright = /原创|版权|作者|转载请注明/i.test(content)
        if (hasCopyright) s += 0.05
        return Math.max(0, Math.min(1, s))
      },
    })

    // 通道 4：可读性评分（源：text length/language detection）
    scorer.addChannel({
      name: 'readability',
      weight: 0.25,
      score: (input) => {
        const content = (input.content as string) || ''
        if (!content || content.length < 100) return 0.4
        let s = 0.5
        const aiPhrases = [/值得注意的是/, /显而易见/, /毋庸置疑/, /众所周知/]
        const aiHits = aiPhrases.filter(p => p.test(content)).length
        if (aiHits >= 2) s -= 0.12
        else if (aiHits >= 1) s -= 0.05
        const sentences = content.split(/[。！？.!?]/).filter(s => s.trim().length > 5)
        if (sentences.length >= 5) {
          const lengths = sentences.map(s => s.length)
          const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length
          const variance = lengths.reduce((sum, l) => sum + (l - avg) ** 2, 0) / lengths.length
          if (Math.sqrt(variance) >= 15) s += 0.10
        }
        const hasLists = /^\s*[-*]\s/m.test(content) || /^\s*\d+\.\s/m.test(content)
        if (hasLists) s += 0.05
        return Math.max(0, Math.min(1, s))
      },
    })

    return scorer
  }

  // ═══════════════════════════════════════════════════════════════
  //  博客写作领域 — 评估策略实现
  // ═══════════════════════════════════════════════════════════════

  /**
   * 模拟 LLM 评估（降级链 Step 1）。
   * 在实际使用中，应替换为真实的 LLM 调用。
   */
  private async simulateLlmEvaluation(input: BlogAssessmentInput): Promise<BlogDimensionScores> {
    // 模拟异步处理延迟
    await new Promise(r => setTimeout(r, 100))
    // 使用规则评估的增强版本作为模拟
    const base = this.ruleBasedEvaluation(input)
    return {
      contentDepth: Math.min(1, base.contentDepth + 0.05),
      codeQuality: Math.min(1, base.codeQuality + 0.05),
      readability: Math.min(1, base.readability + 0.03),
      structuralQuality: Math.min(1, base.structuralQuality + 0.05),
      seoRelevance: Math.min(1, base.seoRelevance + 0.03),
      publishReadiness: Math.min(1, base.publishReadiness + 0.02),
    }
  }

  /**
   * 规则评估（降级链 Step 2）。
   * 移植自 PlanBlogWritingAdapter 的评估函数逻辑。
   */
  private ruleBasedEvaluation(input: BlogAssessmentInput): BlogDimensionScores {
    const { content = '' } = input
    const codeBlocks = content.match(/```[\s\S]*?```/g) || []
    const headings = content.match(/^#{1,4}\s+.+/gm) || []
    const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim())

    return {
      contentDepth: this.rateContentDepth(content, codeBlocks.length, headings.length),
      codeQuality: this.rateCodeQuality(codeBlocks, content),
      readability: this.rateReadability(content, paragraphs),
      structuralQuality: this.rateStructuralQuality(headings, paragraphs, content),
      seoRelevance: this.rateSEO(content, input.topic, input.platform),
      publishReadiness: this.ratePublishReadiness(content, input.platform),
    }
  }

  /**
   * 启发式兜底评估（降级链 Step 3）。
   * 基于文本统计特征的低精度快速估算。
   */
  private heuristicEvaluation(input: BlogAssessmentInput): BlogDimensionScores {
    const len = input.content?.length ?? 0

    if (len === 0) {
      return {
        contentDepth: 0.3, codeQuality: 0.3, readability: 0.3,
        structuralQuality: 0.2, seoRelevance: 0.2, publishReadiness: 0.1,
      }
    }

    // 仅基于长度的快速估算
    const lengthRatio = Math.min(1, len / 3000)
    return {
      contentDepth: 0.3 + lengthRatio * 0.4,
      codeQuality: 0.3 + lengthRatio * 0.3,
      readability: 0.4 + lengthRatio * 0.3,
      structuralQuality: 0.2 + lengthRatio * 0.3,
      seoRelevance: 0.2 + lengthRatio * 0.2,
      publishReadiness: 0.1 + lengthRatio * 0.2,
    }
  }

  // ── 规则评估子评分 ──

  private rateContentDepth(content: string, codeBlockCount: number, headingCount: number): number {
    if (!content) return 0.4
    let s = 0.5
    const techTerms = /TypeScript|JavaScript|React|Vue|API|SDK|HTTP|async|await|interface|type|class|component|hook|算法|架构|性能|优化|设计模式|函数|组件|状态|异步/g
    const techMatches = content.match(techTerms) || []
    const density = techMatches.length / Math.max(1, content.length / 100)
    if (density >= 2.0) s += 0.15
    else if (density >= 1.0) s += 0.08
    if (codeBlockCount >= 3) s += 0.15
    else if (codeBlockCount >= 1) s += 0.08
    if (headingCount >= 3) s += 0.05
    return Math.min(1, Math.max(0, s))
  }

  private rateCodeQuality(codeBlocks: string[], content: string): number {
    if (codeBlocks.length === 0) return content.length > 500 ? 0.5 : 0.4
    let s = 0.5
    const withLang = codeBlocks.filter(b => /```\w+\n/.test(b)).length
    if (withLang / codeBlocks.length >= 0.8) s += 0.15
    const inlineCodes = content.match(/`[^`\n]+`/g) || []
    if (inlineCodes.length >= codeBlocks.length) s += 0.10
    return Math.min(1, Math.max(0, s))
  }

  private rateReadability(content: string, _paragraphs: string[]): number {
    if (!content || content.length < 100) return 0.4
    let s = 0.5
    const aiHits = [/值得注意的是/, /显而易见/, /毋庸置疑/, /众所周知/].filter(p => p.test(content)).length
    if (aiHits >= 2) s -= 0.12
    else if (aiHits >= 1) s -= 0.05
    return Math.min(1, Math.max(0, s))
  }

  private rateStructuralQuality(headings: string[], _paragraphs: string[], content: string): number {
    if (!content) return 0.5
    let s = 0.5
    if (headings.length >= 3) s += 0.12
    else if (headings.length >= 1) s += 0.05
    else s -= 0.10
    const hasIntro = /^(#|##)\s*.*(介绍|概述|前言|背景|引言)/im.test(content)
    const hasConclusion = /^(#|##)\s*.*(总结|结论|回顾|结语|小结)/im.test(content)
    if (hasIntro) s += 0.05
    if (hasConclusion) s += 0.05
    return Math.min(1, Math.max(0, s))
  }

  private rateSEO(content: string, topic?: string, _platform?: string): number {
    if (!content) return 0.5
    let s = 0.5
    const firstLine = content.split('\n')[0] || ''
    if (/^#\s+/.test(firstLine)) {
      const title = firstLine.replace(/^#\s+/, '')
      if (title.length >= 10 && title.length <= 30) s += 0.08
      if (topic && title.includes(topic)) s += 0.08
    } else {
      s -= 0.05
    }
    const links = content.match(/\[.+?\]\(.+?\)/g) || []
    if (links.length >= 2 && links.length <= 10) s += 0.05
    return Math.min(1, Math.max(0, s))
  }

  private ratePublishReadiness(content: string, _platform?: string): number {
    if (!content) return 0.4
    let s = 0.5
    const hasTitle = /^#\s+.+/m.test(content)
    const hasBody = content.replace(/^#\s+.+/m, '').trim().length > 200
    if (hasTitle && hasBody) s += 0.10
    else if (!hasTitle) s -= 0.10
    const placeholders = /TODO|FIXME|XXX|待定|待补充|TBD/i
    if (placeholders.test(content)) s -= 0.10
    return Math.min(1, Math.max(0, s))
  }

  // ═══════════════════════════════════════════════════════════════
  //  推理选择逻辑
  // ═══════════════════════════════════════════════════════════════

  /**
   * 根据 ReasoningContext 选择基础推理模式。
   * 结合 ASR 上下文增强决定最终模式。
   */
  private selectBasePattern(ctx: ReasoningContext): ThinkingPattern {
    const text = ctx.input.text ?? ''
    const category = ctx.input.category ?? ''

    if (category === 'blog') {
      if (/大纲|结构|骨架|目录|outline|structure/.test(text)) return 'goal_constraint_tradeoff'
      if (/质量|审核|review|check|校验|评估/.test(text)) return 'option_evaluation'
      if (/优化|改进|润色|polish|improve/.test(text)) return 'goal_constraint_tradeoff'
      if (/发布|publish|平台|deploy/.test(text)) return 'option_evaluation'
      return 'goal_constraint_tradeoff'
    }

    if (category === 'code') return 'goal_constraint_tradeoff'
    if (/为什么|为何|cause|reason/.test(text)) return 'cause_effect'
    if (/比较|对比|区别|vs/.test(text)) return 'option_evaluation'
    if (/报错|bug|error|fail/.test(text)) return 'hypothesis_verification'
    return 'goal_constraint_tradeoff'
  }

  /**
   * 综合 Context Boost 和评分结果确定最终推理模式。
   */
  private determinePattern(
    base: ThinkingPattern,
    boostResult: BoostResult | null,
    scoreResult: CompositeScoreResult | null,
  ): ThinkingPattern {
    // 如果增强后分数很高，选择更开放的模式
    if (boostResult && scoreResult) {
      const boostedScore = Math.min(1, scoreResult.score + boostResult.totalBoost)
      if (boostedScore >= 0.85 && base !== 'none') {
        // 高评分 → 方案评估模式（适合发布就绪度高的内容）
        return 'option_evaluation'
      }
      if (boostedScore < 0.4) {
        // 低评分 → 假设验证模式（需要找出问题）
        return 'hypothesis_verification'
      }
    }
    return base
  }

  /**
   * 根据选中的推理模式构建 ReasoningDirective。
   */
  private buildDirective(pattern: ThinkingPattern, ctx: ReasoningContext): ReasoningDirective {
    switch (pattern) {
      case 'cause_effect':
        return {
          pattern,
          goals: [{ type: 'identify_root_cause' }, { type: 'explain_causality' }],
          constraints: [],
          outputStyle: 'causal_narrative',
        }
      case 'hypothesis_verification':
        return {
          pattern,
          goals: [{ type: 'explain_causality' }],
          constraints: [{ type: 'assumption', description: '先列出内容质量问题假设再逐条验证' }],
          outputStyle: 'causal_narrative',
        }
      case 'option_evaluation':
        return {
          pattern,
          goals: [{ type: 'compare_options' }, { type: 'evaluate_tradeoffs' }],
          constraints: [{ type: 'scope', description: '在博客内容质量和发布就绪标准下比较' }],
          outputStyle: 'structured_comparison',
        }
      case 'goal_constraint_tradeoff':
        return {
          pattern,
          goals: [{ type: 'evaluate_tradeoffs' }, { type: 'provide_recommendation' }],
          constraints: [{ type: 'priority', description: '先明确内容目标和发布约束再分析改进方案' }],
          outputStyle: 'conclusion_first',
        }
      default:
        return { ...EMPTY_DIRECTIVE }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  类型转换
  // ═══════════════════════════════════════════════════════════════

  /**
   * ReasoningContext → BlogAssessmentInput 转换。
   * 提取博客写作相关的字段。
   */
  private toBlogInput(ctx: ReasoningContext): BlogAssessmentInput {
    return {
      content: ctx.input.text ?? '',
      topic: ctx.input.metadata?.topic as string | undefined,
      platform: ctx.input.metadata?.platform as string | undefined,
      targetAudience: ctx.input.metadata?.audience as string | undefined,
      audienceLevel: ctx.input.metadata?.audienceLevel as 'beginner' | 'intermediate' | 'advanced' | undefined,
      style: ctx.input.metadata?.style as string | undefined,
      currentStage: ctx.input.metadata?.currentStage as any,
    }
  }

  /**
   * ReasoningContext → Boosting Context 转换。
   * 提取可用于上下文增强的元信息。
   */
  private toBoostContext(ctx: ReasoningContext): Record<string, unknown> {
    return {
      topic: ctx.input.metadata?.topic,
      platform: ctx.input.metadata?.platform,
      targetAudience: ctx.input.metadata?.audience,
      audienceLevel: ctx.input.metadata?.audienceLevel,
      style: ctx.input.metadata?.style,
      currentStage: ctx.input.metadata?.currentStage,
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  单例
// ════════════════════════════════════════════════════════════════

/** 全局单例 */
export const asrReasoningAdapter = new AsrReasoningAdapter()
