/**
 * GuardrailRecommendation — Feedback 分析产物
 *
 * 只包含 evidence + metric summary + explanation + confidence。
 * 不包含 GuardrailPolicyConfig，不触发任何 Config 变更。
 *
 * 结构说明：
 * - recommendation.type 表示建议类型
 * - recommendation.evidence 包含统计数据
 * - recommendation.suggestion 是人类可读的文本（不是可执行 config）
 *
 * 禁止：
 * - 写入 EvaluationEvent
 * - 修改 ConfigStore/Policy
 * - 产生 config candidate
 */

export type RecommendationType = 'threshold_adjust' | 'policy_review' | 'no_change'

export type RecommendationConfidence = 'high' | 'medium' | 'low'

export type RecommendationStatus = 'open' | 'pending_approval' | 'accepted' | 'dismissed' | 'expired'

export interface RecommendationEvidence {
  decisionIds: string[]
  ineffectiveCount: number
  totalDecisions: number
  ineffectiveRate: number
  primaryIssue: string
}

export interface GuardrailRecommendation {
  id: string
  createdAt: number
  type: RecommendationType
  evidence: RecommendationEvidence
  suggestion: string
  confidence: RecommendationConfidence
  status: RecommendationStatus
  resolvedAt?: number
  resolvedBy?: string
}

// ══════════════════════════════════════════════
// Store（in-memory + optional event persistence）
// ══════════════════════════════════════════════

/**
 * M7.3 G3.1: recommendation 事件回调接口。
 * GuardrailRecommendationStore 通过此接口将生命周期事件写入 EvaluationStore。
 * 不直接依赖 EvaluationEmitter。
 */
export interface RecommendationEventSink {
  emitRecommendationCreated(payload: {
    recommendationId: string
    policyId: string
    type: RecommendationType
    confidence: RecommendationConfidence
    evidence: string[]
    detail: string
    triggeredByOutcomeIds: string[]
  }): void
  emitRecommendationApproved(payload: { recommendationId: string; policyId: string; approver: string; note?: string }): void
  emitRecommendationDismissed(payload: { recommendationId: string; policyId: string; reason: string; dismissedBy: string }): void
  // M7.3: Approval chain
  emitApprovalRequested(payload: {
    recommendationId: string
    policyId: string
    requestedBy: string
    reason: string
    requestedAt: number
  }): void
  emitApprovalAccepted(payload: { recommendationId: string; policyId: string; approver: string; note?: string; decidedAt: number }): void
  emitApprovalRejected(payload: { recommendationId: string; policyId: string; rejectedBy: string; reason: string; decidedAt: number }): void
  emitRecommendationExpired(payload: { recommendationId: string; policyId: string; reason: string; expiredAt: number }): void
}

export class GuardrailRecommendationStore {
  private recommendations: Map<string, GuardrailRecommendation> = new Map()
  private eventSink?: RecommendationEventSink

  /**
   * @param eventSink 可选事件回调。传入后 add 会同步产生 guardrail.recommendation.created 事件。
   * @param ttlMs recommendation 过期时间，默认 7 天
   */
  constructor(
    eventSink?: RecommendationEventSink,
    private ttlMs: number = 7 * 24 * 3600000,
  ) {
    this.eventSink = eventSink
  }

  add(r: GuardrailRecommendation): void {
    this.recommendations.set(r.id, r)
    this.eventSink?.emitRecommendationCreated({
      recommendationId: r.id,
      policyId: r.evidence.primaryIssue.split(' ')[0] ?? '',
      type: r.type,
      confidence: r.confidence,
      evidence: [
        `ineffectiveRate=${(r.evidence.ineffectiveRate * 100).toFixed(0)}%`,
        `total=${r.evidence.totalDecisions}`,
        r.evidence.primaryIssue,
      ],
      detail: r.suggestion,
      triggeredByOutcomeIds: r.evidence.decisionIds,
    })
  }

  get(id: string): GuardrailRecommendation | undefined {
    return this.recommendations.get(id)
  }

  list(status?: RecommendationStatus): GuardrailRecommendation[] {
    const all = Array.from(this.recommendations.values())
    if (status) return all.filter((r) => r.status === status)
    return all.sort((a, b) => b.createdAt - a.createdAt)
  }

