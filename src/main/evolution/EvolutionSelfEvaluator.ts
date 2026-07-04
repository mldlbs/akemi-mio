/**
 * EvolutionSelfEvaluator — 进化自评估器
 *
 * 在分析 cycle 完成后，对输出的质量进行自我评估。
 * 四个维度，纯本地字符串分析，无额外 LLM 调用。
 */

import { log } from '../logger/Logger'
import type { EngineeringMemory } from '../memory/EngineeringMemory'

export interface SelfEvaluationResult {
  score: number
  timestamp: number
  strategyName: string
  analysisMode: string
  dimensions: {
    planQuality: number
    analysisDiversity: number
    strategyCompliance: number
    substantiveLength: number
  }
  feedback: string[]
  outcome?: boolean
}

export class EvolutionSelfEvaluator {
  private recentEvaluations: SelfEvaluationResult[] = []
  private maxHistory: number
  private engineering: EngineeringMemory | null = null

  constructor(historyMaxEntries = 10) {
    this.maxHistory = historyMaxEntries
  }

  injectEngineering(eng: EngineeringMemory): void {
    this.engineering = eng
  }

  /** 事后记录该次演化的实际结果（plan 是否成功执行） */
  recordOutcome(score: number, succeeded: boolean): void {
    // 在 recentEvaluations 中找到最近一次匹配分数的评估，标记 outcome
    for (let i = this.recentEvaluations.length - 1; i >= 0; i--) {
      if (this.recentEvaluations[i].score === score && this.recentEvaluations[i].outcome === undefined) {
        this.recentEvaluations[i].outcome = succeeded
        break
      }
    }
  }

  /** 评估器校准：对比评分与实际成功率 */
  getCalibration(): { bias: number; sampleSize: number; isReliable: boolean } {
    const completed = this.recentEvaluations.filter((r) => r.outcome !== undefined)
    if (completed.length < 3) return { bias: 0, sampleSize: completed.length, isReliable: false }

    let totalDiff = 0
    for (const r of completed) {
      const predicted = r.score / 100 // 评分映射到 0-1
      const actual = r.outcome ? 1 : 0
      totalDiff += actual - predicted
    }
    const bias = totalDiff / completed.length // 正数 = 太悲观，负数 = 太乐观
    return { bias, sampleSize: completed.length, isReliable: completed.length >= 5 }
  }

  evaluate(params: {
    strategyName: string
    promptMode: string
    analysisSummary: string
    planCreated: boolean
    planSteps: string[]
    recentHistory: string[]
    analysisMode: string
  }): SelfEvaluationResult {
    const planQuality = this.evaluatePlanQuality(params.planSteps, params.planCreated)
    const analysisDiversity = this.evaluateDiversity(params.analysisSummary, params.recentHistory)
    const strategyCompliance = this.evaluateStrategyCompliance(
      params.strategyName,
      params.promptMode,
      params.analysisMode,
      params.analysisSummary,
    )
    const substantiveLength = this.evaluateSubstantiveLength(params.analysisSummary)

    const score = Math.round(planQuality * 0.3 + analysisDiversity * 0.25 + strategyCompliance * 0.25 + substantiveLength * 0.2)

    const feedback: string[] = []
    if (planQuality < 50 && params.planCreated) feedback.push('计划步骤缺少具体文件引用，应引用项目中的实际文件路径')
    if (analysisDiversity < 40) feedback.push('分析与近期结果高度重叠，需要探索新的分析方向')
    if (strategyCompliance < 50) feedback.push('策略选择与执行模式不匹配，检查策略配置')
    if (substantiveLength < 30) feedback.push('分析摘要过短，缺乏详细推理过程')

    const result: SelfEvaluationResult = {
      score,
      timestamp: Date.now(),
      strategyName: params.strategyName,
      analysisMode: params.analysisMode,
      dimensions: { planQuality, analysisDiversity, strategyCompliance, substantiveLength },
      feedback,
    }

    this.recentEvaluations.push(result)
    if (this.recentEvaluations.length > this.maxHistory) {
      this.recentEvaluations = this.recentEvaluations.slice(-this.maxHistory)
    }

    // 持久化到 EngineeringMemory
    if (this.engineering) {
      try {
        this.engineering.store({
          type: 'design_decision' as const,
          content: [
            `【自评估】${result.score}/100 (${params.strategyName})`,
            `计划质量: ${result.dimensions.planQuality}`,
            `分析多样性: ${result.dimensions.analysisDiversity}`,
            `策略合规: ${result.dimensions.strategyCompliance}`,
            `摘要长度: ${result.dimensions.substantiveLength}`,
            ...result.feedback.map((f) => `反馈: ${f}`),
          ].join('\n'),
          source: 'self_evaluator',
          confidence: result.score / 100,
          relatedFiles: [],
          tags: ['self_evaluation', params.strategyName, ...(result.feedback.length > 0 ? ['has_feedback'] : [])],
        })
      } catch {}
    }

    log('INFO', 'self_evaluation_complete', {
      score,
      strategy: params.strategyName,
      dimensions: result.dimensions,
      feedbackCount: feedback.length,
    })
    return result
  }

