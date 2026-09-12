import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { ISubsystem, HealthCheckResult, SubsystemState } from '@akemi-mio/core/core/lifecycle/types'
import type { HealthLevel } from '@akemi-mio/evolution-governance'
import { getHealthLevel } from '@akemi-mio/evolution-governance'
import { ModelHealthTracker, type ModelHealthResult } from '@akemi-mio/monitoring/health/ModelHealthTracker'

// =============================================================================
// Dimension types
// =============================================================================

export interface DimensionHealth {
  score: number
  level: HealthLevel
  trend: 'improving' | 'declining' | 'stable'
}

export interface RuntimeHealthSnapshot {
  timestamp: number
  composite: DimensionHealth
  session: DimensionHealth
  capability: DimensionHealth
  task: DimensionHealth
  model: ModelHealthResult
  recommendedActions: string[]
}

// =============================================================================
// Provider interfaces
// =============================================================================

export interface SessionHealthProvider {
  getScore(): number
  getLevel(): HealthLevel
  getConsecutiveFailures(): number
}

export interface CapabilityHealthProvider {
  getCapabilitySummary(): { totalCapabilityHealth: number; servers: Array<{ name: string; healthScore: number; driftDetected: boolean }> }
}

export interface TaskHealthProvider {
  getTaskHealthSummary(): Array<{ type: string; status: string; consecutiveFailures: number; tier: string; disabled: boolean }>
}

// =============================================================================
// RuntimeHealthManager
// =============================================================================

/**
 * RuntimeHealthManager — Phase 5D: 统一四维健康总控。
 *
 * 整合 SessionHealth / CapabilityHealth / TaskHealth / ModelHealth 四个维度，
 * 输出 composite health score + severity + recommended actions。
 *
 * 注册为 ISubsystem，通过 HealthChecker 周期性检查。
 */
export class RuntimeHealthManager implements ISubsystem {
  readonly name = 'RuntimeHealthManager'
  state: SubsystemState = 'created'

  readonly modelHealth: ModelHealthTracker

  private sessionProvider: SessionHealthProvider | null = null
  private capabilityProvider: CapabilityHealthProvider | null = null
  private taskProvider: TaskHealthProvider | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private readonly tickIntervalMs = 30_000

  private history: { composite: number; timestamp: number }[] = []
  private readonly maxHistory = 60
  private lastCompositeScore = 100

  constructor() {
    this.modelHealth = new ModelHealthTracker()
  }

  // ── Dep injection ──

  setSessionHealthProvider(provider: SessionHealthProvider): void {
    this.sessionProvider = provider
  }

  setCapabilityHealthProvider(provider: CapabilityHealthProvider): void {
    this.capabilityProvider = provider
  }

  setTaskHealthProvider(provider: TaskHealthProvider): void {
    this.taskProvider = provider
  }

  // ── ISubsystem ──

  async init(): Promise<void> {
    if (this.state !== 'created') return
    this.state = 'initializing'
    log('INFO', 'runtime_health_manager.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    if (this.state !== 'ready') return
    this.state = 'running'

    this.modelHealth.start()
    this.evaluateAll()

    this.tickTimer = setInterval(() => this.evaluateAll(), this.tickIntervalMs)
    log('INFO', 'runtime_health_manager.started')
  }

  async stop(): Promise<void> {
    this.state = 'stopping'
    this.modelHealth.stop()
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.state = 'stopped'
    log('INFO', 'runtime_health_manager.stopped')
  }

  async destroy(): Promise<void> {
    this.modelHealth.stop()
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    log('INFO', 'runtime_health_manager.destroyed')
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const composite = this.computeComposite()
    const healthy = composite.score >= 50
    return {
      healthy,
      detail: healthy ? undefined : `Runtime health degraded: composite=${composite.score}(${composite.level})`,
      metrics: {
        compositeScore: composite.score,
        sessionScore: this.getSessionDimension().score,
        capabilityScore: this.getCapabilityDimension().score,
        taskScore: this.getTaskDimension().score,
        modelScore: this.modelHealth.getHealth().score,
      },
    }
  }

  // ── Public queries ──

  getSnapshot(): RuntimeHealthSnapshot {
    return {
      timestamp: Date.now(),
      composite: this.computeComposite(),
      session: this.getSessionDimension(),
      capability: this.getCapabilityDimension(),
      task: this.getTaskDimension(),
      model: this.modelHealth.getHealth(),
      recommendedActions: this.getRecommendedActions(),
    }
  }

  getCompositeScore(): number {
    return this.lastCompositeScore
  }

  getRecommendedActions(): string[] {
    const actions: string[] = []
    const composite = this.computeComposite()
    const session = this.getSessionDimension()
    const capability = this.getCapabilityDimension()
    const task = this.getTaskDimension()
    const model = this.modelHealth.getHealth()

    if (session.score < 50) actions.push('会话健康度严重偏低，建议触发恢复流程')
    else if (session.score < 70) actions.push('会话健康度下降，关注工具调用成功率')

    if (capability.score < 80) actions.push('MCP 能力漂移，检查服务器状态')

    if (task.score < 70) actions.push('后台任务失败率高，存在反复失败的任务')

    if (model.score < 60) actions.push('LLM 错误率过高，检查 API Key 和网络状态')
    else if (model.failureCount > 10) actions.push(`LLM 累计失败 ${model.failureCount} 次`)

    if (composite.score < 40) actions.push('系统总健康度临界，建议立即检查各子系统')

    return actions
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      composite: this.computeComposite(),
      session: this.getSessionDimension(),
      capability: this.getCapabilityDimension(),
      task: this.getTaskDimension(),
      model: this.modelHealth.getDiagnostics(),
      historyPoints: this.history.length,
      recommendedActions: this.getRecommendedActions(),
    }
  }