  updateStatus(id: string, status: RecommendationStatus, resolvedBy?: string): boolean {
    const r = this.recommendations.get(id)
    if (!r) return false
    r.status = status
    if (status === 'accepted' || status === 'dismissed') {
      r.resolvedAt = Date.now()
      r.resolvedBy = resolvedBy
    }
    if (status === 'accepted') {
      this.eventSink?.emitRecommendationApproved({
        recommendationId: r.id,
        policyId: r.evidence.primaryIssue.split(' ')[0] ?? '',
        approver: resolvedBy ?? 'unknown',
        note: `Accepted recommendation: ${r.suggestion.substring(0, 200)}`,
      })
    }
    if (status === 'dismissed') {
      this.eventSink?.emitRecommendationDismissed({
        recommendationId: r.id,
        policyId: r.evidence.primaryIssue.split(' ')[0] ?? '',
        reason: 'Dismissed without action',
        dismissedBy: resolvedBy ?? 'unknown',
      })
    }
    return true
  }

  // ══════════════════════════════════════════════
  // M7.3 — Approval Chain
  // ══════════════════════════════════════════════

  /** 请求人工审批。将状态从 open 变为 pending_approval。 */
  requestApproval(id: string, requestedBy: string, reason: string): boolean {
    const r = this.recommendations.get(id)
    if (!r || r.status !== 'open') return false
    r.status = 'pending_approval'
    this.eventSink?.emitApprovalRequested({
      recommendationId: r.id,
      policyId: r.evidence.primaryIssue.split(' ')[0] ?? '',
      requestedBy,
      reason,
      requestedAt: Date.now(),
    })
    return true
  }

  /** 接受审批。将状态从 pending_approval 变为 accepted。 */
  acceptApproval(id: string, approver: string, note?: string): boolean {
    const r = this.recommendations.get(id)
    if (!r || r.status !== 'pending_approval') return false
    r.status = 'accepted'
    r.resolvedAt = Date.now()
    r.resolvedBy = approver
    this.eventSink?.emitApprovalAccepted({
      recommendationId: r.id,
      policyId: r.evidence.primaryIssue.split(' ')[0] ?? '',
      approver,
      note,
      decidedAt: Date.now(),
    })
    return true
  }

  /** 驳回审批。将状态从 pending_approval 变为 dismissed。 */
  rejectApproval(id: string, rejectedBy: string, reason: string): boolean {
    const r = this.recommendations.get(id)
    if (!r || r.status !== 'pending_approval') return false
    r.status = 'dismissed'
    r.resolvedAt = Date.now()
    r.resolvedBy = rejectedBy
    this.eventSink?.emitApprovalRejected({
      recommendationId: r.id,
      policyId: r.evidence.primaryIssue.split(' ')[0] ?? '',
      rejectedBy,
      reason,
      decidedAt: Date.now(),
    })
    return true
  }

  // ══════════════════════════════════════════════
  // M7.3 — Expiry Lifecycle
  // ══════════════════════════════════════════════

  /**
   * 扫描所有 open / pending_approval 的 recommendation，
   * 将超过 ttlMs 的标记为 expired，并发射 guardrail.recommendation.expired 事件。
   * 返回本次新过期的数量。
   */
  sweepExpired(): number {
    const now = Date.now()
    const expired: GuardrailRecommendation[] = []
    for (const r of this.recommendations.values()) {
      if ((r.status === 'open' || r.status === 'pending_approval') && now - r.createdAt > this.ttlMs) {
        r.status = 'expired'
        r.resolvedAt = now
        r.resolvedBy = 'system'
        expired.push(r)
      }
    }
    for (const r of expired) {
      this.eventSink?.emitRecommendationExpired({
        recommendationId: r.id,
        policyId: r.evidence.primaryIssue.split(' ')[0] ?? '',
        reason: `Recommendation expired after ${Math.round(this.ttlMs / 3600000)} hours without resolution`,
        expiredAt: now,
      })
    }
    return expired.length
  }

  /** 配置 TTL（测试用） */
  setTtlMs(ttlMs: number): void {
    this.ttlMs = ttlMs
  }

