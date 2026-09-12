/**
 * MetaLearner — 跨周期变异效果学习引擎（元进化核心）。
 *
 * 职责：
 * 1. 记录每次变异操作及其后续分数变化
 * 2. 学习哪些参数变更在哪些上下文中有效
 * 3. 自适应选择变异策略（而非随机碰运气）
 * 4. 周期性输出元学习报告
 *
 * 这是 EvolutionSelfEvaluator + StrategyMutator 之上的元学习层，
 * 使系统能够"学习如何进化"而非"继续随机变异"。
 */

import { log } from '@akemi-mio/core/logger/Logger'

interface MutationOp {
  /** 变异类型：参数改变 */
  paramName: string
  oldValue: unknown
  newValue: unknown
}

interface TrackedMutation {
  id: string
  parentStrategy: string
  childStrategy: string
  ops: MutationOp[]
  operation: 'mutate' | 'crossover' | 'seed'
  createdAt: number
  outcome?: {
    /** 变异后的平均分数 vs 父策略基线分 */
    scoreDelta: number
    /** 采样次数 */
    samples: number
    /** 子策略是否优于父策略 */
    improvement: boolean
  }
}

interface ParamEffectiveness {
  paramName: string
  attempts: number
  improvements: number
  avgDelta: number
  /** 是否达到可信样本阈值 */
  reliable: boolean
}

export interface MetaLearningResult {
  recommendation: string | null
  insight: string
  details: {
    activeMutations: number
    trackedOps: number
    bestParam: string
    worstParam: string
    bestEffectiveness: number
    worstEffectiveness: number
  }
}

export class MetaLearner {
  private mutations: TrackedMutation[] = []
  private readonly maxTracked = 100
  private cycleCount = 0

  /** 记录一次变异操作 */
  recordMutation(params: {
    parentStrategy: string
    childStrategy: string
    paramName: string
    oldValue: unknown
    newValue: unknown
    operation: 'mutate' | 'crossover' | 'seed'
  }): string {
    const id = `meta_${Date.now().toString(36)}_${this.mutations.length}`
    const tm: TrackedMutation = {
      id,
      parentStrategy: params.parentStrategy,
      childStrategy: params.childStrategy,
      ops: [{ paramName: params.paramName, oldValue: params.oldValue, newValue: params.newValue }],
      operation: params.operation,
      createdAt: Date.now(),
    }
    this.mutations.push(tm)
    if (this.mutations.length > this.maxTracked) {
      this.mutations = this.mutations.slice(-this.maxTracked)
    }
    log('INFO', 'meta_mutation_tracked', {
      id,
      parent: params.parentStrategy,
      child: params.childStrategy,
      param: params.paramName,
      op: params.operation,
    })
    return id
  }

  /** 记录子策略的 outcome 分数 */
  recordOutcome(mutationId: string, parentScore: number, childScore: number, childSamples: number): void {
    const m = this.mutations.find((m) => m.id === mutationId)
    if (!m) return
    m.outcome = {
      scoreDelta: childScore - parentScore,
      samples: childSamples,
      improvement: childScore > parentScore + 5, // >5 分才算改善
    }
  }

  /** 获取各参数维度的有效性统计 */
  getParamEffectiveness(): ParamEffectiveness[] {
    const byParam = new Map<string, { deltas: number[]; improvements: number }>()

    for (const m of this.mutations) {
      if (!m.outcome) continue
      for (const op of m.ops) {
        if (!byParam.has(op.paramName)) byParam.set(op.paramName, { deltas: [], improvements: 0 })
        const entry = byParam.get(op.paramName)!
        entry.deltas.push(m.outcome.scoreDelta)
        if (m.outcome.improvement) entry.improvements++
      }
    }

    return Array.from(byParam.entries())
      .map(([paramName, data]) => {
        const attempts = data.deltas.length
        const avgDelta = attempts > 0 ? data.deltas.reduce((a, b) => a + b, 0) / attempts : 0
        return {
          paramName,
          attempts,
          improvements: data.improvements,
          avgDelta: Math.round(avgDelta * 10) / 10,
          reliable: attempts >= 3,
        }
      })
      .sort((a, b) => b.avgDelta - a.avgDelta)
  }

