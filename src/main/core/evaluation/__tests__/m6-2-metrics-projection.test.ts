/**
 * M6.2 Metrics Projection — Tests
 *
 * 覆盖：
 *   M-1~M-4:  Metrics computation + signal normalization
 *   M-5~M-7:  Idempotent update / build / rebuild
 *   M-8~M-9:  Historical compatibility
 *   M-10~M-12: Store queries
 */

import { describe, it, expect } from 'vitest'
import { GuardrailMetricsProjection, normalizeSignals, windowKey } from '../GuardrailMetricsProjection'
import { GuardrailMetricsStore } from '../GuardrailMetricsStore'
import type { EvaluationEvent, EventType } from '../types'
import type { SignalState, GuardrailAction } from '../GuardrailTypes'

// ══════════════════════════════════════════════
// Test DB
// ══════════════════════════════════════════════

async function createTestDb(): Promise<any> {
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.run(`
    CREATE TABLE IF NOT EXISTS guardrail_metrics (
      id TEXT PRIMARY KEY,
      window_since INTEGER NOT NULL,
      window_until INTEGER NOT NULL,
      checked_count INTEGER NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0,
      terminated_count INTEGER NOT NULL DEFAULT 0,
      continue_count INTEGER NOT NULL DEFAULT 0,
      total_signals_healthy INTEGER NOT NULL DEFAULT 0,
      total_signals_degrading INTEGER NOT NULL DEFAULT 0,
      total_signals_stalled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gm_window ON guardrail_metrics(window_since, window_until);
  `)
  return db
}

function makeStore(db: any): GuardrailMetricsStore {
  const store = new GuardrailMetricsStore()
  store.setRawDb({
    run: (sql: string, params?: any[]) => db.run(sql, params),
    query: (sql: string, params?: any[]) => {
      const stmt = db.prepare(sql)
      if (params) stmt.bind(params)
      const rows: any[] = []
      while (stmt.step()) rows.push(stmt.getAsObject())
      stmt.free()
      return rows
    },
  })
  return store
}

// ══════════════════════════════════════════════
// Event factories
// ══════════════════════════════════════════════

let evId = 0
function makeCheckedEvent(ts: number, decision: string, signals?: SignalState[]): EvaluationEvent {
  evId++
  return {
    id: `m6_check_${evId}`,
    timestamp: ts,
    traceId: 'm6_trace',
    sessionId: 'm6_session',
    source: 'test',
    type: 'guardrail.checked' as any,
    payload: { type: 'guardrail.checked', turn: 1, decision, reason: 'test', signals },
  }
}

function makeTerminatedEvent(ts: number): EvaluationEvent {
  evId++
  return {
    id: `m6_term_${evId}`,
    timestamp: ts,
    traceId: 'm6_trace',
    sessionId: 'm6_session',
    source: 'test',
    type: 'guardrail.terminated' as any,
    payload: { type: 'guardrail.terminated', turn: 10, totalTurns: 10, reason: 'stalled' },
  }
}

function makeOldCheckedEvent(ts: number, decision: string): EvaluationEvent {
  evId++
  return {
    id: `m6_old_${evId}`,
    timestamp: ts,
    traceId: 'm6_trace',
    sessionId: 'm6_session',
    source: 'test',
    type: 'guardrail.checked' as any,
    payload: { type: 'guardrail.checked', turn: 1, decision, reason: 'legacy' },
    // no signals
  }
}

// ══════════════════════════════════════════════
// M-1~M-4: Metrics computation
// ══════════════════════════════════════════════

