/**
 * GuardrailMetricsProjection — 从 EvaluationEvent 构建 Metrics 投影
 *
 * 职责：
 * - compute(events, windowSince, windowUntil): 纯函数，计算一个时间窗口的 metrics
 * - build(since): 从指定时间开始扫描事件，增量更新 metrics 表
 * - rebuild(): 清空并全量重建 metrics 投影
 *
 * 不可变约束（M6.1）：
 * - 只读 EvaluationStore（不读 DecisionStore）
 * - SignalState[] → NormalizedSignals 在 projection 层转换
 * - 不修改 ConfigStore
 */
import type { EvaluationEvent, EvaluationRepository } from './types'
import type { SignalState } from './GuardrailTypes'
import type { MetricsRow } from './GuardrailMetricsStore'
import { GuardrailMetricsStore } from './GuardrailMetricsStore'
import { CheckpointTracker } from './CheckpointTracker'

const PROJECTION_NAME = 'guardrail_metrics'

// ══════════════════════════════════════════════
// NormalizedSignals — Analytics 层稳定 schema
// ══════════════════════════════════════════════

export interface NormalizedSignals {
  stateChange: 'healthy' | 'degrading' | 'stalled' | null
  informationGain: 'healthy' | 'degrading' | 'stalled' | null
  goalProgress: 'healthy' | 'degrading' | 'stalled' | null
}

/** Runtime SignalState[] → Analytics NormalizedSignals */
export function normalizeSignals(signals: SignalState[] | undefined): NormalizedSignals {
  const result: NormalizedSignals = { stateChange: null, informationGain: null, goalProgress: null }
  if (!signals) return result
  for (const s of signals) {
    if (s.name === 'state_change') result.stateChange = s.status
    if (s.name === 'information_gain') result.informationGain = s.status
    if (s.name === 'goal_progress') result.goalProgress = s.status
  }
  return result
}

// ══════════════════════════════════════════════
// Window helpers
// ══════════════════════════════════════════════

const HOUR_MS = 3600000

export function windowKey(timestamp: number): string {
  const hourStart = Math.floor(timestamp / HOUR_MS) * HOUR_MS
  const hourEnd = hourStart + HOUR_MS
  return `${hourStart}_${hourEnd}`
}

export function windowStart(timestamp: number): number {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS
}

export function windowEnd(timestamp: number): number {
  return windowStart(timestamp) + HOUR_MS
}

// ══════════════════════════════════════════════
// Projection
// ══════════════════════════════════════════════

export class GuardrailMetricsProjection {
  private checkpointBatchSize: number

  constructor(
    private eventStore: EvaluationRepository,
    private metricsStore: GuardrailMetricsStore,
    private checkpointTracker?: CheckpointTracker,
    /** 每 checkpointBatchSize 事件更新一次 checkpoint seq */
    checkpointBatchSize: number = 500,
  ) {
    this.checkpointBatchSize = checkpointBatchSize < 1 ? 500 : checkpointBatchSize
  }

  /**
   * 对指定时间窗口内的 EvaluationEvent 计算 MetricsRow。
   * 纯函数：给定相同事件集 + 相同窗口，输出一致。
   */
  compute(events: EvaluationEvent[], windowSince: number, windowUntil: number): MetricsRow {
    let checkedCount = 0
    let warningCount = 0
    let terminatedCount = 0
    let continueCount = 0
    let totalSignalsHealthy = 0
    let totalSignalsDegrading = 0
    let totalSignalsStalled = 0

    const id = `${windowSince}_${windowUntil}`

    for (const ev of events) {
      if (ev.type !== 'guardrail.checked' && ev.type !== 'guardrail.terminated') continue

      const payload = ev.payload as unknown as Record<string, unknown> | undefined
      if (!payload) continue

      if (ev.type === 'guardrail.checked') {
        checkedCount++
        const decision = payload.decision as string
        if (decision === 'warning') warningCount++
        else if (decision === 'terminate') terminatedCount++
        else continueCount++

        // Normalize signals
        const signals = payload.signals as SignalState[] | undefined
        const ns = normalizeSignals(signals)
        if (ns.stateChange === 'healthy') totalSignalsHealthy++
        else if (ns.stateChange === 'degrading') totalSignalsDegrading++
        else if (ns.stateChange === 'stalled') totalSignalsStalled++
        if (ns.informationGain === 'healthy') totalSignalsHealthy++
        else if (ns.informationGain === 'degrading') totalSignalsDegrading++
        else if (ns.informationGain === 'stalled') totalSignalsStalled++
        if (ns.goalProgress === 'healthy') totalSignalsHealthy++
        else if (ns.goalProgress === 'degrading') totalSignalsDegrading++
        else if (ns.goalProgress === 'stalled') totalSignalsStalled++
      }

      if (ev.type === 'guardrail.terminated') {
        terminatedCount++
      }
    }

    return {
      id,
      windowSince,
      windowUntil,
      checkedCount,
      warningCount,
      terminatedCount,
      continueCount,
      totalSignalsHealthy,
      totalSignalsDegrading,
      totalSignalsStalled,
      updatedAt: Date.now(),
    }
  }

