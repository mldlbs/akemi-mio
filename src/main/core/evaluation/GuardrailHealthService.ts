/**
 * GuardrailHealthService — M7.2 Operational Health
 *
 * 只读健康检查 + 一致性验证。不修改任何 state，不触发 repair。
 *
 * ── 边界 ──
 * healthCheck()        → status/reporting
 *                        ↓
 *                       (绝不触发 auto repair / auto activate)
 *
 * verifyProjectionConsistency() → read-only replay audit
 *                                   ↓
 *                                  (绝不触发 rebuild / repair)
 */
import { randomUUID } from 'crypto'
import type { EvaluationEvent, EvaluationRepository, EventType } from './types'
import { QUERY_NO_LIMIT } from './EvaluationStore'
import { HOT_RETENTION } from './RetentionConfig'

// ══════════════════════════════════════════════
// Types (G2.1, G2.4)
// ══════════════════════════════════════════════

export type ComponentStatus = 'UP' | 'DEGRADED' | 'DOWN'

export interface ComponentHealth {
  name: string
  status: ComponentStatus
  detail: string
  lastChecked: number
}

export type SystemHealthLevel = 'NORMAL' | 'DEGRADED' | 'PARTIAL' | 'DOWN'

export interface SystemDegradationStatus {
  level: SystemHealthLevel
  components: ComponentHealth[]
}

// ══════════════════════════════════════════════
// Replay Verification (G2.2)
// ══════════════════════════════════════════════

export interface WindowMismatch {
  window: string
  expectedCount: number
  actualCount: number
  delta: number
}

export type VerificationStatus = 'PASS' | 'FAIL' | 'WARN'

export interface ReplayVerificationResult {
  id: string
  timestamp: number
  status: VerificationStatus
  durationMs: number
  eventCount: number
  mismatches: WindowMismatch[]
  lastVerifiedEventId: string | null
}

/** Replay verification 依赖的 projection contract */
export interface ProjectionVerifiable {
  getProjectionState(): Promise<{ status: string; windowCount: number }>
  getSummary(): Promise<{ totalChecked: number; windowCount: number }>
  query(windowSince: number, windowUntil: number): Promise<{ id: string; checkedCount: number }[]>
}

/** ConfigStore contract for health check */
export interface ConfigStoreHealthCheckable {
  getActiveConfig(): { version: string; config: unknown }
  getVersionHistory(): { version: string; activatedAt: number }[]
}

/** RecommendationStore contract for health check */
export interface RecommendationStoreHealthCheckable {
  count(): number
  /** M7.3: sweep expired recommendations. Returns count of newly expired items. */
  sweepExpired(): number
}

// ══════════════════════════════════════════════
// Health Service
// ══════════════════════════════════════════════

export class GuardrailHealthService {
  private stalenessThresholdMs: number

  /**
   * @param stalenessThresholdMs 投影健康检查的过时阈值，默认 2 小时
   */
  constructor(
    private eventStore: EvaluationRepository,
    private metricsProjection: ProjectionVerifiable,
    private configStore: ConfigStoreHealthCheckable,
    private recommendationStore: RecommendationStoreHealthCheckable,
    stalenessThresholdMs: number = 2 * 3600000,
  ) {
    this.stalenessThresholdMs = stalenessThresholdMs
  }

  // ══════════════════════════════════════════════
  // G2.1: healthCheck()
  // ══════════════════════════════════════════════

  async healthCheck(): Promise<SystemDegradationStatus> {
    const now = Date.now()
    const checks = await Promise.all([
      this.checkMetricsProjection(now),
      this.checkConfigStore(now),
      this.checkRecommendationStore(now),
      this.checkEvaluationStore(now),
      this.checkRetentionStatus(now),
    ])

    const components = checks.flat()
    const level = this.aggregateLevel(components)

    return { level, components }
  }

