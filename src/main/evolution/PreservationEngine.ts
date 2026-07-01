/**
 * PreservationEngine — 能力保护引擎（Phase 4）
 *
 * 9 维能力保护策略（CPP）编排器：
 * 评估每个能力在所有维度上的健康度，产出 preservation score，
 * 并根据分数执行 archive / degrade / block 动作。
 *
 * 权重配置（总和 1.0）：
 *   质量组：D1 编译 0.10 + D2 测试 0.15 + D3 使用 0.10  = 0.35
 *   行为组：D4 延迟 0.10 + D5 成本 0.10 + D6 回归 0.15  = 0.35
 *   安全组：D7 污染 0.15 + D8 依赖 0.075 + D9 前置 0.075 = 0.30
 */

import { log } from '../logger/Logger'
import type { Capability } from './CapabilityRegistry'
import { BehavioralRegressor, type RegressorResult } from './cpp/BehavioralRegressor'
import { ContaminationDetector, type ContaminationResult } from './cpp/ContaminationDetector'
import { CapabilityGC, type GCResult } from './CapabilityGC'

// —── Types ──────────────────────────────────────────────

export interface DimensionResult {
  dimension: number
  name: string
  passed: boolean
  score: number
  detail: string
}

export type RecommendedAction = 'keep' | 'degrade' | 'archive' | 'block'

export interface PreservationReport {
  capabilityId: string
  overallScore: number
  dimensions: DimensionResult[]
  recommendedAction: RecommendedAction
  timestamp: number
}

export interface PreservationSummary {
  total: number
  passed: number
  failed: number
  actions: {
    archived: number
    degraded: number
    blocked: number
  }
  avgScore: number
  timestamp: number
}

// —── PreservationEngine ─────────────────────────────────

export class PreservationEngine {
  private registry: {
    get: (id: string) => Capability | undefined
    list: (tier?: 'core' | 'derived' | 'experimental') => Capability[]
    register: (cap: Capability) => void
    remove: (id: string) => boolean
    archiveUnused: () => number
    degradeLowSuccess: (threshold?: number) => number
  }
  private regressor: BehavioralRegressor
  private contaminationDetector: ContaminationDetector
  private gc: CapabilityGC

  private weights: number[]

  constructor(registry: {
    get: (id: string) => Capability | undefined
    list: (tier?: 'core' | 'derived' | 'experimental') => Capability[]
    register: (cap: Capability) => void
    remove: (id: string) => boolean
    archiveUnused: () => number
    degradeLowSuccess: (threshold?: number) => number
  }) {
    this.registry = registry
    this.regressor = new BehavioralRegressor()
    this.contaminationDetector = new ContaminationDetector()
    this.gc = new CapabilityGC(registry)
    this.weights = this.defaultWeights()
  }

  // ==================== 公开 API ====================

  /** 评估单个能力 */
  evaluate(capability: Capability): PreservationReport {
    const dims = this.evaluateAllDimensions(capability)
    const overallScore = this.computeScore(dims)
    const recommendedAction = this.determineAction(capability, overallScore, dims)

    log('INFO', 'preservation_evaluate', {
      id: capability.id,
      score: overallScore.toFixed(2),
      action: recommendedAction,
      dims: dims
        .filter((d) => !d.passed)
        .map((d) => `D${d.dimension}`)
        .join(','),
    })

    return {
      capabilityId: capability.id,
      overallScore: Math.round(overallScore * 100) / 100,
      dimensions: dims,
      recommendedAction,
      timestamp: Date.now(),
    }
  }

  /** 评估所有能力 */
  evaluateAll(): PreservationSummary {
    const all = this.registry.list()
    if (all.length === 0) {
      return { total: 0, passed: 0, failed: 0, actions: { archived: 0, degraded: 0, blocked: 0 }, avgScore: 0, timestamp: Date.now() }
    }

    let passedCount = 0
    let totalScore = 0
    let archived = 0
    let degraded = 0
    let blocked = 0

    for (const cap of all) {
      const report = this.evaluate(cap)
      totalScore += report.overallScore
      if (report.overallScore >= 0.6) passedCount++
      if (report.recommendedAction === 'archive') archived++
      else if (report.recommendedAction === 'degrade') degraded++
      else if (report.recommendedAction === 'block') blocked++
    }

    return {
      total: all.length,
      passed: passedCount,
      failed: all.length - passedCount,
      actions: { archived, degraded, blocked },
      avgScore: Math.round((totalScore / all.length) * 100) / 100,
      timestamp: Date.now(),
    }
  }