describe('M-1~M-4: Metrics computation', () => {
  it('M-1: empty events → all counts 0', () => {
    const projection = new GuardrailMetricsProjection(null as any, null as any)
    const row = projection.compute([], 1000, 2000)
    expect(row.checkedCount).toBe(0)
    expect(row.warningCount).toBe(0)
    expect(row.terminatedCount).toBe(0)
    expect(row.continueCount).toBe(0)
    expect(row.totalSignalsHealthy).toBe(0)
    expect(row.totalSignalsDegrading).toBe(0)
    expect(row.totalSignalsStalled).toBe(0)
    expect(row.id).toBe('1000_2000')
  })

  it('M-2: 5 checked + 1 terminated → correct counts', () => {
    const projection = new GuardrailMetricsProjection(null as any, null as any)
    const events = [
      makeCheckedEvent(1000, 'continue'),
      makeCheckedEvent(1100, 'continue'),
      makeCheckedEvent(1200, 'warning'),
      makeCheckedEvent(1300, 'warning'),
      makeCheckedEvent(1400, 'terminate'),
      makeTerminatedEvent(1500),
    ]

    const row = projection.compute(events, 1000, 2000)
    expect(row.checkedCount).toBe(5)
    expect(row.warningCount).toBe(2)
    expect(row.terminatedCount).toBe(2)
    expect(row.continueCount).toBe(2)
  })

  it('M-3: signal normalization — 3 SignalState → NormalizedSignals', () => {
    const signals: SignalState[] = [
      { name: 'state_change', status: 'healthy', detail: 'ok' },
      { name: 'information_gain', status: 'degrading', detail: 'low output' },
      { name: 'goal_progress', status: 'stalled', detail: 'stuck' },
    ]

    const ns = normalizeSignals(signals)
    expect(ns.stateChange).toBe('healthy')
    expect(ns.informationGain).toBe('degrading')
    expect(ns.goalProgress).toBe('stalled')
  })

  it('M-3b: compute uses NormalizedSignals correctly', () => {
    const projection = new GuardrailMetricsProjection(null as any, null as any)
    const signals: SignalState[] = [
      { name: 'state_change', status: 'degrading', detail: 'no change' },
      { name: 'goal_progress', status: 'stalled', detail: 'stuck' },
    ]
    const events = [
      makeCheckedEvent(1000, 'warning', signals),
      makeCheckedEvent(1100, 'continue', [{ name: 'information_gain', status: 'healthy', detail: 'ok' }]),
    ]

    const row = projection.compute(events, 1000, 2000)
    expect(row.checkedCount).toBe(2)
    // Event 1: degrading (state_change) + stalled (goal_progress) = 1 degrading + 1 stalled
    // Event 2: healthy (information_gain) = 1 healthy
    expect(row.totalSignalsHealthy).toBe(1)
    expect(row.totalSignalsDegrading).toBe(1)
    expect(row.totalSignalsStalled).toBe(1)
  })

  it('M-4: null/undefined signals → signal metrics 0', () => {
    const projection = new GuardrailMetricsProjection(null as any, null as any)
    const events = [
      makeOldCheckedEvent(1000, 'warning'), // no signals in payload
    ]

    const row = projection.compute(events, 1000, 2000)
    expect(row.checkedCount).toBe(1)
    expect(row.warningCount).toBe(1)
    expect(row.totalSignalsHealthy).toBe(0)
    expect(row.totalSignalsDegrading).toBe(0)
    expect(row.totalSignalsStalled).toBe(0)
  })
})

// ══════════════════════════════════════════════
// Store tests
// ══════════════════════════════════════════════

