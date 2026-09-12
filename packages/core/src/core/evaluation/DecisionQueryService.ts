/**
 * DecisionQueryService — Decision 查询服务（只读）
 *
 * 封装 GuardrailDecisionStore 的查询能力，提供状态语义。
 * 满足 M5.1 Q2 DecisionStore Query Contract：
 *   - getDecision(decisionId): DecisionQueryResult with state
 *   - listByTrace(traceId): DecisionRecord[]
 *   - listRecent(limit): 最近 N 条决策
 *
 * 状态语义（fire-and-forget write guarantee）：
 *   - RECORDED: decision 已在 DB 中存在
 *   - UNAVAILABLE: DB 不可达或查询无结果
 *
 * 不引入：
 *   - policyVersion 查询
 *   - 时间范围扫描
 *   - 聚合查询
 *   - 分页（trace 级别数据量可控）
 */
import type { GuardrailDecisionStore, DecisionRecord } from './GuardrailDecisionStore'
import type { RuntimeAction } from './GuardrailTypes'

// ══════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════

export type DecisionRecordState = 'RECORDED' | 'UNAVAILABLE'

export interface DecisionQueryResult {
  state: DecisionRecordState
  record?: DecisionRecord
}

export interface RecentDecisionItem {
  decisionId: string
  traceId: string
  action: string
  runtimeAction: RuntimeAction
  decidedAt: number
}

// ══════════════════════════════════════════════
// Service
// ══════════════════════════════════════════════

export class DecisionQueryService {
  constructor(private store: GuardrailDecisionStore) {}

  /**
   * 按 decisionId 查询单条决策。
   * 返回 RECORDED + record，或 UNAVAILABLE（不存在或 DB 不可达）。
   */
  async getDecision(decisionId: string): Promise<DecisionQueryResult> {
    const record = await this.store.getDecision(decisionId)
    if (!record) {
      return { state: 'UNAVAILABLE' }
    }
    return { state: 'RECORDED', record }
  }

  /**
   * 查询指定 trace 的所有决策记录。
   * DB 不可用时返回空数组（degraded）。
   */
  async listByTrace(traceId: string): Promise<DecisionRecord[]> {
    return this.store.getByTrace(traceId)
  }

  /**
   * 查询最近 N 条决策记录。
   * 返回精简字段（decisionId/traceId/action/runtimeAction/decidedAt）。
   * 不包含 signals/full record — 防 analytics 用途扩散。
   */
  async listRecent(limit: number = 10): Promise<RecentDecisionItem[]> {
    const records = await this.store.listRecent(limit)
    return records.map((r) => ({
      decisionId: r.decisionId,
      traceId: r.traceId,
      action: r.action,
      runtimeAction: r.runtimeAction,
      decidedAt: r.decidedAt,
    }))
  }
}