  /** 执行推荐动作（归档/降级/屏蔽） */
  prune(): number {
    let count = 0
    const all = this.registry.list()
    for (const cap of all) {
      if (cap.tier === 'core') continue
      const report = this.evaluate(cap)
      switch (report.recommendedAction) {
        case 'archive':
          this.registry.remove(cap.id)
          log('INFO', 'preservation_pruned_archived', { id: cap.id, score: report.overallScore })
          count++
          break
        case 'degrade': {
          const updated = { ...cap, tier: 'experimental' as const, updatedAt: Date.now() }
          this.registry.register(updated)
          log('INFO', 'preservation_pruned_degraded', { id: cap.id, score: report.overallScore })
          count++
          break
        }
        case 'block':
          this.registry.remove(cap.id)
          log('WARN', 'preservation_pruned_blocked', { id: cap.id, score: report.overallScore })
          count++
          break
        default:
          break
      }
    }
    // 额外 GC 清理
    const gcResult = this.gc.collect()
    if (gcResult.archived > 0 || gcResult.degraded > 0) {
      log('INFO', 'preservation_gc_complement', { archived: gcResult.archived, degraded: gcResult.degraded })
      count += gcResult.archived + gcResult.degraded
    }
    return count
  }

  // ==================== 9 维评估器 ====================

  private evaluateAllDimensions(cap: Capability): DimensionResult[] {
    return [
      this.evaluateCompilation(cap),
      this.evaluateTests(cap),
      this.evaluateUsage(cap),
      this.evaluateLatency(cap),
      this.evaluateCost(cap),
      this.evaluateBehavioralRegression(cap),
      this.evaluateContamination(cap),
      this.evaluateDependencies(cap),
      this.evaluatePreconditions(cap),
    ]
  }

  /** D1: 编译/类型安全 */
  private evaluateCompilation(cap: Capability): DimensionResult {
    if (cap.executor.type === 'toolchain') {
      const tools = cap.executor.body
        .split('→')
        .map((s) => s.trim())
        .filter(Boolean)
      if (tools.length === 0) {
        return { dimension: 1, name: 'compilation', passed: false, score: 0, detail: '空工具链' }
      }
      return { dimension: 1, name: 'compilation', passed: true, score: 1, detail: `工具链格式有效 (${tools.length} 步)` }
    }
    try {
      JSON.parse(cap.executor.body)
      return { dimension: 1, name: 'compilation', passed: true, score: 1, detail: 'body 解析通过' }
    } catch {
      return { dimension: 1, name: 'compilation', passed: false, score: 0, detail: 'body 不是有效 JSON' }
    }
  }

  /** D2: 测试通过率 */
  private evaluateTests(cap: Capability): DimensionResult {
    const rate = cap.metrics.successRate
    const passed = rate >= 0.7
    return {
      dimension: 2,
      name: 'tests',
      passed,
      score: rate,
      detail: passed ? `通过率 ${(rate * 100).toFixed(0)}%` : `通过率 ${(rate * 100).toFixed(0)}% < 70%`,
    }
  }

  /** D3: 使用热度 / 冷度 */
  private evaluateUsage(cap: Capability): DimensionResult {
    const now = Date.now()
    const daysSinceLastUse =
      cap.lastUsedAt > 0 ? (now - cap.lastUsedAt) / (1000 * 60 * 60 * 24) : (now - cap.createdAt) / (1000 * 60 * 60 * 24)
    const staleness = Math.min(1, Math.max(0, daysSinceLastUse / 30))
    const coldness =
      staleness * 0.4 +
      (1 - cap.metrics.successRate) * 0.3 +
      Math.min(1, cap.metrics.cost / 1000) * 0.2 -
      Math.min(1, cap.dependencies.length * 0.15) * 0.1
    const score = Math.max(0, Math.min(1, 1 - coldness))
    const passed = coldness < 0.45
    return {
      dimension: 3,
      name: 'usage',
      passed,
      score,
      detail: passed ? `冷度 ${coldness.toFixed(2)}，正常` : `冷度 ${coldness.toFixed(2)} > 0.45，需要关注`,
    }
  }

