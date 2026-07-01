/**
 * EvolutionController — 三角决策引擎（Phase 5）
 *
 * 在 expand / optimize / preserve 三个方向间动态决策。
 * 取代部分 strategizer.select() 的逻辑，但并不替代整个流水线。
 *
 * 职责：
 * 1. 用 EvolutionDecider 选择每个 cycle 的方向
 * 2. 根据方向调整分析输入（注入 context hint）
 * 3. 跟踪方向转换历史，防止震荡
 * 4. 暴露 self-check 接口给外部（SelfEvolutionService 调用）
 */

import { log } from '../logger/Logger'
import { EvolutionDecider, type DirectionDecision, type DeciderInput, type EvolutionDirection, type ExpandMode } from './EvolutionDecider'
import type { PatternCandidate } from './PatternMiner'
import type { Capability } from './CapabilityRegistry'

// —── Types ──────────────────────────────────────────────

export interface ControllerState {
  currentDirection: EvolutionDirection
  currentExpandMode?: ExpandMode
  directionHistory: Array<{ direction: EvolutionDirection; timestamp: number; reason: string }>
  lastDecision: DirectionDecision | null
  totalCycles: number
  expandCount: number
  optimizeCount: number
  preserveCount: number
}

// —── EvolutionController ───────────────────────────────

export class EvolutionController {
  readonly decider: EvolutionDecider

  private state: ControllerState

  constructor() {
    this.decider = new EvolutionDecider()
    this.state = this.freshState()
  }

  /** 执行一个决策周期（在每次 runAnalysisCycle 开始时调用） */
  decide(input: {
    patterns: PatternCandidate[]
    capabilities: Capability[]
    consecutiveFailures: number
    isDegenerate: boolean
    selfEvalTrend?: 'upward' | 'stable' | 'stagnant' | 'downward'
    afterPreservation?: boolean
  }): DirectionDecision {
    const deciderInput: DeciderInput = {
      patterns: input.patterns,
      capabilities: input.capabilities,
      consecutiveFailures: input.consecutiveFailures,
      isDegenerate: input.isDegenerate,
      selfEvalTrend: input.selfEvalTrend,
      afterPreservation: input.afterPreservation,
    }

    const decision = this.decider.decide(deciderInput)
    this.recordDecision(decision)
    return decision
  }

  /** 获取控制器当前状态 */
  getState(): ControllerState {
    return { ...this.state }
  }

  /** 重置控制器（新 epoch 开始时） */
  reset(): void {
    this.decider.reset()
    this.state = this.freshState()
    log('INFO', 'evolution_controller_reset')
  }

  /** 健康检查 */
  isHealthy(): boolean {
    const recent = this.state.directionHistory.slice(-5)
    const unique = new Set(recent.map((d) => d.direction))
    // 如果最近 5 次全是同一个方向且 preserve 占多数 → 停滞
    if (unique.size === 1 && recent[0]?.direction === 'preserve' && recent.length >= 5) {
      return false
    }
    // 如果最近 10 次中有 8+ 次 preserve → 可能停滞
    if (this.state.directionHistory.length >= 10) {
      const last10 = this.state.directionHistory.slice(-10)
      const preserveRatio = last10.filter((d) => d.direction === 'preserve').length / 10
      if (preserveRatio >= 0.8) return false
    }
    return true
  }

  /** 获取可注入到分析 prompt 的进化上下文 */
  getContextHint(): string | undefined {
    const decision = this.decider.getLastDecision()
    if (!decision) return undefined

    const parts = [`当前方向: ${this.directionLabel(decision)}`]
    parts.push(`置信度: ${(decision.confidence * 100).toFixed(0)}%`)
    if (decision.contextHint) {
      parts.push(decision.contextHint)
    } else {
      parts.push(`原因: ${decision.reason}`)
    }
    return parts.join('\n')
  }

  /** 生成文本摘要 */
  getFormattedContext(): string {
    const s = this.state
    const lines = [
      '=== EvolutionController 状态 ===',
      `方向: ${s.currentDirection}${s.currentExpandMode ? ` (${s.currentExpandMode})` : ''}`,
      `总周期: ${s.totalCycles} | E:${s.expandCount} O:${s.optimizeCount} P:${s.preserveCount}`,
      `健康: ${this.isHealthy() ? '正常' : '停滞'}`,
      `最近决策: ${s.directionHistory
        .slice(-3)
        .map((d) => `${d.direction}(${d.reason.slice(0, 20)})`)
        .join(' → ')}`,
    ]
    return lines.join('\n')
  }

  // —── 内部方法 ─────────────────────────────────────

  private freshState(): ControllerState {
    return {
      currentDirection: 'preserve',
      directionHistory: [],
      lastDecision: null,
      totalCycles: 0,
      expandCount: 0,
      optimizeCount: 0,
      preserveCount: 0,
    }
  }

  private recordDecision(decision: DirectionDecision): void {
    this.state.totalCycles++
    this.state.currentDirection = decision.direction
    this.state.currentExpandMode = decision.expandMode
    this.state.lastDecision = decision

    switch (decision.direction) {
      case 'expand':
        this.state.expandCount++
        break
      case 'optimize':
        this.state.optimizeCount++
        break
      case 'preserve':
        this.state.preserveCount++
        break
    }

    this.state.directionHistory.push({
      direction: decision.direction,
      timestamp: Date.now(),
      reason: decision.reason,
    })

    // 防止历史无限增长
    if (this.state.directionHistory.length > 100) {
      this.state.directionHistory = this.state.directionHistory.slice(-100)
    }
  }

  private directionLabel(decision: DirectionDecision): string {
    if (decision.direction === 'expand' && decision.expandMode) {
      return `expand (${decision.expandMode})`
    }
    return decision.direction
  }
}
