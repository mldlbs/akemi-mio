import { log } from '../logger/Logger'
import type { HealthScoreInput, HealthScoreResult, HealthLevel } from './SessionGovernorTypes'
import { getHealthLevel } from './SessionGovernorTypes'

/**
 * SessionHealthScorer — 多信号加权健康评分引擎。
 *
 * 评分范围 0-100，由 6 个信号加权计算，指数平滑防止剧烈跳变。
 */

interface WindowEntry {
  success: boolean
  timestamp: number
}

interface LatencyEntry {
  latencyMs: number
  timestamp: number
}

const WEIGHTS = {
  consecutiveFailures: 0.3,
  toolSuccessRate: 0.25,
  contextIntegrity: 0.15,
  latencyFactor: 0.1,
  guardrailTripRate: 0.05,
  tokenBudgetUtilization: 0.15,
} as const

export class SessionHealthScorer {
  private score = 100
  private toolWindow: WindowEntry[] = []
  private latencyWindow: LatencyEntry[] = []
  private guardrailTripCount = 0
  private consecutiveFailures = 0
  private history: { score: number; timestamp: number }[] = []
  private readonly maxHistory = 60
  private readonly toolWindowSize = 20
  private readonly latencyWindowSize = 10

  getScore(): number {
    return this.score
  }

  getLevel(): HealthLevel {
    return getHealthLevel(this.score)
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures
  }

  // ── 事件输入 ──

  recordToolResult(success: boolean): void {
    this.toolWindow.push({ success, timestamp: Date.now() })
    if (this.toolWindow.length > this.toolWindowSize) {
      this.toolWindow = this.toolWindow.slice(-this.toolWindowSize)
    }

    if (success) {
      this.consecutiveFailures = 0
    } else {
      this.consecutiveFailures++
    }

    this.recompute()
  }

  recordLatency(latencyMs: number): void {
    this.latencyWindow.push({ latencyMs, timestamp: Date.now() })
    if (this.latencyWindow.length > this.latencyWindowSize) {
      this.latencyWindow = this.latencyWindow.slice(-this.latencyWindowSize)
    }
  }

  recordGuardrailTrip(): void {
    this.guardrailTripCount++
  }

  resetFailures(): void {
    this.consecutiveFailures = 0
  }

  // ── 评分计算 ──

  private recompute(): void {
    const inputs = this.computeInputs()
    const rawScore = this.weightedScore(inputs)
    const smoothed = this.history.length === 0 ? rawScore : Math.round(this.score * 0.7 + rawScore * 0.3)
    this.score = smoothed

    this.history.push({ score: this.score, timestamp: Date.now() })
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }
  }

  private computeInputs(): HealthScoreInput {
    // 连续失败归一化：0次→1, 33次→0
    const normalizedFailures = Math.max(0, 1 - this.consecutiveFailures / 33)

    // 工具成功率（滑动窗口）
    const successes = this.toolWindow.filter((e) => e.success).length
    const toolSuccessRate = this.toolWindow.length > 0 ? successes / this.toolWindow.length : 1

    // 上下文完整度：每次失败降 5%
    const contextIntegrity = Math.max(0, 1 - this.consecutiveFailures * 0.05)

    // 时延因子：平均 < 2s → 1, > 30s → 0
    const avgLatency =
      this.latencyWindow.length > 0 ? this.latencyWindow.reduce((s, e) => s + e.latencyMs, 0) / this.latencyWindow.length : 0
    const latencyFactor = Math.max(0, 1 - avgLatency / 30000)

    // Guardrail 触发率
    const guardrailTripRate = this.toolWindow.length > 0 ? Math.min(1, this.guardrailTripCount / Math.max(this.toolWindow.length, 1)) : 0
    const guardrailHealth = Math.max(0.3, 1 - guardrailTripRate)

    const tokenBudgetUtilization = 0.3

    return {
      consecutiveFailures: normalizedFailures,
      toolSuccessRate,
      contextIntegrity,
      latencyFactor,
      guardrailTripRate: guardrailHealth,
      tokenBudgetUtilization,
    }
  }

  private weightedScore(inputs: HealthScoreInput): number {
    const w = WEIGHTS
    return Math.round(
      Math.min(
        100,
        Math.max(
          0,
          inputs.consecutiveFailures * 100 * w.consecutiveFailures +
            inputs.toolSuccessRate * 100 * w.toolSuccessRate +
            inputs.contextIntegrity * 100 * w.contextIntegrity +
            inputs.latencyFactor * 100 * w.latencyFactor +
            inputs.guardrailTripRate * 100 * w.guardrailTripRate +
            (1 - inputs.tokenBudgetUtilization) * 100 * w.tokenBudgetUtilization,
        ),
      ),
    )
  }

  compute(): HealthScoreResult {
    const trend = this.getTrend()
    const inputs = this.computeInputs()
    return {
      score: this.score,
      level: this.getLevel(),
      trend,
      inputs,
      timestamp: Date.now(),
    }
  }

  private getTrend(): 'improving' | 'declining' | 'stable' {
    if (this.history.length < 20) return 'stable'
    const recent = this.history.slice(-10).reduce((s, p) => s + p.score, 0) / 10
    const previous = this.history.slice(-20, -10).reduce((s, p) => s + p.score, 0) / 10
    const diff = recent - previous
    if (diff > 2) return 'improving'
    if (diff < -2) return 'declining'
    return 'stable'
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      score: this.score,
      level: this.getLevel(),
      consecutiveFailures: this.consecutiveFailures,
      toolWindowSize: this.toolWindow.length,
      toolSuccessRate: this.toolWindow.length > 0 ? this.toolWindow.filter((e) => e.success).length / this.toolWindow.length : 1,
      guardrailTrips: this.guardrailTripCount,
      historyPoints: this.history.length,
    }
  }

  getSnapshot(): Record<string, unknown> {
    return this.getDiagnostics()
  }

  loadSnapshot(snap: Record<string, unknown>): void {
    if (typeof snap.score === 'number') this.score = snap.score
    if (typeof snap.consecutiveFailures === 'number') this.consecutiveFailures = snap.consecutiveFailures
    if (typeof snap.guardrailTrips === 'number') this.guardrailTripCount = snap.guardrailTrips
  }
}