  getRecentEvaluations(count = 5): SelfEvaluationResult[] {
    return this.recentEvaluations.slice(-count)
  }

  /** 跨周期趋势分析：比较最近 5 次与前 5 次的分数变化 */
  getTrend(): 'upward' | 'downward' | 'stagnant' | 'volatile' | 'insufficient_data' {
    if (this.recentEvaluations.length < 6) return 'insufficient_data'

    const recent = this.recentEvaluations.slice(-5).map((r) => r.score)
    const prior = this.recentEvaluations.slice(-10, -5).map((r) => r.score)

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length
    const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length

    const recentStd = Math.sqrt(recent.reduce((sq, v) => sq + (v - recentAvg) ** 2, 0) / recent.length)
    const priorStd = Math.sqrt(prior.reduce((sq, v) => sq + (v - priorAvg) ** 2, 0) / prior.length)

    const avgVolatility = (recentStd + priorStd) / 2
    if (avgVolatility > 20) return 'volatile'

    const delta = recentAvg - priorAvg
    if (delta > 10) return 'upward'
    if (delta < -10) return 'downward'
    return 'stagnant'
  }

  /** 识别持续薄弱的维度，为策略变异提供目标 */
  getStrategyRecommendation(): {
    targetDimension: string | null
    avgDimScores: Record<string, number>
    trend: string
  } {
    if (this.recentEvaluations.length < 3) {
      return { targetDimension: null, avgDimScores: {}, trend: this.getTrend() }
    }

    const recent = this.recentEvaluations.slice(-5)
    const dimKeys = ['planQuality', 'analysisDiversity', 'strategyCompliance', 'substantiveLength'] as const
    const avgDimScores: Record<string, number> = {}

    for (const key of dimKeys) {
      avgDimScores[key] = recent.reduce((sum, r) => sum + r.dimensions[key], 0) / recent.length
    }

    // Find the weakest dimension
    const sorted = Object.entries(avgDimScores).sort(([, a], [, b]) => a - b)
    const weakest = sorted[0]
    const targetDimension = weakest[1] < 50 ? weakest[0] : null

    return { targetDimension, avgDimScores, trend: this.getTrend() }
  }

  // ==================== 各维度评估 ====================

  /** 计划质量：步骤描述中是否包含实际文件引用 */
  private evaluatePlanQuality(planSteps: string[], planCreated: boolean): number {
    if (!planCreated) return 50
    if (planSteps.length === 0) return 30

    const fileRefPattern = /[\w-]+\.(ts|tsx|js|jsx|json|yaml|css|html|md)\b|[\w-]+\/[\w\-.\\/]+\.\w+/g
    let totalRefs = 0
    for (const step of planSteps) {
      const matches = step.match(fileRefPattern)
      totalRefs += matches ? matches.length : 0
    }

    if (totalRefs === 0) return 30
    if (totalRefs >= planSteps.length * 2) return 95
    return 60 + Math.round((totalRefs / (planSteps.length * 2)) * 35)
  }

  /** 分析多样性：与近期历史摘要的 Jaccard 相似度 */
  private evaluateDiversity(summary: string, recentHistory: string[]): number {
    const tokens = this.tokenize(summary)
    if (tokens.size === 0 || recentHistory.length === 0) return 70

    let maxOverlap = 0
    for (const h of recentHistory) {
      const hTokens = this.tokenize(h)
      const intersection = new Set([...tokens].filter((t) => hTokens.has(t)))
      const union = new Set([...tokens, ...hTokens])
      const jaccard = intersection.size / union.size
      maxOverlap = Math.max(maxOverlap, jaccard)
    }

    if (maxOverlap < 0.3) return 100
    if (maxOverlap < 0.5) return 60
    if (maxOverlap < 0.7) return 30
    return 10
  }

  /** 策略合规 */
  private evaluateStrategyCompliance(strategyName: string, promptMode: string, analysisMode: string, analysisSummary: string): number {
    const expectedPromptMode: Record<string, string> = {
      full: 'full',
      balanced: 'full',
      quick: 'minimal',
      review: 'minimal',
    }

    if (promptMode !== expectedPromptMode[strategyName]) return 60
    if (strategyName === 'review' && /write_file|edit_file|execute/.test(analysisSummary)) return 30
    return 95
  }

  /** 摘要长度：是否足够详细 */
  private evaluateSubstantiveLength(summary: string): number {
    const charLen = summary.length
    if (charLen < 50) return 10
    if (charLen < 200) return 40
    if (charLen < 500) return 70
    if (charLen < 1000) return 85
    return 95
  }

  // ==================== 工具 ====================

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((t) => t.length > 2 && t.length < 50),
    )
  }
}