  count(): number {
    return this.recommendations.size
  }
}

// ══════════════════════════════════════════════
// FeedbackAnalyzer — 只读分析，产生 Recommendation
// ══════════════════════════════════════════════

import type { OutcomeStore, OutcomeRecord } from './OutcomeStore'

export class GuardrailFeedbackAnalyzer {
  constructor(
    private outcomeStore: OutcomeStore,
    private recommendationStore: GuardrailRecommendationStore,
  ) {}

  async analyze(): Promise<GuardrailRecommendation[]> {
    const summary = await this.outcomeStore.getSummary()
    const recommendations: GuardrailRecommendation[] = []

    if (summary.totalOutcomes === 0) {
      return []
    }

    const ineffectiveRate = summary.totalOutcomes > 0 ? summary.ineffective / summary.totalOutcomes : 0

    // policy-level analysis
    for (const [policyVersion, stats] of Object.entries(summary.byPolicy)) {
      if (stats.total < 3) continue // 数据不足，不产生建议

      const policyIneffectiveRate = stats.total > 0 ? stats.ineffective / stats.total : 0

      if (policyIneffectiveRate > 0.3) {
        const recentOutcomes = await this.outcomeStore.getByPolicyVersion(policyVersion)
        const decisionIds = recentOutcomes
          .filter((r) => r.outcome === 'ineffective')
          .slice(0, 20)
          .map((r) => r.decisionId)

        recommendations.push({
          id: `rec_${Date.now()}_${policyVersion}`,
          createdAt: Date.now(),
          type: 'threshold_adjust',
          evidence: {
            decisionIds,
            ineffectiveCount: stats.ineffective,
            totalDecisions: stats.total,
            ineffectiveRate: policyIneffectiveRate,
            primaryIssue: `Policy ${policyVersion} 无效率 ${(policyIneffectiveRate * 100).toFixed(0)}%，建议检查阈值配置`,
          },
          suggestion: `Policy ${policyVersion} 在 ${stats.total} 次决策中无效率 ${(policyIneffectiveRate * 100).toFixed(0)}%。建议 review GuardrailPolicyConfig 的 threshold 参数。`,
          confidence: policyIneffectiveRate > 0.5 ? 'high' : 'medium',
          status: 'open',
        })
      }
    }

    // global ineffective rate
    if (ineffectiveRate > 0.3) {
      recommendations.push({
        id: `rec_${Date.now()}_global`,
        createdAt: Date.now(),
        type: 'policy_review',
        evidence: {
          decisionIds: [],
          ineffectiveCount: summary.ineffective,
          totalDecisions: summary.totalOutcomes,
          ineffectiveRate,
          primaryIssue: `全局无效率 ${(ineffectiveRate * 100).toFixed(0)}%，需要 policy review`,
        },
        suggestion: `全局 guardrail 决策无效率 ${(ineffectiveRate * 100).toFixed(0)}%（共 ${summary.totalOutcomes} 次决策，${summary.ineffective} 次无效）。建议人工 review 当前 Policy 配置。`,
        confidence: 'medium',
        status: 'open',
      })
    }

    if (summary.falsePositiveCount > 0 || summary.falseNegativeCount > 0) {
      recommendations.push({
        id: `rec_${Date.now()}_bias`,
        createdAt: Date.now(),
        type: 'policy_review',
        evidence: {
          decisionIds: [],
          ineffectiveCount: summary.falsePositiveCount + summary.falseNegativeCount,
          totalDecisions: summary.totalOutcomes,
          ineffectiveRate: (summary.falsePositiveCount + summary.falseNegativeCount) / Math.max(summary.totalOutcomes, 1),
          primaryIssue: `False positive: ${summary.falsePositiveCount}, false negative: ${summary.falseNegativeCount}`,
        },
        suggestion: `存在 false positive (${summary.falsePositiveCount}) 和 false negative (${summary.falseNegativeCount})，建议分析误报模式并调整对应信号阈值。`,
        confidence: 'high',
        status: 'open',
      })
    }

    for (const r of recommendations) {
      this.recommendationStore.add(r)
    }

    return recommendations
  }
}
