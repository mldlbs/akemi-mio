/**
 * AuditVerifier — M7.4 Audit Verification
 *
 * 只读事件链完整性验证。完全基于 EvaluationEvent Log，不依赖任何 Projection / Store。
 *
 * ── 审计源 ──
 * EvaluationEvent Log (唯一不可变事实源)
 *   ↓
 * AuditVerifier (只读分析)
 *   ↓
 * AuditResult (瞬态快照)
 *
 * ── 约束 ──
 * - 不读取 GuardrailConfigStore / GuardrailMetricsStore / GuardrailRecommendationStore
 * - 不修改 EventLog
 * - 不触发 repair / rebuild / retry
 * - AuditResult 不写入 EvaluationStore（避免 audit 事件自身被审计的循环依赖）
 */
import { randomUUID } from 'crypto'
import type { EvaluationEvent, EvaluationRepository } from './types'
import { QUERY_NO_LIMIT } from './EvaluationStore'
import { GOVERNANCE_EVENT_TYPES } from './EvaluationEventSchema'

// ══════════════════════════════════════════════
// Audit Types
// ══════════════════════════════════════════════

export type AuditStatus = 'COMPLETE' | 'INCOMPLETE' | 'INVALID' | 'STALE' | 'WARN'

export type AuditViolationType = 'MISSING_EVENT' | 'UNEXPECTED_EVENT' | 'CORRELATION_MISMATCH' | 'BROKEN_CHAIN'

export type ChainType = 'APPROVAL' | 'EXPIRY' | 'ACTIVATION' | 'ROLLBACK' | 'OUTCOME'

export interface AuditViolation {
  type: AuditViolationType
  chainType: ChainType
  detail: string
  evidence: {
    eventIds: string[]
    expected: string
    actual: string
  }
}

export interface AuditChainResult {
  chainType: ChainType
  /** 链实例标识（如 recommendationId） */
  chainId: string
  status: AuditStatus
  /** 链中的事件 ID，按时间升序 */
  events: string[]
  violations: AuditViolation[]
}

export interface AuditOptions {
  since: number
  until: number
  /** 只验证指定 recommendationId 的链（可选） */
  recommendationId?: string
  /** 只验证指定类型（可选） */
  chainTypes?: ChainType[]
}

export interface AuditResult {
  id: string
  timestamp: number
  durationMs: number
  window: { since: number; until: number }
  status: AuditStatus
  chains: AuditChainResult[]
  violations: AuditViolation[]
  eventCount: number
}

// ══════════════════════════════════════════════
// Audit Events Filter
// ══════════════════════════════════════════════

/** 所有可能会与治理链相关的 EventType（governance + config activation/rollback） */
const AUDIT_EVENT_TYPES = new Set([
  ...Array.from(GOVERNANCE_EVENT_TYPES),
  'guardrail.config.initialized',
  'guardrail.config.activated',
  'guardrail.config.rollback',
  'guardrail.config.terminated',
  'guardrail.outcome.observed',
])

// ══════════════════════════════════════════════
// Audit Verifier
// ══════════════════════════════════════════════

export class AuditVerifier {
  constructor(private eventStore: EvaluationRepository) {}

  // ══════════════════════════════════════════════
  // 按 recommendationId 追溯整条链
  // ══════════════════════════════════════════════

  async verifyChain(recId: string, since?: number, until?: number): Promise<AuditChainResult> {
    const startedAt = Date.now()
    const events = await this.eventStore.query({
      since: since ?? 0,
      until: until ?? Date.now(),
    })

    const related = this.findRelatedEvents(events, recId)
    if (related.length === 0) {
      return {
        chainType: 'APPROVAL',
        chainId: recId,
        status: 'WARN',
        events: [],
        violations: [],
      }
    }

    return this.analyzeChain(related)
  }

  // ══════════════════════════════════════════════
  // 按时间窗口批量验证
  // ══════════════════════════════════════════════

  async verifyWindow(since: number, until: number): Promise<AuditResult> {
    return this.verifyAll({ since, until })
  }

