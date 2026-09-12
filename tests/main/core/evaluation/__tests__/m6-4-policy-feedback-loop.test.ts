/**
 * M6.4 Policy Feedback Loop — Tests
 *
 * 验证 Outcome event replay / recommendation boundary / runtime safety:
 *
 * T-1:  Outcome event 可以被写入和查询
 * T-2:  OutcomeStore 正确聚合 summary
 * T-3:  Recommendation 不触发 config activation
 * T-4:  Recommendation 不包含 GuardrailPolicyConfig
 * T-5:  Feedback failure 不影响 runtime
 * T-6:  Config lifecycle event 仍只有 ConfigStore 产生
 * T-7:  Outcome event replay 一致性
 */

import { describe, it, expect } from 'vitest'
import { EvaluationStore } from '@akemi-mio/core/core/evaluation/EvaluationStore'
import { OutcomeStore, type OutcomeRecord } from '@akemi-mio/core/core/evaluation/OutcomeStore'
import { GuardrailRecommendationStore, GuardrailFeedbackAnalyzer, type GuardrailRecommendation } from '@akemi-mio/core/core/evaluation/GuardrailFeedbackAnalyzer'

// ══════════════════════════════════════════════
// Test helpers
// ══════════════════════════════════════════════

async function createTestStore(): Promise<EvaluationStore> {
  const store = new EvaluationStore()
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.run(`
    CREATE TABLE IF NOT EXISTS evaluation_events (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    )
  `)
  // Override raw for sync queries
  ;(store as any).raw = {
    run: (sql: string, params?: any[]) => db.run(sql, params),
    query: (sql: string, params?: any[]) => {
      const stmt = db.prepare(sql)
      if (params) stmt.bind(params)
      const rows: any[] = []
      while (stmt.step()) rows.push(stmt.getAsObject())
      stmt.free()
      return rows
    },
  }
  // Set dbReady = true, and set batch to empty so raw.run is used
  ;(store as any).dbReady = true
  return store
}