  /** 根据历史效果推荐变异参数 */
  recommendMutationParam(context?: { strategyName: string; currentScore: number }): { paramName: string | null; insight: string } {
    const effectiveness = this.getParamEffectiveness()
    const reliable = effectiveness.filter((e) => e.reliable)

    if (reliable.length === 0) {
      // 数据不足：探索（优先选尝试次数最少的）
      const candidates = ['timeoutMs', 'promptMode', 'trimMode', 'degenerationThreshold', 'maxHistoryEntries']
      const untried = candidates.filter((c) => !effectiveness.some((e) => e.paramName === c))
      if (untried.length > 0) {
        return { paramName: untried[0], insight: `探索未尝试的参数: ${untried[0]}` }
      }
      const leastTried = effectiveness.sort((a, b) => a.attempts - b.attempts)[0]
      return { paramName: leastTried?.paramName || null, insight: `数据不足，选实验最少的参数: ${leastTried?.paramName}` }
    }

    // exploitation: 选效果最佳的参数
    const best = reliable[0]
    const improvementRate = best.attempts > 0 ? Math.round((best.improvements / best.attempts) * 100) : 0
    return {
      paramName: best.paramName,
      insight: `元学习推荐: ${best.paramName} (${improvementRate}% 改善率, avgΔ=${best.avgDelta > 0 ? '+' : ''}${best.avgDelta}, ${best.attempts}次采样)`,
    }
  }

  /** 判断当前是否应当抑制变异（效果太差或数据不足时停止浪费） */
  shouldSuppressMutation(): boolean {
    const effectiveness = this.getParamEffectiveness()
    const reliable = effectiveness.filter((e) => e.reliable)

    // 至少有 3 个可靠数据且所有可靠参数平均效果为负 → 抑制
    if (reliable.length >= 3) {
      const allNegative = reliable.every((e) => e.avgDelta < -2)
      if (allNegative) {
        log('WARN', 'meta_suppress_mutation', {
          reason: '所有可靠参数变均为负效果',
          details: reliable.map((r) => `${r.paramName}:${r.avgDelta}`).join(','),
        })
        return true
      }
    }

    // 最近 10 次变异无改善 → 抑制
    const recent = this.mutations.slice(-10).filter((m) => m.outcome !== undefined)
    if (recent.length >= 5) {
      const improved = recent.filter((m) => m.outcome!.improvement).length
      if (improved === 0) {
        log('WARN', 'meta_suppress_mutation', {
          reason: `最近 ${recent.length} 次变异均未改善`,
        })
        return true
      }
    }

    return false
  }

  /** 每 N 个周期输出一次元学习总结 */
  getMetaSummary(): MetaLearningResult | null {
    const completed = this.mutations.filter((m) => m.outcome !== undefined)
    if (completed.length < 3) return null

    const effectiveness = this.getParamEffectiveness()
    const best = effectiveness[0]
    const worst = effectiveness[effectiveness.length - 1]

    const improved = completed.filter((m) => m.outcome!.improvement).length
    const improveRate = Math.round((improved / completed.length) * 100)

    return {
      recommendation: best?.paramName || null,
      insight:
        `变异改善率 ${improveRate}% (${improved}/${completed.length}) | ` +
        `最优参数: ${best?.paramName || '-'} (avgΔ=${best?.avgDelta > 0 ? '+' : ''}${best?.avgDelta}) | ` +
        `最差参数: ${worst?.paramName || '-'} (avgΔ=${worst?.avgDelta > 0 ? '+' : ''}${worst?.avgDelta})`,
      details: {
        activeMutations: this.mutations.length,
        trackedOps: this.mutations.flatMap((m) => m.ops).length,
        bestParam: best?.paramName || '',
        worstParam: worst?.paramName || '',
        bestEffectiveness: best?.avgDelta ?? 0,
        worstEffectiveness: worst?.avgDelta ?? 0,
      },
    }
  }

  /** 每周期增长 */
  incrementCycle(): void {
    this.cycleCount++
  }

  getCycleCount(): number {
    return this.cycleCount
  }

  /** 诊断快照 */
  getDiagnostics(): Record<string, unknown> {
    return {
      trackedMutations: this.mutations.length,
      completedMutations: this.mutations.filter((m) => m.outcome !== undefined).length,
      cycleCount: this.cycleCount,
      paramEffectiveness: this.getParamEffectiveness(),
      suppressMutation: this.shouldSuppressMutation(),
    }
  }
}
