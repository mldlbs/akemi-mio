/**
 * EvolutionDecider — 方向选择器（Phase 5）
 *
 * 在三角约束下选择当前 cycle 的进化方向：
 * - expand:   扩展现有能力边界（vertical 更深 / horizontal 更广 / compression 更少步骤）
 * - optimize: 优化已有能力的效率（更快、更便宜、更稳定）
 * - preserve: 不做变更，仅执行 preservation 检查
 */

import { log } from '../logger/Logger'
import type { Capability } from '../CapabilityRegistry'
import type { PatternCandidate } from '../PatternMiner'

// —── Types ──────────────────────────────────────────────

export type EvolutionDirection = 'expand' | 'optimize' | 'preserve'
export type ExpandMode = 'vertical' | 'horizontal' | 'compression'

export interface DirectionDecision {
  direction: EvolutionDirection
  expandMode?: ExpandMode
  reason: string
  confidence: number // 0-1
  /** 建议注入到分析 prompt 的上下文 */
  contextHint?: string
}

export interface DeciderInput {
  /** 上次 cycle 的 pattern 挖掘结果 */
  patterns: PatternCandidate[]
  /** 注册表中的所有能力 */
  capabilities: Capability[]
  /** 连续失败次数 */
  consecutiveFailures: number
  /** 当前 cycle 是否被标记为退化 */
  isDegenerate: boolean
  /** 自评估趋势 */
  selfEvalTrend?: 'upward' | 'stable' | 'stagnant' | 'downward'
  /** 是否刚完成 preserve 动作 */
  afterPreservation?: boolean
}

// —── EvolutionDecider ──────────────────────────────────

export class EvolutionDecider {
  private lastDecision: DirectionDecision | null = null
  private expandCooldownUntil = 0
  private preserveCount = 0
  private optimizeCount = 0

  /** 根据输入决定进化方向 */
  decide(input: DeciderInput): DirectionDecision {
    // 1. 降级/失败率过高 → preserve
    if (input.isDegenerate || input.consecutiveFailures >= 2) {
      log('INFO', 'evolution_decider_preserve_degraded', {
        degenerate: input.isDegenerate,
        failures: input.consecutiveFailures,
      })
      return this.makeDecision('preserve', '系统退化/失败中，进入保护模式')
    }

    // 2. 自评估持续下行 → preserve
    if (input.selfEvalTrend === 'downward' && input.consecutiveFailures > 0) {
      return this.makeDecision('preserve', '自评估下行且存在失败，保护优先')
    }

    // 3. expand 冷却（同一方向不要连续超过 2 次）
    if (this.expandCooldownUntil > Date.now()) {
      if (this.optimizeCount < 2) {
        return this.makeDecision('optimize', 'expand 冷却中，切到优化')
      }
      return this.makeDecision('preserve', 'expand 冷却中，优化已执行，进入保护')
    }

    // 4. 检查 expand 触发条件
    const expandDecision = this.checkExpandTriggers(input)
    if (expandDecision) {
      this.expandCooldownUntil = Date.now() + 2 * 60 * 60 * 1000 // 2h 冷却
      this.optimizeCount = 0
      return expandDecision
    }

    // 5. 检查 optimize 触发条件
    if (this.shouldOptimize(input)) {
      this.optimizeCount++
      return this.makeDecision('optimize', '有可优化的能力')
    }

    // 6. 默认 preserve
    this.preserveCount++
    return this.makeDecision('preserve', '无触发条件，执行常规保护')
  }

  /** 重置状态 */
  reset(): void {
    this.lastDecision = null
    this.expandCooldownUntil = 0
    this.preserveCount = 0
    this.optimizeCount = 0
  }

  /** 获取上次决策 */
  getLastDecision(): DirectionDecision | null {
    return this.lastDecision
  }

  // —── 内部方法 ─────────────────────────────────────

  private checkExpandTriggers(input: DeciderInput): DirectionDecision | null {
    const { patterns, capabilities } = input

    // 触发条件 1: 同一 workflow 重复出现 ≥3 次 → horizontal（扩到新领域）
    const frequentChains = patterns.filter((p) => p.type === 'frequent_chain' && p.frequency >= 3)
    if (frequentChains.length > 0) {
      // 检查能力集中是否已有类似模式
      const existing = capabilities.some((c) => frequentChains.some((fc) => fc.toolChain.some((t) => c.executor.body.includes(t))))
      const best = frequentChains.reduce((a, b) => (a.frequency > b.frequency ? a : b))
      if (!existing) {
        return this.makeDecision(
          'expand',
          `高频工具链 "${best.toolChain.slice(0, 3).join('→')}" 出现 ${best.frequency} 次，扩展新能力`,
          'horizontal',
          `【进化方向】系统检测到高频工具链模式，建议关注 "${best.toolChain.slice(0, 3).join('→')}" 相关能力的扩展`,
        )
      }
      return this.makeDecision('expand', `高频工具链 "${best.toolChain.slice(0, 3).join('→')}" 已存在，尝试更深优化`, 'vertical')
    }

    // 触发条件 2: 某类操作 cost 占总 budget 30%+ → compression（压缩成本）
    const highCostChains = patterns.filter((p) => p.type === 'high_cost_chain')
    if (highCostChains.length > 0) {
      const avgCost = highCostChains.reduce((s, c) => s + c.avgTokenCost, 0) / highCostChains.length
      if (avgCost > 500) {
        return this.makeDecision(
          'expand',
          `高成本链 ${highCostChains.length} 条 (avg ${avgCost} tokens)，尝试压缩`,
          'compression',
          `【进化方向】检测到高 token 消耗模式，建议压缩冗余步骤以降低成本`,
        )
      }
    }

    // 触发条件 3: 某类错误修复模式出现 ≥2 次 → vertical
    const failureRecoveries = patterns.filter((p) => p.type === 'failure_recovery')
    if (failureRecoveries.length >= 2) {
      return this.makeDecision(
        'expand',
        `错误修复模式 ${failureRecoveries.length} 次，深入优化稳定性`,
        'vertical',
        `【进化方向】重复错误模式检测，建议深挖根因并添加防御性检查`,
      )
    }

    return null
  }

  private shouldOptimize(input: DeciderInput): boolean {
    // 有高成本 chain 但不够触发 expand → optimize
    const highCost = input.patterns.filter((p) => p.type === 'high_cost_chain')
    if (highCost.length > 0) return true

    // 有失败恢复模式 → optimize
    const failures = input.patterns.filter((p) => p.type === 'failure_recovery')
    if (failures.length > 0) return true

    return false
  }

  private makeDecision(direction: EvolutionDirection, reason: string, expandMode?: ExpandMode, contextHint?: string): DirectionDecision {
    const decision: DirectionDecision = {
      direction,
      reason,
      expandMode,
      confidence: direction === 'preserve' ? 0.8 : 0.6,
      contextHint,
    }
    this.lastDecision = decision
    log('INFO', 'evolution_decider', {
      direction,
      expandMode,
      reason,
    })
    return decision
  }
}