  private async checkMetricsProjection(now: number): Promise<ComponentHealth[]> {
    try {
      const state = await this.metricsProjection.getProjectionState()
      const summary = await this.metricsProjection.getSummary()

      if (state.status === 'UNAVAILABLE') {
        return [
          {
            name: 'metrics_projection',
            status: 'DOWN',
            detail: state.status === 'UNAVAILABLE' ? ((state as any).reason ?? 'not started') : 'unavailable',
            lastChecked: now,
          },
        ]
      }

      if (state.status === 'REBUILDING') {
        return [{ name: 'metrics_projection', status: 'DEGRADED', detail: 'rebuilding in progress', lastChecked: now }]
      }

      // READY: check staleness
      const lastBuilt = (state as any).lastBuiltAt
      const staleness = lastBuilt ? now - lastBuilt : 0
      if (staleness > this.stalenessThresholdMs) {
        return [
          {
            name: 'metrics_projection',
            status: 'DEGRADED',
            detail: `stale: last build ${Math.round(staleness / 60000)} min ago, threshold ${Math.round(this.stalenessThresholdMs / 60000)} min`,
            lastChecked: now,
          },
        ]
      }

      return [
        {
          name: 'metrics_projection',
          status: 'UP',
          detail: `${summary.windowCount} windows, ${summary.totalChecked} events`,
          lastChecked: now,
        },
      ]
    } catch (err: any) {
      return [{ name: 'metrics_projection', status: 'DOWN', detail: err.message, lastChecked: now }]
    }
  }

  private async checkConfigStore(now: number): Promise<ComponentHealth[]> {
    try {
      const active = this.configStore.getActiveConfig()
      const history = this.configStore.getVersionHistory()

      if (history.length === 0) {
        return [{ name: 'config_store', status: 'DEGRADED', detail: 'no active config (using DEFAULT)', lastChecked: now }]
      }

      return [
        {
          name: 'config_store',
          status: 'UP',
          detail: `active: ${active.version}, ${history.length} versions in history`,
          lastChecked: now,
        },
      ]
    } catch (err: any) {
      return [{ name: 'config_store', status: 'DOWN', detail: err.message, lastChecked: now }]
    }
  }

  private async checkRecommendationStore(now: number): Promise<ComponentHealth[]> {
    try {
      const expired = this.recommendationStore.sweepExpired()
      const count = this.recommendationStore.count()
      const detail =
        expired > 0 ? `${count} recommendations (${expired} newly expired)` : `${count} recommendations in memory (no persistence)`
      return [{ name: 'recommendation_store', status: 'UP', detail, lastChecked: now }]
    } catch (err: any) {
      return [{ name: 'recommendation_store', status: 'DOWN', detail: err.message, lastChecked: now }]
    }
  }

  private async checkEvaluationStore(now: number): Promise<ComponentHealth[]> {
    try {
      const events = await this.eventStore.query({ since: 0, until: 1 })
      // If query returns without throwing, store is reachable
      return [{ name: 'evaluation_store', status: 'UP', detail: 'reachable', lastChecked: now }]
    } catch (err: any) {
      return [{ name: 'evaluation_store', status: 'DOWN', detail: err.message, lastChecked: now }]
    }
  }

  /** R1: Retention 状态健康检查。查询最旧事件年龄与保留目标对比。 */
  private async checkRetentionStatus(now: number): Promise<ComponentHealth[]> {
    try {
      // 查询最旧一条事件（since=0, until=now, ORDER BY timestamp ASC LIMIT 1）
      const events = await this.eventStore.query({ since: 0, until: now }, { limit: 1 })
      if (events.length === 0) {
        return [{ name: 'event_retention', status: 'UP', detail: 'no events (empty store)', lastChecked: now }]
      }

      const oldestTs = events[0].timestamp

      const ageDays = Math.round((now - oldestTs) / 86400000)
      const targetDays = Math.round(HOT_RETENTION.EVALUATION_EVENTS / 86400000)
      const graceDays = 1 // R1-I2: 软限制，+1d 宽限

      if (ageDays > targetDays + graceDays) {
        return [
          {
            name: 'event_retention',
            status: 'DEGRADED',
            detail: `oldest event ${ageDays}d ago (target ${targetDays}d), retention overdue`,
            lastChecked: now,
          },
        ]
      }

      return [
        {
          name: 'event_retention',
          status: 'UP',
          detail: `oldest event ${ageDays}d ago (target ${targetDays}d)`,
          lastChecked: now,
        },
      ]
    } catch (err: any) {
      return [{ name: 'event_retention', status: 'DOWN', detail: err.message, lastChecked: now }]
    }
  }

