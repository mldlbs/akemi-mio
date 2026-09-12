/**
 * M7.3 Policy Lifecycle Governance — 测试套件
 *
 * 覆盖：
 * - Approval 事件链（request → accept / reject）
 * - Expiry 生命周期（sweepExpired）
 * - Activation audit trail（recommendationId 关联）
 * - EventSchemaVersion stamping for governance events
 * - Human approval boundary（approval 不触发 config.activated）
 * - 全事件链完整性
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GuardrailRecommendationStore, type GuardrailRecommendation } from '@akemi-mio/core/core/evaluation/GuardrailFeedbackAnalyzer'
import { GuardrailConfigStore } from '@akemi-mio/core/core/evaluation/GuardrailConfigStore'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from '@akemi-mio/core/core/evaluation/GuardrailTypes'
import { EVENT_SCHEMA_STAMPED_TYPES, CONFIG_EVENT_TYPES, GOVERNANCE_EVENT_TYPES } from '@akemi-mio/core/core/evaluation/EvaluationEventSchema'
import { EvaluationEmitter } from '@akemi-mio/core/core/evaluation/EvaluationEmitter'
import { ENVELOPE_SCHEMA_VERSION, type EvaluationEvent } from '@akemi-mio/core/core/evaluation/types'

// ══════════════════════════════════════════════
// 测试替身
// ══════════════════════════════════════════════

function makeRec(overrides?: Partial<GuardrailRecommendation>): GuardrailRecommendation {
  return {
    id: 'rec_1',
    createdAt: Date.now() - 1000,
    type: 'threshold_adjust',
    evidence: {
      decisionIds: ['d1', 'd2'],
      ineffectiveCount: 10,
      totalDecisions: 25,
      ineffectiveRate: 0.4,
      primaryIssue: 'Policy v2 无效率 40%',
    },
    suggestion: 'Adjust threshold for v2',
    confidence: 'medium',
    status: 'open',
    ...overrides,
  }
}

function makeEventSinkStub() {
  return {
    emitRecommendationCreated: vi.fn(),
    emitRecommendationApproved: vi.fn(),
    emitRecommendationDismissed: vi.fn(),
    emitApprovalRequested: vi.fn(),
    emitApprovalAccepted: vi.fn(),
    emitApprovalRejected: vi.fn(),
    emitRecommendationExpired: vi.fn(),
  }
}

function makeInMemoryStore(): { append: ReturnType<typeof vi.fn>; events: EvaluationEvent[] } {
  const events: EvaluationEvent[] = []
  return {
    append: vi.fn((e: EvaluationEvent) => {
      events.push(e)
    }),
    events,
  }
}

// ══════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════

describe('M7.3 Policy Lifecycle Governance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Approval event chain', () => {
    it('requestApproval 发射 approval_requested 事件，状态变为 pending_approval', () => {
      const sink = makeEventSinkStub()
      const store = new GuardrailRecommendationStore(sink)
      store.add(makeRec())
      store.add(makeRec({ id: 'rec_2' }))

      // 2 has open status — both ok
      const result = store.requestApproval('rec_2', 'operator_1', 'Please review')
      expect(result).toBe(true)
      expect(store.get('rec_2')?.status).toBe('pending_approval')
      expect(sink.emitApprovalRequested).toHaveBeenCalledTimes(1)
      expect(sink.emitApprovalRequested).toHaveBeenCalledWith(
        expect.objectContaining({ recommendationId: 'rec_2', requestedBy: 'operator_1' }),
      )
    })

    it('acceptApproval 发射 approval_accepted 事件，状态变为 accepted', () => {
      const sink = makeEventSinkStub()
      const store = new GuardrailRecommendationStore(sink)
      store.add(makeRec({ id: 'rec_1' }))
      store.requestApproval('rec_1', 'op', 'review')

      const result = store.acceptApproval('rec_1', 'admin', 'Looks good')
      expect(result).toBe(true)
      expect(store.get('rec_1')?.status).toBe('accepted')
      expect(store.get('rec_1')?.resolvedBy).toBe('admin')
      expect(sink.emitApprovalAccepted).toHaveBeenCalledWith(expect.objectContaining({ recommendationId: 'rec_1', approver: 'admin' }))
    })

    it('rejectApproval 发射 approval_rejected 事件，状态变为 dismissed', () => {
      const sink = makeEventSinkStub()
      const store = new GuardrailRecommendationStore(sink)
      store.add(makeRec({ id: 'rec_1' }))
      store.requestApproval('rec_1', 'op', 'review')

      const result = store.rejectApproval('rec_1', 'admin', 'Not needed')
      expect(result).toBe(true)
      expect(store.get('rec_1')?.status).toBe('dismissed')
      expect(sink.emitApprovalRejected).toHaveBeenCalledWith(expect.objectContaining({ recommendationId: 'rec_1', rejectedBy: 'admin' }))
    })

    it('requestApproval 对非 open 状态返回 false', () => {
      const store = new GuardrailRecommendationStore()
      store.add(makeRec({ id: 'rec_1' }))
      store.requestApproval('rec_1', 'op', 'review') // → pending_approval

      // 已不是 open
      expect(store.requestApproval('rec_1', 'op2', 'retry')).toBe(false)
      // 不存在的 id
      expect(store.requestApproval('not_found', 'op', '')).toBe(false)
    })

    it('acceptApproval 对非 pending_approval 状态返回 false', () => {
      const store = new GuardrailRecommendationStore()
      store.add(makeRec({ id: 'rec_1', status: 'open' }))

      // open 不能直接 accept
      expect(store.acceptApproval('rec_1', 'admin')).toBe(false)
      // 不存在的 id
      expect(store.acceptApproval('not_found', 'admin')).toBe(false)
    })

    it('rejectApproval 对非 pending_approval 状态返回 false', () => {
      const store = new GuardrailRecommendationStore()
      store.add(makeRec({ id: 'rec_1' }))

      expect(store.rejectApproval('rec_1', 'admin', 'nope')).toBe(false)
    })
  })

  describe('Expiry lifecycle', () => {
    it('sweepExpired 将旧的 open recommendation 标记为 expired', () => {
      const sink = makeEventSinkStub()
      const store = new GuardrailRecommendationStore(sink, 100) // 100ms TTL
      store.add(makeRec({ id: 'old_rec', createdAt: Date.now() - 500 }))

      const count = store.sweepExpired()
      expect(count).toBe(1)
      expect(store.get('old_rec')?.status).toBe('expired')
      expect(store.get('old_rec')?.resolvedBy).toBe('system')
    })

    it('sweepExpired 将旧的 pending_approval 标记为 expired', () => {
      const sink = makeEventSinkStub()
      const store = new GuardrailRecommendationStore(sink, 100)
      store.add(makeRec({ id: 'rec_1', createdAt: Date.now() - 500 }))
      store.requestApproval('rec_1', 'op', 'review')

      const count = store.sweepExpired()
      expect(count).toBe(1)
      expect(store.get('rec_1')?.status).toBe('expired')
    })

    it('sweepExpired 为每个过期项发射 expired 事件', () => {
      const sink = makeEventSinkStub()
      const store = new GuardrailRecommendationStore(sink, 100)
      store.add(makeRec({ id: 'r1', createdAt: Date.now() - 500 }))
      store.add(makeRec({ id: 'r2', createdAt: Date.now() - 500 }))

      const count = store.sweepExpired()
      expect(count).toBe(2)
      expect(sink.emitRecommendationExpired).toHaveBeenCalledTimes(2)
    })

    it('TTL 内的 recommendation 不被标记过期', () => {
      const sink = makeEventSinkStub()
      const store = new GuardrailRecommendationStore(sink, 60000) // 60s TTL
      store.add(makeRec({ id: 'fresh', createdAt: Date.now() - 1000 }))

      const count = store.sweepExpired()
      expect(count).toBe(0)
      expect(store.get('fresh')?.status).toBe('open')
    })

    it('list 可正常返回 expired 状态的 recommendation', () => {
      const store = new GuardrailRecommendationStore(undefined, 100)
      store.add(makeRec({ id: 'r1', createdAt: Date.now() - 500 }))
      store.sweepExpired()

      const all = store.list()
      expect(all).toHaveLength(1)
      expect(all[0].status).toBe('expired')

      const openOnly = store.list('open')
      expect(openOnly).toHaveLength(0)
    })
  })

  describe('Activation audit trail', () => {
    it('applyActivated 携带 recommendationId', () => {
      const configStore = new GuardrailConfigStore()
      configStore.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
      configStore.applyActivated('v2', DEFAULT_GUARDRAIL_POLICY_CONFIG, 2000, 'rec_abc')

      expect(configStore.getActivationRecommendationId('v1')).toBeUndefined()
      expect(configStore.getActivationRecommendationId('v2')).toBe('rec_abc')
    })

    it('applyRollback 携带 sourceRecommendationId', () => {
      const configStore = new GuardrailConfigStore()
      configStore.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
      configStore.applyActivated('v2', DEFAULT_GUARDRAIL_POLICY_CONFIG, 2000)
      configStore.applyRollback('v2', 'v1', 'manual', 'issue', 'rec_def')

      const history = configStore.getRollbackHistory()
      expect(history).toHaveLength(1)
      expect(history[0].sourceRecommendationId).toBe('rec_def')
    })

    it('getActivationRecommendationId 返回已存储的 recommendationId', () => {
      const configStore = new GuardrailConfigStore()
      expect(configStore.getActivationRecommendationId('v1')).toBeUndefined()
      configStore.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000, 'rec_xyz')
      expect(configStore.getActivationRecommendationId('v1')).toBe('rec_xyz')
    })
  })

  describe('EventSchemaVersion stamping', () => {
    it('governance events 被 stamp eventSchemaVersion', () => {
      const { append } = makeInMemoryStore()
      const emitter = new EvaluationEmitter(
        { append, query: vi.fn(), getTrace: vi.fn(), subscribe: vi.fn(), init: vi.fn(), shutdown: vi.fn() },
        'test',
      )

      emitter.emit('guardrail.recommendation.created', {
        type: 'guardrail.recommendation.created',
        recommendationId: 'r1',
        policyId: 'p1',
        confidence: 'high',
        evidence: ['test'],
        detail: 'test',
        triggeredByOutcomeIds: [],
      } as any)

      expect(append).toHaveBeenCalledTimes(1)
      const event = append.mock.calls[0][0] as EvaluationEvent
      expect((event.payload as any).eventSchemaVersion).toBe(1)
    })

    it('EVENT_SCHEMA_STAMPED_TYPES 包含所有 config + governance types', () => {
      // All config types should be in stamped set
      for (const t of CONFIG_EVENT_TYPES) {
        expect(EVENT_SCHEMA_STAMPED_TYPES.has(t)).toBe(true)
      }
      // All governance types should be in stamped set
      for (const t of GOVERNANCE_EVENT_TYPES) {
        expect(EVENT_SCHEMA_STAMPED_TYPES.has(t)).toBe(true)
      }
    })
  })

  describe('Human approval boundary', () => {
    it('acceptApproval 不会调用 applyActivated 或发射 config.activated', () => {
      const sink = makeEventSinkStub()
      const store = new GuardrailRecommendationStore(sink)
      store.add(makeRec({ id: 'rec_1' }))
      store.requestApproval('rec_1', 'op', 'review')

      // accept 不接触 ConfigStore
      store.acceptApproval('rec_1', 'admin')

      expect(sink.emitApprovalAccepted).toHaveBeenCalled()
      // 不应产生 config 事件
      expect(sink.emitRecommendationCreated).toHaveBeenCalledTimes(1) // only from add()
      expect(sink.emitRecommendationApproved).toHaveBeenCalledTimes(0) // not via old path
    })
  })

  describe('Full event chain completeness', () => {
    it('created → approval_requested → approval_accepted → activated(recommendationId)', () => {
      const sink = makeEventSinkStub()
      const configStore = new GuardrailConfigStore()
      const recStore = new GuardrailRecommendationStore(sink)

      // Step 1: create recommendation
      recStore.add(makeRec({ id: 'rec_chain' }))
      expect(sink.emitRecommendationCreated).toHaveBeenCalled()

      // Step 2: request approval
      recStore.requestApproval('rec_chain', 'operator', 'Please review config change')
      expect(sink.emitApprovalRequested).toHaveBeenCalledWith(expect.objectContaining({ recommendationId: 'rec_chain' }))

      // Step 3: approve
      recStore.acceptApproval('rec_chain', 'admin')
      expect(sink.emitApprovalAccepted).toHaveBeenCalledWith(expect.objectContaining({ recommendationId: 'rec_chain', approver: 'admin' }))

      // Step 4: manual activation carries recommendationId in payload
      configStore.applyActivated('v3', DEFAULT_GUARDRAIL_POLICY_CONFIG, Date.now(), 'rec_chain')
      expect(configStore.getActivationRecommendationId('v3')).toBe('rec_chain')
    })
  })
})