  /**
   * 增量构建：从 checkpoint 恢复，使用 seq 游标获取未处理事件。
   * R2-C: 增量构建是主路径。全量重建通过 rebuild() 保留。
   */
  async buildIncremental(): Promise<void> {
    const tracker = this.checkpointTracker
    if (!tracker) {
      // 无 checkpoint tracker 时退化为原有 build(since) 行为
      await this.build(0)
      return
    }

    // 从 checkpoint 恢复
    let lastSeq = 0
    const cp = await tracker.loadCheckpoint(PROJECTION_NAME)
    if (cp && cp.status === 'running') {
      // 上次构建中断 — 从 checkpoint 继续
      lastSeq = cp.lastSeq
    } else if (cp) {
      lastSeq = cp.lastSeq
    }

    await tracker.beginCheckpoint(PROJECTION_NAME, lastSeq)

    try {
      await this.processFromSeq(lastSeq, tracker)
      const finalSeq = this.eventStore.getCurrentSeq()
      await tracker.completeCheckpoint(PROJECTION_NAME, finalSeq)
    } catch (err: any) {
      await tracker.failCheckpoint(PROJECTION_NAME, lastSeq, err.message)
      throw err
    }
  }

  /**
   * 从指定 seq 处理事件，使用游标分页。
   * 每 checkpointBatchSize 事件更新一次 checkpoint seq。
   */
  private async processFromSeq(fromSeq: number, tracker: CheckpointTracker): Promise<void> {
    const PAGE_SIZE = 1000
    let lastSeq = fromSeq
    let hasMore = true

    while (hasMore) {
      const events = await this.eventStore.queryBySeq(lastSeq, PAGE_SIZE)
      if (events.length === 0) {
        hasMore = false
        break
      }

      // Group events by hour window
      const grouped = new Map<string, EvaluationEvent[]>()
      for (const ev of events) {
        const wStart = windowStart(ev.timestamp)
        const key = `${wStart}`
        const list = grouped.get(key) ?? []
        list.push(ev)
        grouped.set(key, list)
      }

      for (const [, windowEvents] of grouped) {
        const first = windowEvents[0]
        const wStart = windowStart(first.timestamp)
        const wEnd = windowEnd(first.timestamp)

        // 补全同一窗口的完整事件集
        const allWindowEvents = await this.eventStore.query({ since: wStart, until: wEnd })
        const row = this.compute(allWindowEvents, wStart, wEnd)
        await this.metricsStore.upsert(row)
      }

      // 更新 lastSeq 为当前批次最大 seq
      const maxSeqInBatch = Math.max(...events.map((e) => (e as any).seq ?? 0))
      if (maxSeqInBatch > lastSeq) {
        lastSeq = maxSeqInBatch
      }

      // 周期性持久化 checkpoint
      if (events.length > 0 && lastSeq - fromSeq >= this.checkpointBatchSize) {
        await tracker.updateCheckpoint(PROJECTION_NAME, lastSeq)
      }

      // 如果返回少于 PAGE_SIZE，说明已到末尾
      if (events.length < PAGE_SIZE) {
        hasMore = false
      }
    }
  }

  /**
   * 自增构建：从 since 开始扫描事件，对每小时窗口 compute() → upsert。
   * 使用最小的事件时间戳作为窗口边界，覆盖所有 events。
   * 保留用于无 checkpoint tracker 的场景。
   */
  async build(since: number): Promise<void> {
    // Fallback: use queryBySeq for future batches, legacy fallback to timestamp
    const allEvents = await this.eventStore.query({ since })
    if (allEvents.length === 0) return

    await this.buildFromEvents(allEvents)
  }

  /** 从事件集构建（共享逻辑）。 */
  private async buildFromEvents(events: EvaluationEvent[]): Promise<void> {
    const grouped = new Map<string, EvaluationEvent[]>()
    for (const ev of events) {
      const wStart = windowStart(ev.timestamp)
      const key = `${wStart}`
      const list = grouped.get(key) ?? []
      list.push(ev)
      grouped.set(key, list)
    }

    for (const [, windowEvents] of grouped) {
      const first = windowEvents[0]
      const wStart = windowStart(first.timestamp)
      const wEnd = windowEnd(first.timestamp)

      const allWindowEvents = await this.eventStore.query({ since: wStart, until: wEnd })
      const row = this.compute(allWindowEvents, wStart, wEnd)
      await this.metricsStore.upsert(row)
    }
  }

  /** 全量重建：清空后通过 checkpoint-based 增量重建。 */
  async rebuild(): Promise<void> {
    if (this.checkpointTracker) {
      await this.checkpointTracker.clearCheckpoint(PROJECTION_NAME)
    }
    await this.metricsStore.clear()
    await this.buildIncremental()
  }
}
