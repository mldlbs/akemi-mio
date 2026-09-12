import { log } from '@akemi-mio/core/logger/Logger'
import { WORKSPACE } from '@akemi-mio/core/config'
import { join, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

// ===== 策略配置 =====

export interface StrategyConfig {
  name: string
  description: string
  /** analysis prompt 模式 */
  promptMode: 'full' | 'balanced' | 'minimal'
  /** 分析超时基数 (ms) */
  timeoutMs: number
  /** 是否裁剪 prompt（仅 mission） */
  trimMode: boolean
  /** 历史摘要条目数 */
  maxHistoryEntries: number
  /** 安全模式 */
  safetyMode: 'review' | 'auto'
  /** 退化检测连续相同次数阈值 */
  degenerationThreshold: number
}

// ===== 策略评分（在循环结束时更新） =====

export interface StrategyScore {
  strategyName: string
  score: number
  samples: number
  avgSuccessRate: number
  avgExecutionMs: number
  lastUsed: number
  createdAt: number
}

// ===== 循环质量评估（供评分使用） =====

export interface CycleEvaluation {
  success: boolean
  durationMs: number
  planCreated: boolean
  stepsPlanned: number
  hadTimeout: boolean
  hadRetry: boolean
  promptTrimmed: boolean
}

// ===== 默认策略池 =====

const DEFAULT_STRATEGIES: StrategyConfig[] = [
  {
    name: 'full',
    description: '完整分析 — 用于首次运行或长期未进化',
    promptMode: 'full',
    timeoutMs: 180000,
    trimMode: false,
    maxHistoryEntries: 5,
    safetyMode: 'auto',
    degenerationThreshold: 3,
  },
  {
    name: 'balanced',
    description: '平衡模式 — 日常循环，在完整和快速之间折中',
    promptMode: 'full',
    timeoutMs: 120000,
    trimMode: false,
    maxHistoryEntries: 3,
    safetyMode: 'auto',
    degenerationThreshold: 3,
  },
  {
    name: 'quick',
    description: '快速扫描 — 仅 mission 上下文，限时短',
    promptMode: 'minimal',
    timeoutMs: 90000,
    trimMode: true,
    maxHistoryEntries: 2,
    safetyMode: 'auto',
    degenerationThreshold: 2,
  },
  {
    name: 'review',
    description: '仅审查 — 退化模式下只分析不执行',
    promptMode: 'minimal',
    timeoutMs: 60000,
    trimMode: true,
    maxHistoryEntries: 1,
    safetyMode: 'review',
    degenerationThreshold: 2,
  },
]

const DEFAULT_SCORE_PATH = join(WORKSPACE.evolution, 'strategy_scores.json')

// ===== 策略学习者 =====

export class EvolutionStrategyLearner {
  private scores = new Map<string, StrategyScore>()
  private strategies = new Map<string, StrategyConfig>()
  private cycleHistory: Array<{ strategy: string; eval: CycleEvaluation }> = []
  private scoreFilePath: string
  private persistenceDirty = false

  constructor(scoreFilePath?: string) {
    this.scoreFilePath = scoreFilePath || DEFAULT_SCORE_PATH
    this.loadScores()
    const now = Date.now()
    for (const s of DEFAULT_STRATEGIES) {
      this.strategies.set(s.name, s)
      if (!this.scores.has(s.name)) {
        this.scores.set(s.name, {
          strategyName: s.name,
          score: 70,
          samples: 0,
          avgSuccessRate: 0,
          avgExecutionMs: 0,
          lastUsed: 0,
          createdAt: now,
        })
      }
    }
  }

  /** 根据当前上下文选择最佳策略 */
  select(context: {
    consecutiveFailures: number
    isFirstRun: boolean
    isRecovering: boolean
    hoursSinceLastRun: number
    isDegenerate: boolean
  }): StrategyConfig {
    if (context.isDegenerate || context.consecutiveFailures >= 3) {
      return this.strategies.get('review')!
    }

    if (context.isFirstRun) {
      return this.strategies.get('full')!
    }

    if (context.isRecovering) {
      return this.consecutiveFailuresForContext(context) >= 2 ? this.strategies.get('review')! : this.strategies.get('quick')!
    }

    return this.selectByScore(context)
  }

  private consecutiveFailuresForContext(context: { consecutiveFailures: number }): number {
    return context.consecutiveFailures
  }

  /** 基于 epsilon-greedy bandit 选择策略 */
  private selectByScore(context: { consecutiveFailures: number; hoursSinceLastRun: number }): StrategyConfig {
    const candidates = ['balanced', 'quick', 'full']
      .map((name) => ({ name, config: this.strategies.get(name)!, score: this.scores.get(name)! }))
      .filter((s) => s.score.samples > 0)

    if (candidates.length === 0) {
      return this.strategies.get('balanced')!
    }

    // Epsilon-greedy: with probability ε pick a random strategy
    const totalSamples = candidates.reduce((sum, c) => sum + c.score.samples, 0)
    const epsilon = Math.max(0.1, 1 / Math.sqrt(totalSamples))
    const roll = Math.random()

    if (roll < epsilon) {
      // Exploration: random weighted by inverse score (favor trying less-used strategies)
      candidates.sort((a, b) => a.score.samples - b.score.samples)
      return candidates[0].config
    }

    // Exploitation: pick by score with context penalty
    const scored = candidates.map((c) => {
      let s = c.score.score
      if (context.consecutiveFailures > 0 && c.name === 'full') {
        s -= 20
      }
      return { ...c, adjustedScore: s }
    })

    scored.sort((a, b) => b.adjustedScore - a.adjustedScore)
    return scored[0].config
  }

  /** 循环结束后评分，更新策略分数 */
  evaluate(strategyName: string, evalResult: CycleEvaluation): void {
    const score = this.scores.get(strategyName)
    if (!score) return

    const successRate = evalResult.success ? 1 : 0
    const timeoutPenalty = evalResult.hadTimeout ? 0.3 : 0
    const retryPenalty = evalResult.hadRetry ? 0.1 : 0
    const planBonus = evalResult.planCreated ? 0.1 : 0
    const rawScore = (successRate * 0.5 + planBonus - timeoutPenalty - retryPenalty) * 100

    const alpha = score.samples === 0 ? 1 : 0.3
    const newScore = score.samples === 0 ? Math.max(0, Math.min(100, rawScore)) : score.score * (1 - alpha) + rawScore * alpha

    score.score = Math.max(0, Math.min(100, newScore))
    score.samples++
    score.avgSuccessRate = (score.avgSuccessRate * (score.samples - 1) + successRate) / score.samples
    score.avgExecutionMs = (score.avgExecutionMs * (score.samples - 1) + evalResult.durationMs) / score.samples
    score.lastUsed = Date.now()

    this.cycleHistory.push({ strategy: strategyName, eval: evalResult })
    if (this.cycleHistory.length > 50) {
      this.cycleHistory = this.cycleHistory.slice(-50)
    }

    log('INFO', 'strategy_evaluated', {
      strategy: strategyName,
      newScore: newScore.toFixed(1),
      samples: score.samples,
      avgSuccessRate: score.avgSuccessRate.toFixed(2),
    })

    this.persistenceDirty = true
    this.saveScores()
  }

  /** 用自我评估分数微调策略分 */
  applySelfEvaluation(strategyName: string, selfEvalScore: number): void {
    const score = this.scores.get(strategyName)
    if (!score || score.samples === 0) return
    const delta = selfEvalScore - score.score
    if (delta < -20) {
      score.score = Math.max(0, score.score + delta * 0.3)
    } else if (delta > 20 && score.samples > 5) {
      score.score = Math.min(100, score.score + delta * 0.1)
    }
    this.persistenceDirty = true
    this.saveScores()
  }

  /** 根据历史数据调优策略参数 */
  tuneParameters(): Array<{ strategy: string; parameter: string; oldValue: any; newValue: any; reason: string }> {
    const adjustments: Array<{ strategy: string; parameter: string; oldValue: any; newValue: any; reason: string }> = []

    for (const [name, config] of this.strategies) {
      const score = this.scores.get(name)
      if (!score || score.samples < 3) continue

      const originalConfig = DEFAULT_STRATEGIES.find((s) => s.name === name)
      if (!originalConfig) continue

      // 1. Timeout: target = avgExecutionMs * 2, clamped [30s, 300s]
      if (score.avgExecutionMs > 0) {
        const suggestedTimeout = Math.round(Math.max(30000, Math.min(300000, score.avgExecutionMs * 2)))
        if (Math.abs(suggestedTimeout - config.timeoutMs) > 10000) {
          adjustments.push({
            strategy: name,
            parameter: 'timeoutMs',
            oldValue: config.timeoutMs,
            newValue: suggestedTimeout,
            reason: `avg_exec=${Math.round(score.avgExecutionMs)}ms, target_2x=${suggestedTimeout}ms`,
          })
          config.timeoutMs = suggestedTimeout
        }
      }

      // 2. Trim mode: compare success rates
      const relevant = this.cycleHistory.filter((h) => h.strategy === name)
      if (relevant.length >= 5) {
        const trimmedOk = relevant.filter((h) => h.eval.promptTrimmed && h.eval.success).length
        const trimmedTotal = relevant.filter((h) => h.eval.promptTrimmed).length
        const notTrimmedOk = relevant.filter((h) => !h.eval.promptTrimmed && h.eval.success).length
        const notTrimmedTotal = relevant.filter((h) => !h.eval.promptTrimmed).length

        if (trimmedTotal >= 2 && notTrimmedTotal >= 2) {
          const trimRate = trimmedOk / trimmedTotal
          const notTrimRate = notTrimmedOk / notTrimmedTotal
          const newTrim = trimRate > notTrimRate
          if (newTrim !== config.trimMode) {
            adjustments.push({
              strategy: name,
              parameter: 'trimMode',
              oldValue: config.trimMode,
              newValue: newTrim,
              reason: `trim_sr=${(trimRate * 100).toFixed(0)}% vs notrim_sr=${(notTrimRate * 100).toFixed(0)}%`,
            })
            config.trimMode = newTrim
          }
        }
      }
    }

    if (adjustments.length > 0) {
      this.persistenceDirty = true
      this.saveScores()
    }
    return adjustments
  }

  // ==================== 持久化 ====================

  private loadScores(): void {
    try {
      if (!existsSync(this.scoreFilePath)) return
      const raw = JSON.parse(readFileSync(this.scoreFilePath, 'utf-8')) as Record<string, StrategyScore>
      for (const [name, s] of Object.entries(raw)) {
        // Load both default and mutated strategies
        if (DEFAULT_STRATEGIES.some((ds) => ds.name === name)) {
          this.scores.set(name, s)
        } else if (!this.scores.has(name)) {
          // Restore mutated strategy scores even if config not loaded yet
          this.scores.set(name, s)
          // If the strategy config was also persisted, it will be re-seeded by saveScores
        }
      }
    } catch {
      log('WARN', 'strategy_scores_load_failed')
    }
  }

  private saveScores(): void {
    if (!this.persistenceDirty) return
    try {
      const data: Record<string, StrategyScore> = {}
      for (const [name, s] of this.scores) {
        data[name] = s
      }
      const dir = dirname(this.scoreFilePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.scoreFilePath, JSON.stringify(data, null, 2), 'utf-8')
      this.persistenceDirty = false
    } catch {
      log('WARN', 'strategy_scores_save_failed')
    }
  }

  /** 元进化：从历史中挖掘最优策略窗口 */
  learn(): {
    recommendation?: string
    insight: string
    adjustments?: Array<{ strategy: string; parameter: string; oldValue: any; newValue: any; reason: string }>
    mutation?: MutationResult | null
  } {
    const adjustments = this.tuneParameters()
    const recent = this.cycleHistory.slice(-20)
    if (recent.length < 5) return { insight: '数据不足，继续收集', adjustments }

    // Attempt strategy mutation when enough data
    let mutation: MutationResult | null = null
    const nonDefaultCount = Array.from(this.strategies.values()).filter((s) => !DEFAULT_STRATEGIES.some((ds) => ds.name === s.name)).length
    if (this.cycleHistory.length > 10 && nonDefaultCount < 8) {
      mutation = this.getMutator().mutate(this.cycleHistory)
      if (mutation) {
        this.persistenceDirty = true
        this.saveScores()
        log('INFO', 'strategy_mutated', { parent: mutation.parent, child: mutation.child, op: mutation.operation })
      }
    }

    // Prune underperformers
    const pruned = this.getMutator().prune()
    if (pruned > 0) {
      this.persistenceDirty = true
      this.saveScores()
      log('INFO', 'strategy_pruned', { count: pruned })
    }

    const successRates = new Map<string, number[]>()
    for (const h of recent) {
      if (!successRates.has(h.strategy)) successRates.set(h.strategy, [])
      successRates.get(h.strategy)!.push(h.eval.success ? 1 : 0)
    }

    const insights: string[] = []
    for (const [name, rates] of successRates) {
      const avg = rates.reduce((a, b) => a + b, 0) / rates.length
      insights.push(`${name}: ${(avg * 100).toFixed(0)}%`)
    }

    const best = Array.from(this.scores.values()).sort((a, b) => b.score - a.score)[0]

    const adjSummary =
      adjustments.length > 0 ? ` | 参数调整: ${adjustments.map((a) => `${a.strategy}.${a.parameter}=${a.newValue}`).join(', ')}` : ''
    const mutationSummary = mutation ? ` | 变异: ${mutation.parent}→${mutation.child}(${mutation.operation})` : ''
    return {
      recommendation: best && best.samples > 2 ? best.strategyName : undefined,
      insight: `近期表现: ${insights.join(', ')}。${best ? `综合最优: ${best.strategyName}(${best.score.toFixed(0)}分, ${best.samples}次)` : ''}${adjSummary}${mutationSummary}`,
      adjustments,
      mutation,
    }
  }

  /** 获取策略变异器 */
  private _mutator: StrategyMutator | null = null
  getMutator(): StrategyMutator {
    if (!this._mutator) {
      this._mutator = new StrategyMutator(this.strategies, this.scores)
    }
    return this._mutator
  }

  /** 获取历史记录（供外部读取） */
  getCycleHistory(): Array<{ strategy: string; eval: CycleEvaluation }> {
    return this.cycleHistory
  }

  /** 获取格式化上下文，注入 evolution prompt */
  getFormattedContext(): string {
    if (this.scores.size === 0) return ''

    const parts = ['---', '【策略效能报告】']
    for (const [name, s] of this.scores) {
      if (s.samples === 0) continue
      parts.push(`- ${name}: ${s.score.toFixed(0)}分 | 成功率${(s.avgSuccessRate * 100).toFixed(0)}% | ${s.samples}次采样`)
    }
    const rec = this.learn()
    parts.push(rec.insight)
    parts.push('---')
    return parts.join('\n')
  }
}

// ===== 策略变异引擎（元进化） =====

export interface MutationResult {
  parent: string
  child: string
  childConfig: StrategyConfig
  operation: 'mutate' | 'crossover' | 'seed'
  reason: string
}

export class StrategyMutator {
  private strategies: Map<string, StrategyConfig>
  private scores: Map<string, StrategyScore>

  constructor(strategies: Map<string, StrategyConfig>, scores: Map<string, StrategyScore>) {
    this.strategies = strategies
    this.scores = scores
  }

  /** 尝试一次变异操作。targetDimension 可指定目标改进维度 */
  mutate(cycleHistory: Array<{ strategy: string; eval: CycleEvaluation }>, targetDimension?: string): MutationResult | null {
    const viable = this.getViableStrategies()
    if (viable.length === 0) return this.trySeed()

    if (viable.length >= 1 && Math.random() < 0.7) {
      return this.performMutation(viable, targetDimension)
    }
    if (viable.length >= 2) {
      return this.performCrossover(viable)
    }
    return null
  }

  /** 修剪低效策略 */
  prune(): number {
    const toRemove: string[] = []
    const maxAge = Date.now() - 50 * 24 * 60 * 60 * 1000

    for (const [name, score] of this.scores) {
      if (DEFAULT_STRATEGIES.some((ds) => ds.name === name)) continue // never prune defaults
      if (score.samples >= 3 && score.score < 40) toRemove.push(name)
      if (score.lastUsed > 0 && score.lastUsed < maxAge && score.samples < 3) toRemove.push(name)
    }

    for (const name of toRemove) {
      this.strategies.delete(name)
      this.scores.delete(name)
    }
    return toRemove.length
  }

  // ==================== 内部方法 ====================

  private getViableStrategies(): StrategyConfig[] {
    return Array.from(this.strategies.values()).filter(
      (s) => !DEFAULT_STRATEGIES.some((ds) => ds.name === s.name), // only mutate non-default
    )
  }

  private performMutation(viable: StrategyConfig[], targetDimension?: string): MutationResult {
    const parent = viable[Math.floor(Math.random() * viable.length)]
    const newName = `${parent.name}_mut_${Date.now().toString(36)}`
    const param = targetDimension ? this.pickTargetParam(targetDimension) : this.pickMutateParam()

    const child: StrategyConfig = {
      ...parent,
      name: newName,
      description: `变异自 ${parent.name}: ${param}`,
    }

    switch (param) {
      case 'timeoutMs': {
        const delta = Math.round(parent.timeoutMs * (0.8 + Math.random() * 0.4))
        child.timeoutMs = Math.max(30000, Math.min(300000, delta))
        break
      }
      case 'trimMode':
        child.trimMode = !parent.trimMode
        break
      case 'promptMode':
        child.promptMode = parent.promptMode === 'full' ? 'balanced' : parent.promptMode === 'balanced' ? 'minimal' : 'full'
        break
      case 'degenerationThreshold':
        child.degenerationThreshold = Math.max(1, Math.min(5, parent.degenerationThreshold + (Math.random() < 0.5 ? -1 : 1)))
        break
      case 'maxHistoryEntries':
        child.maxHistoryEntries = Math.max(1, Math.min(10, parent.maxHistoryEntries + (Math.random() < 0.5 ? -1 : 1)))
        break
    }

    this.strategies.set(child.name, child)
    this.scores.set(child.name, {
      strategyName: child.name,
      score: Math.max(10, (this.scores.get(parent.name)?.score || 50) - 15),
      samples: 0,
      avgSuccessRate: 0,
      avgExecutionMs: 0,
      lastUsed: 0,
      createdAt: Date.now(),
    })

    return { parent: parent.name, child: child.name, childConfig: child, operation: 'mutate', reason: param }
  }

  private pickMutateParam(): string {
    const params = ['timeoutMs', 'trimMode', 'promptMode', 'degenerationThreshold', 'maxHistoryEntries']
    return params[Math.floor(Math.random() * params.length)]
  }

  /** 目标维度 → 相关参数映射，70% 概率命中目标 */
  private pickTargetParam(targetDimension: string): string {
    const dimensionParamMap: Record<string, string[]> = {
      planQuality: ['promptMode', 'timeoutMs'],
      analysisDiversity: ['degenerationThreshold', 'maxHistoryEntries'],
      strategyCompliance: ['safetyMode', 'trimMode'],
      substantiveLength: ['timeoutMs', 'promptMode'],
    }
    const candidates = dimensionParamMap[targetDimension]
    if (!candidates || candidates.length === 0) return this.pickMutateParam()
    if (Math.random() < 0.7) {
      return candidates[Math.floor(Math.random() * candidates.length)]
    }
    return this.pickMutateParam()
  }

  private performCrossover(viable: StrategyConfig[]): MutationResult {
    const shuffled = [...viable].sort(() => Math.random() - 0.5)
    const [a, b] = [shuffled[0], shuffled[1]]
    const newName = `cross_${Date.now().toString(36)}`
    const aScore = this.scores.get(a.name)?.score || 50
    const bScore = this.scores.get(b.name)?.score || 50
    const better = aScore >= bScore ? a : b

    const child: StrategyConfig = {
      name: newName,
      description: `交叉 ${a.name} × ${b.name}`,
      promptMode: better.promptMode,
      timeoutMs: Math.round((a.timeoutMs + b.timeoutMs) / 2),
      trimMode: better.trimMode,
      maxHistoryEntries: Math.round((a.maxHistoryEntries + b.maxHistoryEntries) / 2),
      safetyMode: better.safetyMode,
      degenerationThreshold: Math.round((a.degenerationThreshold + b.degenerationThreshold) / 2),
    }

    this.strategies.set(child.name, child)
    this.scores.set(child.name, {
      strategyName: child.name,
      score: Math.round((aScore + bScore) / 2) - 10,
      samples: 0,
      avgSuccessRate: 0,
      avgExecutionMs: 0,
      lastUsed: 0,
      createdAt: Date.now(),
    })

    return {
      parent: `${a.name}+${b.name}`,
      child: child.name,
      childConfig: child,
      operation: 'crossover',
      reason: `avg_score=${Math.round((aScore + bScore) / 2)}`,
    }
  }

  private trySeed(): MutationResult | null {
    const existing = new Set(this.strategies.keys())
    const missing = DEFAULT_STRATEGIES.filter((ds) => !existing.has(ds.name))
    if (missing.length === 0) return null

    const seed = missing[0]
    this.strategies.set(seed.name, seed)
    this.scores.set(seed.name, {
      strategyName: seed.name,
      score: 70,
      samples: 0,
      avgSuccessRate: 0,
      avgExecutionMs: 0,
      lastUsed: 0,
      createdAt: Date.now(),
    })

    return { parent: '(default)', child: seed.name, childConfig: seed, operation: 'seed', reason: 'replenish_pool' }
  }
}