describe('GuardrailMetricsStore', () => {
  it('M-10: upsert + query by window', async () => {
    const db = await createTestDb()
    const store = makeStore(db)

    await store.upsert({
      id: '1000_2000',
      windowSince: 1000,
      windowUntil: 2000,
      checkedCount: 5,
      warningCount: 2,
      terminatedCount: 1,
      continueCount: 2,
      totalSignalsHealthy: 3,
      totalSignalsDegrading: 1,
      totalSignalsStalled: 0,
      updatedAt: 100,
    })

    const rows = await store.query(0, 10000)
    expect(rows.length).toBe(1)
    expect(rows[0].checkedCount).toBe(5)
    expect(rows[0].warningCount).toBe(2)
  })

  it('M-10b: query respects window boundary', async () => {
    const db = await createTestDb()
    const store = makeStore(db)

    await store.upsert({
      id: '1000_2000',
      windowSince: 1000,
      windowUntil: 2000,
      checkedCount: 10,
      warningCount: 0,
      terminatedCount: 0,
      continueCount: 10,
      totalSignalsHealthy: 0,
      totalSignalsDegrading: 0,
      totalSignalsStalled: 0,
      updatedAt: 100,
    })

    const outside = await store.query(3000, 4000)
    expect(outside.length).toBe(0)
  })

  it('M-11: getLatest', async () => {
    const db = await createTestDb()
    const store = makeStore(db)

    await store.upsert({
      id: 'a',
      windowSince: 100,
      windowUntil: 200,
      checkedCount: 1,
      warningCount: 0,
      terminatedCount: 0,
      continueCount: 1,
      totalSignalsHealthy: 0,
      totalSignalsDegrading: 0,
      totalSignalsStalled: 0,
      updatedAt: 50,
    })
    await store.upsert({
      id: 'b',
      windowSince: 300,
      windowUntil: 400,
      checkedCount: 2,
      warningCount: 1,
      terminatedCount: 0,
      continueCount: 1,
      totalSignalsHealthy: 0,
      totalSignalsDegrading: 0,
      totalSignalsStalled: 0,
      updatedAt: 100,
    })

    const latest = await store.getLatest()
    expect(latest).not.toBeNull()
    expect(latest!.id).toBe('b')
  })

  it('M-12: getSummary', async () => {
    const db = await createTestDb()
    const store = makeStore(db)

    await store.upsert({
      id: 'w1',
      windowSince: 1000,
      windowUntil: 2000,
      checkedCount: 5,
      warningCount: 2,
      terminatedCount: 1,
      continueCount: 2,
      totalSignalsHealthy: 3,
      totalSignalsDegrading: 1,
      totalSignalsStalled: 0,
      updatedAt: 100,
    })
    await store.upsert({
      id: 'w2',
      windowSince: 2000,
      windowUntil: 3000,
      checkedCount: 3,
      warningCount: 1,
      terminatedCount: 0,
      continueCount: 2,
      totalSignalsHealthy: 2,
      totalSignalsDegrading: 0,
      totalSignalsStalled: 1,
      updatedAt: 200,
    })

    const summary = await store.getSummary()
    expect(summary.totalChecked).toBe(8)
    expect(summary.totalWarning).toBe(3)
    expect(summary.totalTerminated).toBe(1)
    expect(summary.totalContinue).toBe(4)
    expect(summary.totalSignalsHealthy).toBe(5)
    expect(summary.totalSignalsDegrading).toBe(1)
    expect(summary.totalSignalsStalled).toBe(1)
    expect(summary.windowCount).toBe(2)
  })
})

// ══════════════════════════════════════════════
// M-5~M-7: Build / Rebuild / Idempotency
// ══════════════════════════════════════════════

