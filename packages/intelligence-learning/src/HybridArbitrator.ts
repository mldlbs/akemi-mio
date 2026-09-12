/**
 * HybridArbitrator — 混合流水线仲裁器
 *
 * 职责：
 * 1. 对比双路径在同一个汇合点的输出
 * 2. 计算分歧度（divergence score）
 * 3. 在分歧超过阈值时触发仲裁
 * 4. 仲裁方法：置信度择优 / 加权融合
 *
 * 仲裁策略：
 * - 分歧度 < 阈值 → 视为一致，直接采用置信度较高的结果
 * - 分歧度 >= 阈值 → 触发仲裁：
 *   - 类别型输出：置信度择优（pick by confidence）
 *   - 数值型输出：加权融合（weighted fusion）
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { DEFAULT_HYBRID_CONFIG } from './HybridTypes'
import type {
  HybridPathOutput,
  ConvergenceResult,
  ConvergencePointName,
  StepSuggestion,
  DifficultyAssessmentOutput,
  StrategySuggestion,
  ProgressEvaluationOutput,
  HybridPipelineConfig,
} from './HybridTypes'

// =============================================================================
// 仲裁器
// =============================================================================

export class HybridArbitrator {
  private config: HybridPipelineConfig
  private totalArbitrations = 0
  private perMethodCount: Record<string, number> = {
    identical: 0,
    pick_original: 0,
    pick_evolution: 0,
    weighted_fusion: 0,
  }
  private totalDivergenceSum = 0

  constructor(config?: Partial<HybridPipelineConfig>) {
    this.config = { ...DEFAULT_HYBRID_CONFIG, ...config }
  }

  /**
   * 对双路径输出进行仲裁。
   *
   * @param point    汇合点名称
   * @param original 原始路径输出
   * @param evolution 进化路径输出
   * @returns 仲裁结果
   */
  arbitrate<T>(point: ConvergencePointName, original: HybridPathOutput<T>, evolution: HybridPathOutput<T>): ConvergenceResult<T> {
    const divergenceScore = this.computeDivergence(point, original.output, evolution.output)

    let arbitratedOutput: T
    let method: ConvergenceResult<T>['arbitrationMethod']
    let rationale: string

    if (divergenceScore < this.config.divergenceThreshold) {
      // 分歧小 → 视为一致，取置信度高的结果
      if (original.confidence >= evolution.confidence) {
        arbitratedOutput = original.output
        method = 'identical'
        rationale = `分歧度 ${divergenceScore.toFixed(3)} < 阈值 ${this.config.divergenceThreshold}，采用置信度更高的原始路径 (${original.confidence} ≥ ${evolution.confidence})`
      } else {
        arbitratedOutput = evolution.output
        method = 'identical'
        rationale = `分歧度 ${divergenceScore.toFixed(3)} < 阈值 ${this.config.divergenceThreshold}，采用置信度更高的进化路径 (${evolution.confidence} > ${original.confidence})`
      }
    } else {
      // 分歧大 → 触发仲裁
      const result = this.resolveConflict(point, original, evolution, divergenceScore)
      arbitratedOutput = result.output as T
      method = result.method
      rationale = result.rationale
    }

    this.totalArbitrations++
    this.totalDivergenceSum += divergenceScore
    this.perMethodCount[method]++

    if (this.config.verbose) {
      log('INFO', 'hybrid_arbitration_result', {
        point,
        method,
        divergenceScore: divergenceScore.toFixed(3),
        originalConfidence: original.confidence,
        evolutionConfidence: evolution.confidence,
        rationale,
      })
    }

    return {
      point,
      originalOutput: original,
      evolutionOutput: evolution,
      divergenceScore,
      arbitratedOutput,
      arbitrationMethod: method,
      rationale,
    }
  }

  /**
   * 计算分歧度（0=完全一致，1=完全分歧）。
   * 根据汇合点类型采用不同的比较策略。
   */
  private computeDivergence<T>(point: ConvergencePointName, a: T, b: T): number {
    switch (point) {
      case 'step_planning':
        return this.divergenceForSteps(a as unknown as StepSuggestion[], b as unknown as StepSuggestion[])
      case 'difficulty':
        return this.divergenceForDifficulty(a as unknown as DifficultyAssessmentOutput, b as unknown as DifficultyAssessmentOutput)
      case 'strategy':
        return this.divergenceForStrategy(a as unknown as StrategySuggestion[], b as unknown as StrategySuggestion[])
      case 'progress_evaluation':
        return this.divergenceForEvaluation(a as unknown as ProgressEvaluationOutput, b as unknown as ProgressEvaluationOutput)
      default:
        // 默认：严格相等比较
        return JSON.stringify(a) === JSON.stringify(b) ? 0 : 0.5
    }
  }

  /**
   * 步骤建议分歧度：Jaccard 距离（描述文本交集/并集）+ 排序差异。
   */
  private divergenceForSteps(original: StepSuggestion[], evolution: StepSuggestion[]): number {
    if (original.length === 0 && evolution.length === 0) return 0
    if (original.length === 0 || evolution.length === 0) return 1

    const originalDescs = new Set(original.map((s) => s.description))
    const evolutionDescs = new Set(evolution.map((s) => s.description))

    // Jaccard 距离 = 1 - (交集大小 / 并集大小)
    const intersection = new Set([...originalDescs].filter((d) => evolutionDescs.has(d)))
    const union = new Set([...originalDescs, ...evolutionDescs])
    const jaccardDist = 1 - intersection.size / union.size

    // 如果 Jaccard 距离已大，直接返回
    if (jaccardDist > 0.5) return jaccardDist

    // 进一步检查排序一致性（仅限共同项）
    const commonDescs = [...intersection]
    if (commonDescs.length < 2) return jaccardDist

    const origRank = new Map(commonDescs.map((d, i) => [d, original.findIndex((s) => s.description === d)]))
    const evolRank = new Map(commonDescs.map((d, i) => [d, evolution.findIndex((s) => s.description === d)]))
    let rankDisagreements = 0
    for (const desc of commonDescs) {
      const oi = origRank.get(desc) ?? 0
      const ei = evolRank.get(desc) ?? 0
      if (Math.abs(oi - ei) > 1) rankDisagreements++
    }
    const rankPenalty = rankDisagreements / commonDescs.length

    return Math.min(1, jaccardDist * 0.7 + rankPenalty * 0.3)
  }

  /**
   * 困难评估分歧度：分类 + 频次差异。
   */
  private divergenceForDifficulty(original: DifficultyAssessmentOutput, evolution: DifficultyAssessmentOutput): number {
    if (original.conceptId !== evolution.conceptId) return 1
    let score = 0
    // 分类不一致 → 0.5
    if (original.category !== evolution.category) score += 0.5
    // 频次差异
    const maxFreq = Math.max(original.frequency, evolution.frequency) || 1
    score += 0.3 * (Math.abs(original.frequency - evolution.frequency) / maxFreq)
    // 描述文本差异
    const descSimilarity = this.stringSimilarity(original.description, evolution.description)
    score += 0.2 * (1 - descSimilarity)
    return Math.min(1, score)
  }

  /**
   * 策略建议分歧度：类型 + 参数差异。
   */
  private divergenceForStrategy(original: StrategySuggestion[], evolution: StrategySuggestion[]): number {
    if (original.length === 0 && evolution.length === 0) return 0
    if (original.length === 0 || evolution.length === 0) return 1

    // 比较策略类型分布
    const origTypes = new Set(original.map((s) => s.type))
    const evolTypes = new Set(evolution.map((s) => s.type))
    const typeIntersection = new Set([...origTypes].filter((t) => evolTypes.has(t)))
    const typeUnion = new Set([...origTypes, ...evolTypes])
    const typeJaccard = typeIntersection.size / typeUnion.size

    // 置信度加权差异
    const origConfAvg = original.reduce((s, st) => s + st.confidence, 0) / original.length
    const evolConfAvg = evolution.reduce((s, st) => s + st.confidence, 0) / evolution.length
    const confDiff = Math.abs(origConfAvg - evolConfAvg)

    return 1 - (typeJaccard * 0.6 + (1 - confDiff) * 0.4)
  }

  /**
   * 进度评估分歧度：判定结论是否一致。
   */
  private divergenceForEvaluation(original: ProgressEvaluationOutput, evolution: ProgressEvaluationOutput): number {
    // 判定一致 → 低分歧
    if (original.verdict === evolution.verdict && original.action === evolution.action) {
      return 0.2 * (1 - Math.min(original.confidence, evolution.confidence))
    }
    // 判定不一致 → 高分歧
    // verdict 差异权重 0.6，action 差异权重 0.4
    let score = 0
    if (original.verdict !== evolution.verdict) score += 0.6
    if (original.action !== evolution.action) score += 0.4
    return Math.min(1, score)
  }

  // =============================================================================
  // 冲突解决
  // =============================================================================

  private resolveConflict<T>(
    point: ConvergencePointName,
    original: HybridPathOutput<T>,
    evolution: HybridPathOutput<T>,
    divergenceScore: number,
  ): { output: unknown; method: ConvergenceResult<T>['arbitrationMethod']; rationale: string } {
    switch (point) {
      case 'step_planning':
        return this.resolveStepConflict(
          original as unknown as HybridPathOutput<StepSuggestion[]>,
          evolution as unknown as HybridPathOutput<StepSuggestion[]>,
        )
      case 'difficulty':
        return this.resolveDifficultyConflict(
          original as unknown as HybridPathOutput<DifficultyAssessmentOutput>,
          evolution as unknown as HybridPathOutput<DifficultyAssessmentOutput>,
        )
      case 'strategy':
        return this.resolveStrategyConflict(
          original as unknown as HybridPathOutput<StrategySuggestion[]>,
          evolution as unknown as HybridPathOutput<StrategySuggestion[]>,
        )
      case 'progress_evaluation':
        return this.resolveEvaluationConflict(
          original as unknown as HybridPathOutput<ProgressEvaluationOutput>,
          evolution as unknown as HybridPathOutput<ProgressEvaluationOutput>,
          divergenceScore,
        )
      default:
        // 默认：置信度择优
        return this.pickByConfidence(original, evolution)
    }
  }

  /**
   * 步骤冲突解决：加权融合（合并步骤列表，按置信度加权排序）。
   */
  private resolveStepConflict(
    original: HybridPathOutput<StepSuggestion[]>,
    evolution: HybridPathOutput<StepSuggestion[]>,
  ): { output: StepSuggestion[]; method: 'weighted_fusion'; rationale: string } {
    const merged = new Map<string, StepSuggestion>()

    for (const step of original.output) {
      merged.set(step.description, {
        ...step,
        weight: this.config.originalPathWeight,
        priority: step.priority * (1 / this.config.originalPathWeight),
      })
    }

    for (const step of evolution.output) {
      const existing = merged.get(step.description)
      if (existing) {
        // 融合：优先级取加权平均
        existing.priority = existing.priority * this.config.originalPathWeight + step.priority * this.config.evolutionPathWeight
        existing.weight = Math.max(existing.weight ?? 0, step.weight ?? 0)
      } else {
        merged.set(step.description, {
          ...step,
          weight: this.config.evolutionPathWeight,
          priority: step.priority * (1 / this.config.evolutionPathWeight),
        })
      }
    }

    const fused = Array.from(merged.values()).sort((a, b) => a.priority - b.priority)

    return {
      output: fused,
      method: 'weighted_fusion',
      rationale: `步骤建议分歧，执行加权融合：原始路径 ${this.config.originalPathWeight} + 进化路径 ${this.config.evolutionPathWeight}，融合后 ${fused.length} 个步骤`,
    }
  }

  /**
   * 困难评估冲突解决：取置信度高的路径输出。
   */
  private resolveDifficultyConflict(
    original: HybridPathOutput<DifficultyAssessmentOutput>,
    evolution: HybridPathOutput<DifficultyAssessmentOutput>,
  ): { output: DifficultyAssessmentOutput; method: 'pick_original' | 'pick_evolution'; rationale: string } {
    const better = original.confidence >= evolution.confidence ? original : evolution
    return {
      output: better.output,
      method: better.path === 'original' ? 'pick_original' : 'pick_evolution',
      rationale: `困难评估分歧，采用置信度更高的 ${better.path} 路径 (${better.confidence} ≥ ${better.path === 'original' ? evolution.confidence : original.confidence})`,
    }
  }

  /**
   * 策略冲突解决：取置信度择优，同类型则融合。
   */
  private resolveStrategyConflict(
    original: HybridPathOutput<StrategySuggestion[]>,
    evolution: HybridPathOutput<StrategySuggestion[]>,
  ): { output: StrategySuggestion[]; method: 'weighted_fusion' | 'pick_original' | 'pick_evolution'; rationale: string } {
    // 如果某条路径无建议，采用另一条
    if (original.output.length === 0 && evolution.output.length > 0) {
      return {
        output: evolution.output,
        method: 'pick_evolution',
        rationale: '原始路径无策略建议，采用进化路径建议',
      }
    }
    if (evolution.output.length === 0 && original.output.length > 0) {
      return {
        output: original.output,
        method: 'pick_original',
        rationale: '进化路径无策略建议，采用原始路径建议',
      }
    }

    // 融合：按类型合并，取置信度加权
    const merged = new Map<string, StrategySuggestion>()

    for (const s of original.output) {
      merged.set(s.type, { ...s, confidence: s.confidence * this.config.originalPathWeight })
    }
    for (const s of evolution.output) {
      const existing = merged.get(s.type)
      if (existing) {
        existing.confidence = existing.confidence * this.config.originalPathWeight + s.confidence * this.config.evolutionPathWeight
        existing.description = s.description // 取描述更详细的
      } else {
        merged.set(s.type, { ...s, confidence: s.confidence * this.config.evolutionPathWeight })
      }
    }

    const fused = Array.from(merged.values()).sort((a, b) => b.confidence - a.confidence)

    return {
      output: fused,
      method: 'weighted_fusion',
      rationale: `策略建议分歧，执行加权融合：${fused.length} 条策略（原始 ${original.output.length} + 进化 ${evolution.output.length}）`,
    }
  }

  /**
   * 进度评估冲突解决：置信度择优 + 保守偏置（倾向于选择更审慎的判定）。
   */
  private resolveEvaluationConflict(
    original: HybridPathOutput<ProgressEvaluationOutput>,
    evolution: HybridPathOutput<ProgressEvaluationOutput>,
    divergenceScore: number,
  ): { output: ProgressEvaluationOutput; method: 'pick_original' | 'pick_evolution'; rationale: string } {
    // 置信度择优
    const better = original.confidence >= evolution.confidence ? original : evolution
    const other = original.confidence >= evolution.confidence ? evolution : original

    // 如果分歧很大 (>= 0.7)，采用保守策略：选择「恶化 / unchanged」而不是「进步」
    if (divergenceScore >= 0.7) {
      const verdicts = [original.output.verdict, evolution.output.verdict]
      const conservative = verdicts.includes('worsened') ? 'worsened' : 'unchanged'
      return {
        output: {
          verdict: conservative,
          action: conservative === 'worsened' ? 'rollback' : 'no_action',
          confidence: Math.max(original.confidence, evolution.confidence) * 0.8,
          rationale: `高度分歧 (${divergenceScore.toFixed(2)})，采用保守判定 "${conservative}"`,
        },
        method: better.path === 'original' ? 'pick_original' : 'pick_evolution',
        rationale: `高度分歧 (${divergenceScore.toFixed(2)})，采用保守判定 "${conservative}"（基于 ${better.path} 路径评估）`,
      }
    }

    return {
      output: better.output,
      method: better.path === 'original' ? 'pick_original' : 'pick_evolution',
      rationale: `进度评估分歧，采用置信度更高的 ${better.path} 路径 (${better.confidence} ≥ ${other.confidence})`,
    }
  }

  // =============================================================================
  // 通用的置信度择优
  // =============================================================================

  private pickByConfidence<T>(
    original: HybridPathOutput<T>,
    evolution: HybridPathOutput<T>,
  ): { output: T; method: 'pick_original' | 'pick_evolution'; rationale: string } {
    const better = original.confidence >= evolution.confidence ? original : evolution
    const other = original.confidence >= evolution.confidence ? evolution : original
    return {
      output: better.output,
      method: better.path === 'original' ? 'pick_original' : 'pick_evolution',
      rationale: `采用置信度更高的 ${better.path} 路径 (${better.confidence} ≥ ${other.confidence})`,
    }
  }

  // =============================================================================
  // 工具方法
  // =============================================================================

  /**
   * 字符串相似度（Levenshtein 距离归一化）。
   */
  private stringSimilarity(a: string, b: string): number {
    if (a === b) return 1
    if (a.length === 0 || b.length === 0) return 0
    const maxLen = Math.max(a.length, b.length)
    const dist = this.levenshtein(a, b)
    return 1 - dist / maxLen
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length
    const n = b.length
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
    for (let i = 0; i <= m; i++) dp[i][0] = i
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1
      }
    }
    return dp[m][n]
  }

  // =============================================================================
  // 指标查询
  // =============================================================================

  getMetrics(): {
    totalArbitrations: number
    perMethodCount: Record<string, number>
    avgDivergence: number
  } {
    return {
      totalArbitrations: this.totalArbitrations,
      perMethodCount: { ...this.perMethodCount },
      avgDivergence: this.totalArbitrations > 0 ? this.totalDivergenceSum / this.totalArbitrations : 0,
    }
  }
}
