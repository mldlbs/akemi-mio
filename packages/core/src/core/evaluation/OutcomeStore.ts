/**
 * OutcomeStore — Outcome Event Projection（只读）
 *
 * 从 EvaluationStore 查询 guardrail.outcome.observed 事件，
 * 提供 feedback analysis 的输入投影。
 *
 * 不修改 Decision / Config / EvaluationStore。
 * 不产生任何 EvaluationEvent。
 */
import type { EvaluationRepository, Outcome, OutcomeConfidence, OutcomeSource, EvaluationEvent } from './types'

const OUTCOME_FETCH_PAGE = 1000

export interface OutcomeRecord {
  decisionId: string
  traceId: string
  policyVersion: string
  outcome: Outcome
  confidence: OutcomeConfidence
  source: OutcomeSource
  falsePositive?: boolean
  falseNegative?: boolean
  detail: string
  observedAt: number
}

export interface OutcomeSummary {
  totalOutcomes: number
  effective: number
  ineffective: number
  inconclusive: number
  falsePositiveCount: number
  falseNegativeCount: number
  byPolicy: Record<string, { total: number; effective: number; ineffective: number }>
}

export class OutcomeStore {
  constructor(private eventStore: EvaluationRepository) {}

  /** 使用 seq 游标分页获取所有 outcome 事件。避免全量无界查询。
   *  Fallback 到 timestamp-based query（无 seq 列的旧 DB 兼容）。 */
  private async scanAllOutcomeEvents(): Promise<EvaluationEvent[]> {
    // 优先 timestamp 查询（快速路径 — 有索引，查询结果精准）
    const fromTs = await this.eventStore.query({ since: 0, type: 'guardrail.outcome.observed' as any })
    if (fromTs.length > 0) return fromTs

    // 退化为 seq 游标：这在 timestamp 查询返回空但实际有数据时（极少场景）使用
    const result: EvaluationEvent[] = []
    let cursor = 0
    let hasMore = true

    while (hasMore) {
      let page: EvaluationEvent[]
      try {
        page = await this.eventStore.queryBySeq(cursor, OUTCOME_FETCH_PAGE)
      } catch {
        // 查询不支持 seq → 退化为 timestamp-based
        return this.eventStore.query({ since: 0, type: 'guardrail.outcome.observed' as any })
      }

      if (!page || page.length === 0) {
        hasMore = false
        break
      }

      for (const ev of page) {
        if (ev.type === 'guardrail.outcome.observed') {
          result.push(ev)
        }
      }

      const last = page[page.length - 1]
      if ((last as any).seq !== undefined) {
        cursor = (last as any).seq
      }

      if (page.length < OUTCOME_FETCH_PAGE) {
        hasMore = false
      }
    }

    return result
  }

  async getByDecision(decisionId: string): Promise<OutcomeRecord | null> {
    const events = await this.scanAllOutcomeEvents()
    for (const ev of events) {
      const p = parsePayload(ev)
      if (p.decisionId === decisionId) return p
    }
    return null
  }

  async getByTrace(traceId: string): Promise<OutcomeRecord[]> {
    const events = await this.scanAllOutcomeEvents()
    return events.filter((ev) => ev.traceId === traceId).map((ev) => parsePayload(ev))
  }

  async getByPolicyVersion(policyVersion: string): Promise<OutcomeRecord[]> {
    const events = await this.scanAllOutcomeEvents()
    return events.filter((ev) => parsePayload(ev).policyVersion === policyVersion).map((ev) => parsePayload(ev))
  }

  async getRecent(limit: number = 20): Promise<OutcomeRecord[]> {
    const events = await this.scanAllOutcomeEvents()
    return events
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .map((ev) => parsePayload(ev))
  }

  async getSummary(): Promise<OutcomeSummary> {
    const records = (await this.scanAllOutcomeEvents()).map((ev) => parsePayload(ev))

    let effective = 0
    let ineffective = 0
    let inconclusive = 0
    let falsePositiveCount = 0
    let falseNegativeCount = 0
    const byPolicy: Record<string, { total: number; effective: number; ineffective: number }> = {}

    for (const r of records) {
      if (r.outcome === 'effective') effective++
      else if (r.outcome === 'ineffective') ineffective++
      else inconclusive++

      if (r.falsePositive) falsePositiveCount++
      if (r.falseNegative) falseNegativeCount++

      if (!byPolicy[r.policyVersion]) {
        byPolicy[r.policyVersion] = { total: 0, effective: 0, ineffective: 0 }
      }
      byPolicy[r.policyVersion].total++
      if (r.outcome === 'effective') byPolicy[r.policyVersion].effective++
      else if (r.outcome === 'ineffective') byPolicy[r.policyVersion].ineffective++
    }

    return { totalOutcomes: records.length, effective, ineffective, inconclusive, falsePositiveCount, falseNegativeCount, byPolicy }
  }
}

function parsePayload(ev: EvaluationEvent): OutcomeRecord {
  const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload
  return {
    decisionId: p.decisionId as string,
    traceId: p.traceId as string,
    policyVersion: p.policyVersion as string,
    outcome: p.outcome as Outcome,
    confidence: p.confidence as OutcomeConfidence,
    source: p.source as OutcomeSource,
    falsePositive: p.falsePositive as boolean | undefined,
    falseNegative: p.falseNegative as boolean | undefined,
    detail: p.detail as string,
    observedAt: p.observedAt as number,
  }
}