  // ── Internal evaluation ──

  private evaluateAll(): DimensionHealth {
    const composite = this.computeComposite()

    this.history.push({ composite: composite.score, timestamp: Date.now() })
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }
    this.lastCompositeScore = composite.score

    eventBus.emit('runtime.health.updated' as any, {
      compositeScore: composite.score,
      compositeLevel: composite.level,
      sessionScore: this.getSessionDimension().score,
      capabilityScore: this.getCapabilityDimension().score,
      taskScore: this.getTaskDimension().score,
      modelScore: this.modelHealth.getHealth().score,
      recommendedActions: this.getRecommendedActions(),
      timestamp: Date.now(),
    })

    return composite
  }

  private computeComposite(): DimensionHealth {
    const session = this.getSessionDimension()
    const capability = this.getCapabilityDimension()
    const task = this.getTaskDimension()
    const modelScore = this.modelHealth.getHealth().score
    const modelLevel = getHealthLevel(modelScore) as HealthLevel

    const compositeScore = Math.round(
      Math.min(100, Math.max(0, session.score * 0.35 + capability.score * 0.2 + task.score * 0.2 + modelScore * 0.25)),
    )

    const level = getHealthLevel(compositeScore) as HealthLevel
    const trend = this.computeTrend()

    return { score: compositeScore, level, trend }
  }

  private getSessionDimension(): DimensionHealth {
    if (!this.sessionProvider) return { score: 100, level: 'HEALTHY', trend: 'stable' }
    const score = this.sessionProvider.getScore()
    const level = this.sessionProvider.getLevel()
    const failures = this.sessionProvider.getConsecutiveFailures()
    const trend: DimensionHealth['trend'] = failures > 5 ? 'declining' : failures === 0 ? 'improving' : 'stable'
    return { score, level, trend }
  }

  private getCapabilityDimension(): DimensionHealth {
    if (!this.capabilityProvider) return { score: 100, level: 'HEALTHY', trend: 'stable' }

    const summary = this.capabilityProvider.getCapabilitySummary()
    if (summary.servers.length === 0) return { score: 100, level: 'HEALTHY', trend: 'stable' }

    const score = summary.totalCapabilityHealth
    const level = getHealthLevel(score) as HealthLevel
    const drifting = summary.servers.some((s) => s.driftDetected)
    const trend: DimensionHealth['trend'] = drifting ? 'declining' : score >= 95 ? 'stable' : 'improving'

    return { score, level, trend }
  }

  private getTaskDimension(): DimensionHealth {
    if (!this.taskProvider) return { score: 100, level: 'HEALTHY', trend: 'stable' }

    const entries = this.taskProvider.getTaskHealthSummary()
    if (entries.length === 0) return { score: 100, level: 'HEALTHY', trend: 'stable' }

    const disabledCount = entries.filter((e) => e.disabled).length
    const failingCount = entries.filter((e) => e.consecutiveFailures > 0).length
    const maxFailures = entries.reduce((max, e) => Math.max(max, e.consecutiveFailures), 0)
    const total = entries.length

    const disabledRatio = disabledCount / total
    const failingRatio = failingCount / total
    const failureSeverity = Math.min(1, maxFailures / 10)
    const score = Math.round(100 * (1 - disabledRatio * 0.5 - failingRatio * 0.3 - failureSeverity * 0.2))
    const level = getHealthLevel(score) as HealthLevel
    const trend: DimensionHealth['trend'] = failingCount > 0 && maxFailures > 3 ? 'declining' : 'stable'

    return { score, level, trend }
  }

  private computeTrend(): 'improving' | 'declining' | 'stable' {
    if (this.history.length < 10) return 'stable'
    const recent = this.history.slice(-5).reduce((s, p) => s + p.composite, 0) / 5
    const previous = this.history.slice(-10, -5).reduce((s, p) => s + p.composite, 0) / 5
    const diff = recent - previous
    if (diff > 2) return 'improving'
    if (diff < -2) return 'declining'
    return 'stable'
  }
}