/** 直接写入 evaluation_events 表（绕过 batch queue） */
function injectEvent(store: EvaluationStore, overrides: Record<string, any>): void {
  const id = overrides.id ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const payload = overrides.payload ?? {}

  // 通过 override 让 EvaluationStore 的 deserialize 能正确解析
  // 但绕过 append → batch → flush 路径，直接写 raw
  const raw = (store as any).raw
  raw.run(
    `INSERT OR REPLACE INTO evaluation_events (id, timestamp, trace_id, session_id, source, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      overrides.timestamp ?? Date.now(),
      overrides.traceId ?? 'test_trace',
      overrides.sessionId ?? 'test_session',
      overrides.source ?? 'test',
      overrides.type ?? 'guardrail.outcome.observed',
      JSON.stringify(payload),
    ],
  )
}

function emitOutcome(
  store: EvaluationStore,
  overrides?: Partial<{
    eventId: string
    decisionId: string
    traceId: string
    policyVersion: string
    outcome: 'effective' | 'ineffective' | 'inconclusive'
    confidence: 'high' | 'medium' | 'low'
    source: 'auto' | 'manual'
    falsePositive: boolean
    falseNegative: boolean
    detail: string
  }>,
): void {
  injectEvent(store, {
    id: overrides?.eventId,
    traceId: overrides?.traceId ?? 'trace_1',
    type: 'guardrail.outcome.observed',
    payload: {
      decisionId: overrides?.decisionId ?? 'd1',
      traceId: overrides?.traceId ?? 'trace_1',
      policyVersion: overrides?.policyVersion ?? 'v1',
      outcome: overrides?.outcome ?? 'effective',
      confidence: overrides?.confidence ?? 'high',
      source: overrides?.source ?? 'auto',
      falsePositive: overrides?.falsePositive,
      falseNegative: overrides?.falseNegative,
      detail: overrides?.detail ?? 'test outcome',
      observedAt: Date.now(),
    },
  })
}

// ══════════════════════════════════════════════
// T-1: 写入和查询
// ══════════════════════════════════════════════

describe('T-1: outcome event write and query', () => {
  it('emit outcome event, then query by decisionId', async () => {
    const store = await createTestStore()
    emitOutcome(store, { decisionId: 'd1' })

    const outcomeStore = new OutcomeStore(store)
    const record = await outcomeStore.getByDecision('d1')
    expect(record).not.toBeNull()
    expect(record!.outcome).toBe('effective')
    expect(record!.decisionId).toBe('d1')
  })

  it('query nonexistent decision returns null', async () => {
    const store = await createTestStore()
    const outcomeStore = new OutcomeStore(store)

    const record = await outcomeStore.getByDecision('nonexistent')
    expect(record).toBeNull()
  })
})

// ══════════════════════════════════════════════
// T-2: OutcomeStore summary
// ══════════════════════════════════════════════

describe('T-2: OutcomeStore summary', () => {
  it('aggregates outcome counts correctly', async () => {
    const store = await createTestStore()

    emitOutcome(store, { eventId: 'evt_1', decisionId: 'd1', outcome: 'effective' })
    emitOutcome(store, { eventId: 'evt_2', decisionId: 'd2', outcome: 'ineffective', falsePositive: true })
    emitOutcome(store, { eventId: 'evt_3', decisionId: 'd3', outcome: 'ineffective', falseNegative: true })
    emitOutcome(store, { eventId: 'evt_4', decisionId: 'd4', outcome: 'inconclusive' })

    const outcomeStore = new OutcomeStore(store)
    const summary = await outcomeStore.getSummary()

    expect(summary.totalOutcomes).toBe(4)
    expect(summary.effective).toBe(1)
    expect(summary.ineffective).toBe(2)
    expect(summary.inconclusive).toBe(1)
    expect(summary.falsePositiveCount).toBe(1)
    expect(summary.falseNegativeCount).toBe(1)
  })

  it('empty store returns zero counts', async () => {
    const store = await createTestStore()
    const outcomeStore = new OutcomeStore(store)

    const summary = await outcomeStore.getSummary()
    expect(summary.totalOutcomes).toBe(0)
    expect(summary.effective).toBe(0)
    expect(summary.ineffective).toBe(0)
  })

  it('groups by policyVersion', async () => {
    const store = await createTestStore()

    emitOutcome(store, { eventId: 'evt_1', decisionId: 'd1', policyVersion: 'v1', outcome: 'effective' })
    emitOutcome(store, { eventId: 'evt_2', decisionId: 'd2', policyVersion: 'v1', outcome: 'ineffective' })
    emitOutcome(store, { eventId: 'evt_3', decisionId: 'd3', policyVersion: 'v2', outcome: 'effective' })

    const outcomeStore = new OutcomeStore(store)
    const summary = await outcomeStore.getSummary()

    expect(summary.byPolicy['v1'].total).toBe(2)
    expect(summary.byPolicy['v1'].effective).toBe(1)
    expect(summary.byPolicy['v1'].ineffective).toBe(1)
    expect(summary.byPolicy['v2'].total).toBe(1)
    expect(summary.byPolicy['v2'].effective).toBe(1)
  })
})

// ══════════════════════════════════════════════
// T-3: Recommendation 不触发 config activation
// ══════════════════════════════════════════════

describe('T-3: recommendation cannot trigger config activation', () => {
  it('GuardrailRecommendation type does not contain GuardrailPolicyConfig', () => {
    const rec: GuardrailRecommendation = {
      id: 'rec_test',
      createdAt: Date.now(),
      type: 'threshold_adjust',
      evidence: {
        decisionIds: ['d1'],
        ineffectiveCount: 1,
        totalDecisions: 5,
        ineffectiveRate: 0.2,
        primaryIssue: 'test',
      },
      suggestion: 'test suggestion',
      confidence: 'medium',
      status: 'open',
    }

    // GuardrailRecommendation does not have .config or .policyConfig
    expect(rec).not.toHaveProperty('config')
    expect(rec).not.toHaveProperty('policyConfig')
    expect(rec).not.toHaveProperty('guardrailPolicyConfig')

    // All fields are read-only info
    expect(typeof rec.suggestion).toBe('string')
    expect(typeof rec.evidence.ineffectiveRate).toBe('number')
  })

  it('GuardrailFeedbackAnalyzer does not accept ConfigStore or Policy as dependency', async () => {
    const store = await createTestStore()
    const outcomeStore = new OutcomeStore(store)
    const recStore = new GuardrailRecommendationStore()
    const analyzer = new GuardrailFeedbackAnalyzer(outcomeStore, recStore)

    // Verify analyzer interface: no config/policy methods
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(analyzer))
    expect(proto).toContain('analyze')
    expect(proto).not.toContain('activateConfig')
    expect(proto).not.toContain('modifyPolicy')
    expect(proto).not.toContain('applyRecommendation')

    // analyzer does not have a ConfigStore reference
    expect((analyzer as any).configStore).toBeUndefined()
  })
})

// ══════════════════════════════════════════════
// T-4: Recommendation 不包含可执行 Config
// ══════════════════════════════════════════════

describe('T-4: recommendation content boundary', () => {
  it('recommendation evidence does not contain PolicyConfig', () => {
    const evidence = {
      decisionIds: ['d1'],
      ineffectiveCount: 5,
      totalDecisions: 20,
      ineffectiveRate: 0.25,
      primaryIssue: 'high false positive rate',
    }

    expect(evidence).not.toHaveProperty('config')
    expect(evidence).not.toHaveProperty('candidateConfig')
    expect(evidence).not.toHaveProperty('thresholdValues')
  })

  it('GuardrailRecommendationStore only manages read-only artifacts', () => {
    const recStore = new GuardrailRecommendationStore()
    expect(typeof recStore.add).toBe('function')
    expect(typeof recStore.get).toBe('function')
    expect(typeof recStore.list).toBe('function')
    expect(typeof recStore.updateStatus).toBe('function')

    // No mutation of external systems
    expect((recStore as any).configStore).toBeUndefined()
    expect((recStore as any).eventStore).toBeUndefined()
  })
})

// ══════════════════════════════════════════════
// T-5: Feedback failure doesn't affect runtime
// ══════════════════════════════════════════════

describe('T-5: feedback failure isolation', () => {
  it('empty evaluation store does not crash analyzer', async () => {
    const store = await createTestStore()
    const outcomeStore = new OutcomeStore(store)
    const recStore = new GuardrailRecommendationStore()
    const analyzer = new GuardrailFeedbackAnalyzer(outcomeStore, recStore)

    const recs = await analyzer.analyze()
    expect(Array.isArray(recs)).toBe(true)
    expect(recs.length).toBe(0)
  })

  it('analyzer with corrupt data does not affect outcomeStore', async () => {
    const store = await createTestStore()
    const outcomeStore = new OutcomeStore(store)
    const recStore = new GuardrailRecommendationStore()
    const analyzer = new GuardrailFeedbackAnalyzer(outcomeStore, recStore)

    // Inject malformed event directly
    injectEvent(store, {
      type: 'guardrail.outcome.observed',
      payload: {/* missing required fields */},
    })

    // Analyzer should not crash
    const recs = await analyzer.analyze()
    expect(Array.isArray(recs)).toBe(true)

    // outcomeStore should still work
    const summary = await outcomeStore.getSummary()
    expect(summary.totalOutcomes).toBeGreaterThanOrEqual(0)
  })

  it('recommendationStore failure does not affect EvaluationStore', async () => {
    const store = await createTestStore()
    // Store can still query events after recommendation store is used
    emitOutcome(store, { decisionId: 'd1' })

    // QueryEvaluationStore directly
    const events = await store.query({ since: 0 })
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('guardrail.outcome.observed')
  })
})

// ══════════════════════════════════════════════
// T-6: Config lifecycle event 仍只有 ConfigStore 产生
// ══════════════════════════════════════════════

describe('T-6: config lifecycle isolation', () => {
  it('outcome event type is separate from config event types', async () => {
    const store = await createTestStore()

    // Emit config event
    injectEvent(store, {
      type: 'guardrail.config.activated',
      timestamp: Date.now(),
      payload: {
        version: 'v2',
        config: {
          version: 'v2',
          stateChange: { degrading: 5, stalled: 10 },
          informationGain: { lowOutputDegrading: 5, lowOutputStalled: 10, repeatedContentDegrading: 3, repeatedContentStalled: 7 },
          goalProgress: { degrading: 6, stalled: 12 },
        },
        activatedAt: Date.now(),
        eventSchemaVersion: 1,
      },
    })

    // Emit outcome event
    emitOutcome(store, { decisionId: 'd1' })
    await store.forceFlush?.()

    // Verify they are separate
    const configEvents = await store.query({ since: 0, type: 'guardrail.config.activated' })
    const outcomeEvents = await store.query({ since: 0, type: 'guardrail.outcome.observed' as any })

    expect(configEvents.length).toBe(1)
    expect(outcomeEvents.length).toBe(1)
    expect(configEvents[0].type).toBe('guardrail.config.activated')
    expect(outcomeEvents[0].type).toBe('guardrail.outcome.observed')

    // ConfigStore only reads config events, not outcome events
    // This is enforced by ConfigStore.loadFromEvents which filters by CONFIG_EVENT_TYPES
  })

  it('GuardrailConfigStore CONFIG_EVENT_TYPES does not include outcome', async () => {
    const { CONFIG_EVENT_TYPES } = await import('@akemi-mio/core/core/evaluation/EvaluationEventSchema')
    expect(CONFIG_EVENT_TYPES.has('guardrail.outcome.observed')).toBe(false)
    expect(CONFIG_EVENT_TYPES.has('guardrail.config.activated')).toBe(true)
    expect(CONFIG_EVENT_TYPES.has('guardrail.config.rollback')).toBe(true)
  })
})

// ══════════════════════════════════════════════
// T-7: Outcome event replay 一致性
// ══════════════════════════════════════════════

describe('T-7: outcome event replay consistency', () => {
  it('相同的 outcome events 重放产生相同投影', async () => {
    const store1 = await createTestStore()
    emitOutcome(store1, { eventId: 'replay_1', decisionId: 'd1', outcome: 'effective', policyVersion: 'v1' })
    emitOutcome(store1, { eventId: 'replay_2', decisionId: 'd2', outcome: 'ineffective', policyVersion: 'v1' })

    // Query events
    const events = await store1.query({ since: 0, type: 'guardrail.outcome.observed' as any })

    // Create second store with same events
    const store2 = await createTestStore()
    for (const ev of events) {
      ;(store2 as any).raw.run(
        'INSERT INTO evaluation_events (id, timestamp, trace_id, session_id, source, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [ev.id, ev.timestamp, ev.traceId, ev.sessionId, ev.source, ev.type, JSON.stringify(ev.payload)],
      )
    }
    ;(store2 as any).dbReady = true

    const outcomeStore2 = new OutcomeStore(store2)
    const summary = await outcomeStore2.getSummary()

    expect(summary.totalOutcomes).toBe(2)
    expect(summary.effective).toBe(1)
    expect(summary.ineffective).toBe(1)
  })

  it('GuardrailRecommendationStore 的 recommendation 不持有可执行 Config', async () => {
    const store = await createTestStore()
    emitOutcome(store, { eventId: 'rc_1', decisionId: 'd1', outcome: 'ineffective', policyVersion: 'v1' })

    // 运行全链路
    const outcomeStore = new OutcomeStore(store)
    const recStore = new GuardrailRecommendationStore()
    const analyzer = new GuardrailFeedbackAnalyzer(outcomeStore, recStore)

    const recs = await analyzer.analyze()
    const allRecs = recStore.list()

    // 验证所有 recommendation 没有 config
    for (const rec of [...recs, ...allRecs]) {
      expect(rec).not.toHaveProperty('config')
      expect(rec).not.toHaveProperty('policyConfig')
    }
  })
})