  // ══════════════════════════════════════════════
  // 全量验证
  // ══════════════════════════════════════════════

  async verifyAll(options: AuditOptions): Promise<AuditResult> {
    const startedAt = Date.now()
    const events = await this.eventStore.query({ since: options.since, until: options.until })

    // Filter to governance + config events
    const auditEvents = events.filter((e) => AUDIT_EVENT_TYPES.has(e.type))

    if (auditEvents.length === 0) {
      return {
        id: randomUUID(),
        timestamp: startedAt,
        durationMs: Date.now() - startedAt,
        window: { since: options.since, until: options.until },
        status: 'WARN',
        chains: [],
        violations: [],
        eventCount: 0,
      }
    }

    // Group by recommendationId
    const groups = this.groupByRecommendationId(auditEvents)

    // Analyze each group
    const chains: AuditChainResult[] = []
    for (const [recId, groupEvents] of groups) {
      if (options.recommendationId && recId !== options.recommendationId) continue
      const chain = this.analyzeChain(groupEvents)
      if (options.chainTypes && !options.chainTypes.includes(chain.chainType)) continue
      chains.push(chain)
    }

    // Flatten violations
    const violations = chains.flatMap((c) => c.violations)

    // Aggregate status
    const status = this.aggregateStatus(chains)

    return {
      id: randomUUID(),
      timestamp: startedAt,
      durationMs: Date.now() - startedAt,
      window: { since: options.since, until: options.until },
      status,
      chains,
      violations,
      eventCount: auditEvents.length,
    }
  }

  // ══════════════════════════════════════════════
  // Private: Event Filtering
  // ══════════════════════════════════════════════

  /** 寻找与指定 recommendationId 相关的所有事件 */
  private findRelatedEvents(events: EvaluationEvent[], recId: string): EvaluationEvent[] {
    return events
      .filter((e) => AUDIT_EVENT_TYPES.has(e.type))
      .filter((e) => {
        const p = e.payload as unknown as Record<string, unknown>
        return p.recommendationId === recId || p.sourceRecommendationId === recId
      })
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  /** 按 recommendationId 分组。没有 recommendationId 的事件归入"orphan"组 */
  private groupByRecommendationId(events: EvaluationEvent[]): Map<string, EvaluationEvent[]> {
    const groups = new Map<string, EvaluationEvent[]>()
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)

    for (const event of sorted) {
      const p = event.payload as unknown as Record<string, unknown>
      const recId = (p.recommendationId ?? p.sourceRecommendationId ?? '') as string
      if (recId) {
        const list = groups.get(recId) ?? []
        list.push(event)
        groups.set(recId, list)
      }
    }

    return groups
  }

  // ══════════════════════════════════════════════
  // Private: Chain Analysis
  // ══════════════════════════════════════════════