  /** D4: 延迟效率 */
  private evaluateLatency(cap: Capability): DimensionResult {
    const thresholds: Record<string, number> = { core: 5000, derived: 10000, experimental: 30000 }
    const threshold = thresholds[cap.tier] || 30000
    const latency = cap.metrics.latency
    const score = Math.max(0, Math.min(1, 1 - latency / threshold))
    const passed = score >= 0.3
    return {
      dimension: 4,
      name: 'latency',
      passed,
      score,
      detail: passed ? `延迟 ${latency}ms < ${threshold}ms (${cap.tier} 阈值)` : `延迟 ${latency}ms > ${threshold}ms (${cap.tier} 阈值)`,
    }
  }

  /** D5: 成本效率 */
  private evaluateCost(cap: Capability): DimensionResult {
    const costEfficiency = cap.metrics.cost > 0 ? cap.metrics.successRate / cap.metrics.cost : 1
    const score = Math.min(1, Math.max(0, costEfficiency * 100))
    const passed = score >= 0.3
    return {
      dimension: 5,
      name: 'cost',
      passed,
      score,
      detail: passed ? `成本效率 ${(score * 100).toFixed(0)}%` : `成本效率 ${(score * 100).toFixed(0)}% < 30%`,
    }
  }

  /** D6: 行为回归（委托给 BehavioralRegressor） */
  private evaluateBehavioralRegression(cap: Capability): DimensionResult {
    const result: RegressorResult = this.regressor.evaluate(cap)
    return {
      dimension: 6,
      name: 'regression',
      passed: result.passed,
      score: 1 - result.shift,
      detail: result.detail,
    }
  }

  /** D7: 污染检测（委托给 ContaminationDetector） */
  private evaluateContamination(cap: Capability): DimensionResult {
    const result: ContaminationResult = this.contaminationDetector.evaluate(cap)
    return {
      dimension: 7,
      name: 'contamination',
      passed: result.passed,
      score: result.risk === 'low' ? 1 : result.risk === 'medium' ? 0.7 : 0.3,
      detail: result.detail,
    }
  }

  /** D8: 依赖完整性 */
  private evaluateDependencies(cap: Capability): DimensionResult {
    if (cap.dependencies.length === 0) {
      return { dimension: 8, name: 'dependencies', passed: true, score: 1, detail: '无依赖声明' }
    }
    let healthy = 0
    for (const depId of cap.dependencies) {
      const dep = this.registry.get(depId)
      if (dep && dep.metrics.successRate >= 0.4) healthy++
    }
    const ratio = healthy / cap.dependencies.length
    const passed = ratio >= 0.8
    return {
      dimension: 8,
      name: 'dependencies',
      passed,
      score: ratio,
      detail: passed ? `依赖健康 ${healthy}/${cap.dependencies.length}` : `依赖失效 ${cap.dependencies.length - healthy} 个`,
    }
  }

  /** D9: 前置条件有效性 */
  private evaluatePreconditions(cap: Capability): DimensionResult {
    if (cap.preconditions.length === 0) {
      return { dimension: 9, name: 'preconditions', passed: true, score: 1, detail: '无前置条件' }
    }
    let valid = 0
    for (const cond of cap.preconditions) {
      // 检查前置条件是否引用已存在的能力
      const matched = this.registry.list().some((c) => cond.includes(c.id) || c.intent.includes(cond))
      if (matched) valid++
    }
    const ratio = valid / cap.preconditions.length
    const passed = ratio >= 0.8
    return {
      dimension: 9,
      name: 'preconditions',
      passed,
      score: ratio,
      detail: passed ? `前置条件有效 ${valid}/${cap.preconditions.length}` : `前置条件失效 ${cap.preconditions.length - valid} 个`,
    }
  }

  // ==================== 决策逻辑 ====================

  private computeScore(dimensions: DimensionResult[]): number {
    if (dimensions.length !== this.weights.length) return 0
    let total = 0
    for (let i = 0; i < dimensions.length; i++) {
      total += dimensions[i].score * this.weights[i]
    }
    return total
  }

  private determineAction(cap: Capability, score: number, dims: DimensionResult[]): RecommendedAction {
    const failedDims = dims.filter((d) => !d.passed).map((d) => d.dimension)
    const failedContamination = failedDims.includes(7)

    // 污染失败且不是 core → 直接屏蔽
    if (failedContamination && cap.tier !== 'core') return 'block'

    if (score >= 0.6) return 'keep'
    if (score >= 0.35) return 'degrade'
    return 'archive'
  }

  private defaultWeights(): number[] {
    return [0.1, 0.15, 0.1, 0.1, 0.1, 0.15, 0.15, 0.075, 0.075]
  }
}
