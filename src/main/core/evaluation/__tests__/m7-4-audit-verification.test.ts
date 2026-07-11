/**
 * M7.4 Audit Verification — 测试套件
 *
 * 覆盖：
 * - verifyChain: 按 recommendationId 追溯整条链
 * - verifyWindow: 按时间窗口批量审计
 * - 链状态判定: COMPLETE / INCOMPLETE / INVALID / STALE / WARN
 * - 违规检测: MISSING_EVENT / BROKEN_CHAIN / CORRELATION_MISMATCH
 * - 只读约束: 不调用 Store/Projection
 */
import { describe, it, expect, vi } from 'vitest'
import { AuditVerifier, type AuditOptions } from '../AuditVerifier'
import type { EvaluationEvent, EvaluationRepository } from '../types'

// ══════════════════════════════════════════════
// 测试辅助
// ══════════════════════════════════════════════

let eventSeq = 0

function makeEvent(type: string, payload: Record<string, unknown>, ts?: number): EvaluationEvent {
  eventSeq++
  return {
    id: `ev_${eventSeq}`,
    schemaVersion: 1,
    timestamp: ts ?? Date.now() + eventSeq,
    traceId: '',
    sessionId: 'test',
    source: 'test',
    type: type as any,
    payload: { type, ...payload } as any,
  }
}

function makeRecCreated(recId: string, ts?: number): EvaluationEvent {
  return makeEvent('guardrail.recommendation.created', { recommendationId: recId, policyId: 'v2', triggeredByOutcomeIds: ['o1'] }, ts)
}

function makeApprovalRequested(recId: string, ts?: number): EvaluationEvent {
  return makeEvent(
    'guardrail.recommendation.approval_requested',
    { recommendationId: recId, policyId: 'v2', requestedBy: 'op', reason: 'review', requestedAt: ts ?? Date.now() },
    ts,
  )
}

function makeApprovalAccepted(recId: string, ts?: number): EvaluationEvent {
  return makeEvent(
    'guardrail.recommendation.approval_accepted',
    { recommendationId: recId, policyId: 'v2', approver: 'admin', decidedAt: ts ?? Date.now() },
    ts,
  )
}

function makeApprovalRejected(recId: string, ts?: number): EvaluationEvent {
  return makeEvent(
    'guardrail.recommendation.approval_rejected',
    { recommendationId: recId, policyId: 'v2', rejectedBy: 'admin', reason: 'not needed', decidedAt: ts ?? Date.now() },
    ts,
  )
}

function makeActivated(recId: string, ts?: number): EvaluationEvent {
  return makeEvent(
    'guardrail.config.activated',
    { version: 'v3', eventSchemaVersion: 1, config: {}, activatedAt: ts ?? Date.now(), recommendationId: recId },
    ts,
  )
}

function makeExpired(recId: string, ts?: number): EvaluationEvent {
  return makeEvent(
    'guardrail.recommendation.expired',
    { recommendationId: recId, policyId: 'v2', reason: 'TTL expired', expiredAt: ts ?? Date.now() },
    ts,
  )
}

function stubEventStore(events: EvaluationEvent[]): EvaluationRepository {
  return {
    query: vi.fn().mockResolvedValue(events),
    append: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    getTrace: vi.fn(),
  }
}

// ══════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════

describe('AuditVerifier.verifyChain()', () => {
  it('完整链: created → approval_requested → approval_accepted → config.activated → COMPLETE', async () => {
    const now = Date.now()
    const events = [
      makeRecCreated('rec_1', now),
      makeApprovalRequested('rec_1', now + 1000),
      makeApprovalAccepted('rec_1', now + 2000),
      makeActivated('rec_1', now + 3000),
    ]
    const verifier = new AuditVerifier(stubEventStore(events))

    const result = await verifier.verifyChain('rec_1')

    expect(result.status).toBe('COMPLETE')
    expect(result.chainType).toBe('APPROVAL')
    expect(result.events).toHaveLength(4)
    expect(result.violations).toHaveLength(0)
  })

  it('缺 config.activated: approval_accepted 无 activated → INCOMPLETE', async () => {
    const now = Date.now()
    const events = [makeRecCreated('rec_2', now), makeApprovalRequested('rec_2', now + 1000), makeApprovalAccepted('rec_2', now + 2000)]
    const verifier = new AuditVerifier(stubEventStore(events))

    const result = await verifier.verifyChain('rec_2')

    expect(result.status).toBe('INCOMPLETE')
  })

  it('被驳回: approval_rejected 后无 activated → COMPLETE', async () => {
    const now = Date.now()
    const events = [makeRecCreated('rec_3', now), makeApprovalRequested('rec_3', now + 1000), makeApprovalRejected('rec_3', now + 2000)]
    const verifier = new AuditVerifier(stubEventStore(events))

    const result = await verifier.verifyChain('rec_3')

    expect(result.status).toBe('COMPLETE')
  })

  it('违规: approval_rejected 后有 activated(recommendationId) → INVALID', async () => {
    const now = Date.now()
    const events = [
      makeRecCreated('rec_4', now),
      makeApprovalRequested('rec_4', now + 1000),
      makeApprovalRejected('rec_4', now + 2000),
      // Violation: activated after rejected, broken human boundary
      makeActivated('rec_4', now + 3000),
    ]
    const verifier = new AuditVerifier(stubEventStore(events))

    const result = await verifier.verifyChain('rec_4')

    expect(result.status).toBe('INVALID')
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].type).toBe('BROKEN_CHAIN')
  })

  it('过期: created → expired → COMPLETE', async () => {
    const now = Date.now()
    const events = [makeRecCreated('rec_5', now), makeExpired('rec_5', now + 1000)]
    const verifier = new AuditVerifier(stubEventStore(events))

    const result = await verifier.verifyChain('rec_5')

    expect(result.status).toBe('COMPLETE')
    expect(result.chainType).toBe('EXPIRY')
  })

  it('空链: 不存在的 recommendationId → 返回空链 WARN', async () => {
    const events = [makeRecCreated('rec_other', Date.now())]
    const verifier = new AuditVerifier(stubEventStore(events))

    const result = await verifier.verifyChain('not_found')

    expect(result.status).toBe('WARN')
    expect(result.events).toHaveLength(0)
    expect(result.violations).toHaveLength(0)
  })

  it('approval_requested 时间早于 recommendation.created → INVALID', async () => {
    const now = Date.now()
    const events = [
      // Inverted order: requested before created
      makeApprovalRequested('rec_bad', now),
      makeRecCreated('rec_bad', now + 1000),
    ]
    const verifier = new AuditVerifier(stubEventStore(events))

    const result = await verifier.verifyChain('rec_bad')

    expect(result.status).toBe('INVALID')
    expect(result.violations[0].type).toBe('CORRELATION_MISMATCH')
  })
})