  /**
   * 分析一组事件的 APPROVAL 链完整性。
   * 预期链：created → approval_requested → approval_accepted / approval_rejected → config.activated
   */
  private analyzeChain(events: EvaluationEvent[]): AuditChainResult {
    const violations: AuditViolation[] = []
    const eventIds = events.map((e) => e.id)

    const recId = (events[0].payload as unknown as Record<string, unknown>).recommendationId as string

    // Build event type timeline
    const typeSequence = events.map((e) => e.type)
    const typeSet = new Set(typeSequence)

    const hasCreated = typeSet.has('guardrail.recommendation.created')
    const hasApprovalReq = typeSet.has('guardrail.recommendation.approval_requested')
    const hasApprovalAcc = typeSet.has('guardrail.recommendation.approval_accepted')
    const hasApprovalRej = typeSet.has('guardrail.recommendation.approval_rejected')
    const hasActivated = typeSet.has('guardrail.config.activated')
    const hasExpired = typeSet.has('guardrail.recommendation.expired')

    // ── Rule 1: Check for INVALID — approval_rejected then activated (without re-request) ──
    if (hasApprovalRej && hasActivated) {
      const rejEvents = events.filter((e) => e.type === 'guardrail.recommendation.approval_rejected')
      const lastRej = rejEvents[rejEvents.length - 1]
      const lastReq = events.filter((e) => e.type === 'guardrail.recommendation.approval_requested').pop()
      // Only flag as INVALID if the last rejection is after the last re-request
      if (!lastReq || lastRej.timestamp > lastReq.timestamp) {
        const actEvent = events.find((e) => e.type === 'guardrail.config.activated')!
        violations.push({
          type: 'BROKEN_CHAIN',
          chainType: 'APPROVAL',
          detail: 'config.activated after approval_rejected without re-request — violates human boundary',
          evidence: {
            eventIds: [lastRej.id, actEvent.id],
            expected: 'No config.activated after approval_rejected without re-request',
            actual: `config.activated at ${actEvent.timestamp} after rejection at ${lastRej.timestamp}`,
          },
        })
      }
    }

    // ── Rule 2: Check ordering — created before approval_requested ──
    if (hasCreated && hasApprovalReq) {
      const createdEvent = events.find((e) => e.type === 'guardrail.recommendation.created')!
      const reqEvent = events.find((e) => e.type === 'guardrail.recommendation.approval_requested')!
      if (reqEvent.timestamp < createdEvent.timestamp) {
        violations.push({
          type: 'CORRELATION_MISMATCH',
          chainType: 'APPROVAL',
          detail: 'approval_requested before recommendation.created — invalid ordering',
          evidence: {
            eventIds: [reqEvent.id, createdEvent.id],
            expected: 'approval_requested timestamp >= created timestamp',
            actual: `approval_requested at ${reqEvent.timestamp} < created at ${createdEvent.timestamp}`,
          },
        })
      }
    }

    // ── Rule 3: Check for orphan activated with recommendationId but no created ──
    if (!hasCreated && hasActivated) {
      violations.push({
        type: 'MISSING_EVENT',
        chainType: 'APPROVAL',
        detail: 'config.activated with recommendationId but no recommendation.created',
        evidence: {
          eventIds: events.filter((e) => e.type === 'guardrail.config.activated').map((e) => e.id),
          expected: 'recommendation.created before config.activated',
          actual: 'No recommendation.created found',
        },
      })
    }

    // ── Determine status ──
    let status: AuditStatus
    let chainType: ChainType = 'APPROVAL'

    if (violations.some((v) => v.type === 'BROKEN_CHAIN' || v.type === 'CORRELATION_MISMATCH')) {
      status = 'INVALID'
    } else if (hasExpired) {
      // Expired chain: created → expired is a complete lifecycle
      chainType = 'EXPIRY'
      if (hasCreated && typeSet.has('guardrail.recommendation.expired')) {
        status = 'COMPLETE'
      } else {
        status = 'COMPLETE'
      }
    } else if (hasCreated && hasApprovalReq && hasApprovalAcc && hasActivated) {
      // Full approval → activation chain
      status = 'COMPLETE'
    } else if (hasCreated && hasApprovalReq && hasApprovalRej) {
      // Rejected chain (normal end)
      status = 'COMPLETE'
    } else if (hasCreated && hasApprovalReq && hasApprovalAcc && !hasActivated) {
      // Accepted but waiting for activation
      status = 'INCOMPLETE'
    } else if (hasCreated && hasApprovalReq) {
      // Requested but no decision yet
      status = 'INCOMPLETE'
    } else if (hasCreated) {
      // Created but no action
      status = 'INCOMPLETE'
    } else {
      // Orphan events (config events without recommendation chain)
      status = 'STALE'
    }

    return {
      chainType,
      chainId: recId ?? '',
      status,
      events: eventIds,
      violations,
    }
  }

  /** 聚合多链状态 */
  private aggregateStatus(chains: AuditChainResult[]): AuditStatus {
    if (chains.length === 0) return 'WARN'

    const statuses = new Set(chains.map((c) => c.status))

    if (statuses.has('INVALID')) return 'INVALID'
    if (statuses.has('INCOMPLETE')) return 'INCOMPLETE'
    if (statuses.has('STALE')) return 'STALE'
    // All COMPLETE or mixed COMPLETE+WARN → COMPLETE
    return 'COMPLETE'
  }
}