describe('M-5~M-7: Build / Rebuild / Idempotency', () => {
  class TestEventStore {
    events: EvaluationEvent[] = []

    append(ev: EvaluationEvent): void {
      this.events.push(ev)
    }

    async query(range: { since: number; until?: number }): Promise<EvaluationEvent[]> {
      return this.events.filter((e) => {
        if (e.timestamp < range.since) return false
        if (range.until && e.timestamp > range.until) return false
        return true
      })
    }
  }

  it('M-5: build() from timestamp computes correct rows', async () => {
    const db = await createTestDb()
    const eventStore = new TestEventStore()
    const metricsStore = makeStore(db)

    eventStore.append(makeCheckedEvent(5000, 'continue'))
    eventStore.append(makeCheckedEvent(3700000, 'warning')) // next hour window
    eventStore.append(makeCheckedEvent(3700100, 'terminate'))

    const projection = new GuardrailMetricsProjection(eventStore as any, metricsStore)
    await projection.build(0)

    const rows = await metricsStore.query(0, 10000000)
    expect(rows.length).toBe(2) // two hourly windows

    const firstRow = rows.find((r) => r.windowSince === 3600000)
    expect(firstRow).toBeDefined()
    expect(firstRow!.checkedCount).toBe(2)
    expect(firstRow!.warningCount).toBe(1)
    expect(firstRow!.terminatedCount).toBe(1)
  })

  it('M-6: rebuild() clears and rescans', async () => {
    const db = await createTestDb()
    const eventStore = new TestEventStore()
    const metricsStore = makeStore(db)

    eventStore.append(makeCheckedEvent(5000, 'continue'))
    eventStore.append(makeCheckedEvent(6000, 'warning'))

    const projection = new GuardrailMetricsProjection(eventStore as any, metricsStore)
    await projection.build(0)
    expect((await metricsStore.getSummary()).totalChecked).toBe(2)

    // Add more events and rebuild
    eventStore.append(makeCheckedEvent(7000, 'terminate'))
    await projection.rebuild()
    expect((await metricsStore.getSummary()).totalChecked).toBe(3)
  })

  it('M-7: same events twice → upsert idempotent (row unchanged)', async () => {
    const db = await createTestDb()
    const eventStore = new TestEventStore()
    const metricsStore = makeStore(db)

    eventStore.append(makeCheckedEvent(5000, 'continue'))

    const projection = new GuardrailMetricsProjection(eventStore as any, metricsStore)
    await projection.build(0)
    const afterFirst = await metricsStore.getSummary()

    // build again with same data
    await projection.build(0)
    const afterSecond = await metricsStore.getSummary()

    expect(afterSecond.totalChecked).toBe(afterFirst.totalChecked)
    expect(afterSecond.windowCount).toBe(afterFirst.windowCount)
  })
})

// ══════════════════════════════════════════════
// M-8~M-9: Historical compatibility
// ══════════════════════════════════════════════

describe('M-8~M-9: Historical compatibility', () => {
  it('M-8: old guardrail.checked (no signals) → signal metrics all 0', () => {
    const projection = new GuardrailMetricsProjection(null as any, null as any)

    const events = [makeOldCheckedEvent(1000, 'warning'), makeOldCheckedEvent(1100, 'continue')]

    const row = projection.compute(events, 1000, 2000)
    expect(row.checkedCount).toBe(2)
    expect(row.totalSignalsHealthy).toBe(0)
    expect(row.totalSignalsDegrading).toBe(0)
    expect(row.totalSignalsStalled).toBe(0)
  })

  it('M-9: old + new events mixed → counts correct, new contribute signal metrics', () => {
    const projection = new GuardrailMetricsProjection(null as any, null as any)

    // old events (no signals)
    const old1 = makeOldCheckedEvent(1000, 'continue')
    const old2 = makeOldCheckedEvent(1100, 'warning')

    // new event (with signals)
    const new1 = makeCheckedEvent(1200, 'terminate', [
      { name: 'state_change', status: 'stalled', detail: '8 turns' },
      { name: 'goal_progress', status: 'stalled', detail: 'stuck' },
    ])

    const events = [old1, old2, new1]
    const row = projection.compute(events, 1000, 2000)

    expect(row.checkedCount).toBe(3)
    expect(row.warningCount).toBe(1)
    expect(row.terminatedCount).toBe(1)
    expect(row.continueCount).toBe(1)
    // Only new1 contributes signals: 2 stalled
    expect(row.totalSignalsHealthy).toBe(0)
    expect(row.totalSignalsDegrading).toBe(0)
    expect(row.totalSignalsStalled).toBe(2)
  })
})

// ══════════════════════════════════════════════
// Edge: windowKey helper
// ══════════════════════════════════════════════

describe('Window helpers', () => {
  it('windowKey returns correct hour boundary', () => {
    // timestamp 0 → hour [0, 3600000)
    expect(windowKey(0)).toBe('0_3600000')
    expect(windowKey(3599999)).toBe('0_3600000')
    expect(windowKey(3600000)).toBe('3600000_7200000')
  })

  it('windowKey with middle-of-hour timestamp', () => {
    // 5000000ms = ~1h 23min 20sec → hour [3600000, 7200000)
    expect(windowKey(5000000)).toBe('3600000_7200000')
  })
})