describe('AuditVerifier.verifyWindow()', () => {
  it('无 governance events → WARN', async () => {
    const verifier = new AuditVerifier(stubEventStore([]))

    const result = await verifier.verifyWindow(0, Date.now())

    expect(result.status).toBe('WARN')
    expect(result.chains).toHaveLength(0)
    expect(result.eventCount).toBe(0)
  })

  it('多链混合验证 → 各自 correct', async () => {
    const now = Date.now()
    const events = [
      // Chain 1: complete
      makeRecCreated('rec_a', now),
      makeApprovalRequested('rec_a', now + 100),
      makeApprovalAccepted('rec_a', now + 200),
      makeActivated('rec_a', now + 300),
      // Chain 2: incomplete (no activated)
      makeRecCreated('rec_b', now + 400),
      makeApprovalRequested('rec_b', now + 500),
      makeApprovalAccepted('rec_b', now + 600),
      // Chain 3: invalid (rejected then activated)
      makeRecCreated('rec_c', now + 700),
      makeApprovalRequested('rec_c', now + 800),
      makeApprovalRejected('rec_c', now + 900),
      makeActivated('rec_c', now + 1000),
    ]
    const verifier = new AuditVerifier(stubEventStore(events))

    const result = await verifier.verifyWindow(now, now + 2000)

    expect(result.chains).toHaveLength(3)
    expect(result.status).toBe('INVALID') // rec_c makes it INVALID

    const chainA = result.chains.find((c) => c.chainId === 'rec_a')!
    expect(chainA.status).toBe('COMPLETE')

    const chainB = result.chains.find((c) => c.chainId === 'rec_b')!
    expect(chainB.status).toBe('INCOMPLETE')

    const chainC = result.chains.find((c) => c.chainId === 'rec_c')!
    expect(chainC.status).toBe('INVALID')
  })
})

describe('AuditVerifier.read-only constraint', () => {
  it('只调用 eventStore.query 不调用任何 Store/Projection 方法', async () => {
    const store = stubEventStore([
      makeRecCreated('rec_ro', Date.now()),
      makeApprovalRequested('rec_ro', Date.now() + 100),
      makeApprovalAccepted('rec_ro', Date.now() + 200),
    ])
    const verifier = new AuditVerifier(store)

    await verifier.verifyAll({ since: 0, until: Date.now() })

    // query is the only read method called
    expect(store.query).toHaveBeenCalled()
    // append should not be called (read-only)
    expect(store.append).not.toHaveBeenCalled()
  })
})

describe('AuditVerifier.correlation validation', () => {
  it('activated 带 recommendationId 但无 recommendation.created → 标记 MISSING_EVENT', async () => {
    const now = Date.now()
    const events = [makeActivated('orphan_rec', now)]
    const verifier = new AuditVerifier(stubEventStore(events))

    const result = await verifier.verifyChain('orphan_rec')

    expect(result.status).toBe('STALE')
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].type).toBe('MISSING_EVENT')
  })
})

describe('AuditVerifier.edge cases', () => {
  it('同 recommendationId 多次审批（rejected → requested → accepted）→ 最后活跃链正确', async () => {
    const now = Date.now()
    const events = [
      makeRecCreated('rec_retry', now),
      makeApprovalRequested('rec_retry', now + 100),
      makeApprovalRejected('rec_retry', now + 200), // First rejection
      // Re-requested
      makeApprovalRequested('rec_retry', now + 300), // Second request
      makeApprovalAccepted('rec_retry', now + 400),
      makeActivated('rec_retry', now + 500),
    ]
    const verifier = new AuditVerifier(stubEventStore(events))

    const result = await verifier.verifyChain('rec_retry')

    // The last active chain (request → accept → activated) is COMPLETE
    expect(result.status).toBe('COMPLETE')
  })
})
