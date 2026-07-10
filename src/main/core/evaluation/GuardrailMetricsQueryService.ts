/**
 * GuardrailMetricsQueryService — Metrics 查询服务（只读）
 *
 * 职责：
 * - 封装 GuardrailMetricsStore 的查询能力
 * - 提供 projection 状态语义（独立于数据查询）
 * - 不暴露任何写操作（rebuild / clear / upsert）
 * - 不修改 ConfigStore / Policy / EvaluationStore
 *
 * 状态语义：
 *   - READY: 投影已完成最近一次构建或重建
 *   - REBUILDING: rebuild() 或增量 build() 正在进行中
 *   - UNAVAILABLE: MetricsStore 不可达或从未构建过
 *
 * 数据 API 与状态 API 分离（不耦合到 response 模型）：
 *   GuardrailMetricsQueryService
 *           |
 *           +-- query result          → summary / query / latest
 *           |
 *           +-- getProjectionState()  → metrics.state
 */
import type { MetricsRow, MetricsSummary } from './GuardrailMetricsStore'
import { GuardrailMetricsStore } from './GuardrailMetricsStore'
import type { GuardrailMetricsProjection } from './GuardrailMetricsProjection'

// ══════════════════════════════════════════════
// Projection State
// ══════════════════════════════════════════════

export type ProjectionState =
  | { status: 'READY'; lastBuiltAt: number; windowCount: number }
  | { status: 'REBUILDING'; startedAt: number; windowsBuilt: number }
  | { status: 'UNAVAILABLE'; reason: string }

// ══════════════════════════════════════════════
// Service
// ══════════════════════════════════════════════

export class GuardrailMetricsQueryService {
  private state: ProjectionState = { status: 'UNAVAILABLE', reason: 'not started' }

  constructor(
    private metricsStore: GuardrailMetricsStore,
    private projection: GuardrailMetricsProjection,
  ) {}

  // ── State lifecycle hooks (called by projection owner) ──

  notifyBuildStarted(): void {
    this.state = { status: 'REBUILDING', startedAt: Date.now(), windowsBuilt: 0 }
  }

  notifyWindowBuilt(): void {
    if (this.state.status === 'REBUILDING') {
      this.state = { ...this.state, windowsBuilt: this.state.windowsBuilt + 1 }
    }
  }

  notifyReady(): void {
    this.state = { status: 'READY', lastBuiltAt: Date.now(), windowCount: 0 }
    this.metricsStore
      .getSummary()
      .then((s) => {
        if (this.state.status === 'READY') {
          ;(this.state as any).windowCount = s.windowCount
        }
      })
      .catch(() => {})
  }

  // ── State API ──

  async getProjectionState(): Promise<ProjectionState> {
    if (this.state.status === 'READY') {
      try {
        const summary = await this.metricsStore.getSummary()
        this.state = { ...this.state, windowCount: summary.windowCount }
      } catch {
        /* stale count is acceptable */
      }
    }
    return this.state
  }

  // ── Data API (read-only, no mutation) ──

  async getSummary(): Promise<MetricsSummary> {
    return this.metricsStore.getSummary()
  }

  async queryTimeRange(since: number, until: number): Promise<MetricsRow[]> {
    return this.metricsStore.query(since, until)
  }

  async getLatest(): Promise<MetricsRow | null> {
    return this.metricsStore.getLatest()
  }
}