  private aggregateLevel(components: ComponentHealth[]): SystemHealthLevel {
    const statuses = new Set(components.map((c) => c.status))

    if (statuses.has('DOWN')) return 'DOWN'
    if (statuses.has('DEGRADED')) return 'DEGRADED'
    // All UP or mixed with UP-only → NORMAL
    return 'NORMAL'
  }

  // ══════════════════════════════════════════════
  // G2.2: Replay Verification (只读一致性验证)
  // ══════════════════════════════════════════════

  /**
   * 验证 EventStore → MetricsProjection 的一致性。
   *
   * 方法：
   * 1. 扫描 EventStore 中的 guardrail 事件
   * 2. 按小时窗口分组，模拟 compute() 计算期望的 checkedCount
   * 3. 与 MetricsStore 中的实际 checkedCount 对比
   *
   * 约束：
   * - 只读（不修改 EvaluationStore / MetricsStore / ConfigStore）
   * - 不触发 rebuild / repair
   * - 输出 audit result，不改变系统状态
   */
  async verifyProjectionConsistency(since?: number, until?: number): Promise<ReplayVerificationResult> {
    const startedAt = Date.now()
    const windowSince = since ?? 0
    const windowUntil = until ?? Date.now()

    // Step 1: Read events from EventStore
    const events = await this.eventStore.query({ since: windowSince, until: windowUntil }, { limit: QUERY_NO_LIMIT })
    const guardrailEvents = events.filter((e) => e.type === 'guardrail.checked' || e.type === 'guardrail.terminated')

    if (guardrailEvents.length === 0) {
      return {
        id: randomUUID(),
        timestamp: startedAt,
        status: 'WARN',
        durationMs: Date.now() - startedAt,
        eventCount: 0,
        mismatches: [],
        lastVerifiedEventId: null,
      }
    }

    // Step 2: Group by hour window (same logic as GuardrailMetricsProjection.build)
    const HOUR_MS = 3600000
    const expectedMap = new Map<string, number>()
    for (const ev of guardrailEvents) {
      const wStart = Math.floor(ev.timestamp / HOUR_MS) * HOUR_MS
      const key = `${wStart}`
      expectedMap.set(key, (expectedMap.get(key) ?? 0) + 1)
    }

    // Step 3: Compare with MetricsStore
    const mismatches: WindowMismatch[] = []
    let lastId: string | null = null
    if (guardrailEvents.length > 0) {
      lastId = guardrailEvents[guardrailEvents.length - 1].id
    }

    for (const [windowKey, expectedCount] of expectedMap) {
      const wStart = Number(windowKey)
      const wEnd = wStart + HOUR_MS

      let actualCount = 0
      try {
        const rows = await this.metricsProjection.query(wStart, wEnd)
        actualCount = rows.reduce((sum, r) => sum + r.checkedCount, 0)
      } catch {
        actualCount = 0
      }

      const delta = Math.abs(expectedCount - actualCount)
      if (delta > 0) {
        mismatches.push({ window: windowKey, expectedCount, actualCount, delta })
      }
    }

    const status: VerificationStatus = mismatches.length === 0 ? 'PASS' : 'FAIL'

    return {
      id: randomUUID(),
      timestamp: startedAt,
      status,
      durationMs: Date.now() - startedAt,
      eventCount: guardrailEvents.length,
      mismatches,
      lastVerifiedEventId: lastId,
    }
  }
}
