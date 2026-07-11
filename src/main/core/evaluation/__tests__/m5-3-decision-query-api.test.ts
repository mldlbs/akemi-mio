/**
 * M5.3 Decision Query API — Service Layer Tests
 *
 * 验证 DecisionQueryService 的状态语义和查询路由：
 *   Q-1: getDecision — 正常查询
 *   Q-2: getDecision — 不存在
 *   Q-3: listByTrace — trace 隔离
 *   Q-4: listByTrace — DB failure degraded
 *   Q-5: listRecent — 返回最近 N 条
 *   Q-6: getDecision — store.getDecision 返回 null 时 state = UNAVAILABLE
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DecisionQueryService } from '../DecisionQueryService'
import { GuardrailDecisionStore } from '../GuardrailDecisionStore'
import type { GuardrailDecision, GuardrailAction, RuntimeAction } from '../GuardrailTypes'
import { randomUUID } from 'crypto'

// ══════════════════════════════════════════════
// 测试用 DB 生命周期（sql.js 同步数据库）
// ══════════════════════════════════════════════

async function createTestDb(): Promise<any> {
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.run(`
    CREATE TABLE IF NOT EXISTS guardrail_decisions (
      decision_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      action TEXT NOT NULL,
      runtime_action TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      signals TEXT NOT NULL,
      decided_at INTEGER NOT NULL
    )
  `)
  return db
}

function makeStore(db: any): GuardrailDecisionStore {
  const store = new GuardrailDecisionStore()
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

function makeDecision(overrides?: Partial<GuardrailDecision>): GuardrailDecision {
  return {
    action: 'continue' as GuardrailAction,
    reason: 'test',
    decidedAt: Date.now(),
    traceId: 'm53_trace',
    signals: [],
    snapshot: {} as any,
    policyVersion: 'v1',
    ...overrides,
  }
}

async function insertDecision(
  store: GuardrailDecisionStore,
  decisionId: string,
  decision: GuardrailDecision,
  traceId: string,
  turn: number = 1,
): Promise<void> {
  await store.record(decisionId, decision, 'CONTINUE' as RuntimeAction, traceId, turn)
}

// ══════════════════════════════════════════════
// Q-1: getDecision 正常查询
// ══════════════════════════════════════════════

describe('Q-1: getDecision 正常查询', () => {
  it('已写入的 decision 可通过 getDecision 查询到', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const svc = new DecisionQueryService(store)

    const decisionId = 'q1_d1'
    await insertDecision(store, decisionId, makeDecision({ traceId: 'q1_trace', reason: '正常查询' }), 'q1_trace')

    const result = await svc.getDecision(decisionId)
    expect(result.state).toBe('RECORDED')
    expect(result.record).toBeDefined()
    expect(result.record!.decisionId).toBe(decisionId)
    expect(result.record!.traceId).toBe('q1_trace')
  })

  it('返回的 record 包含完整字段', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const svc = new DecisionQueryService(store)

    const decisionId = 'q1_d2'
    const ts = 1234567890
    const decision = makeDecision({
      action: 'terminate' as GuardrailAction,
      reason: 'stalled',
      decidedAt: ts,
      traceId: 'q1_trace2',
      signals: [{ name: 'progress', status: 'stalled', detail: 'no progress 8 turns' }],
      policyVersion: 'v2',
    })
    await store.record(decisionId, decision, 'TERMINATE' as RuntimeAction, 'q1_trace2', 5)

    const result = await svc.getDecision(decisionId)
    expect(result.state).toBe('RECORDED')
    expect(result.record!.traceId).toBe('q1_trace2')
    expect(result.record!.turn).toBe(5)
    expect(result.record!.action).toBe('terminate')
    expect(result.record!.runtimeAction).toBe('TERMINATE')
    expect(result.record!.policyVersion).toBe('v2')
    expect(result.record!.decidedAt).toBe(ts)
  })
})

// ══════════════════════════════════════════════
// Q-2: getDecision 不存在
// ══════════════════════════════════════════════

describe('Q-2: getDecision 不存在', () => {
  it('未知 decisionId 返回 UNAVAILABLE', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const svc = new DecisionQueryService(store)

    const result = await svc.getDecision('nonexistent_id')
    expect(result.state).toBe('UNAVAILABLE')
    expect(result.record).toBeUndefined()
  })

  it('空 store 返回 UNAVAILABLE', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const svc = new DecisionQueryService(store)

    const result = await svc.getDecision(randomUUID())
    expect(result.state).toBe('UNAVAILABLE')
  })
})

// ══════════════════════════════════════════════
// Q-3: listByTrace trace 隔离
// ══════════════════════════════════════════════

describe('Q-3: listByTrace trace 隔离', () => {
  it('trace A 的 decision 不影响 trace B 的查询', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const svc = new DecisionQueryService(store)

    await insertDecision(store, 'a_d1', makeDecision({ traceId: 'trace_a' }), 'trace_a')
    await insertDecision(store, 'a_d2', makeDecision({ traceId: 'trace_a' }), 'trace_a')
    await insertDecision(store, 'b_d1', makeDecision({ traceId: 'trace_b' }), 'trace_b')

    const traceA = await svc.listByTrace('trace_a')
    const traceB = await svc.listByTrace('trace_b')

    expect(traceA.length).toBe(2)
    expect(traceA.every((r) => r.traceId === 'trace_a')).toBe(true)
    expect(traceB.length).toBe(1)
    expect(traceB[0].traceId).toBe('trace_b')
  })
})

// ══════════════════════════════════════════════
// Q-4: listByTrace DB failure degraded
// ══════════════════════════════════════════════

describe('Q-4: listByTrace DB failure degraded', () => {
  it('DB 不可用时返回空数组（不抛异常）', async () => {
    const store = new GuardrailDecisionStore() // no raw db injected
    const svc = new DecisionQueryService(store)

    const result = await svc.listByTrace('any_trace')
    expect(result).toEqual([])
  })
})

// ══════════════════════════════════════════════
// Q-5: listRecent
// ══════════════════════════════════════════════

describe('Q-5: listRecent', () => {
  it('返回最近 N 条决策', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const svc = new DecisionQueryService(store)

    // insert 3 decisions with ascending timestamps
    const now = Date.now()
    await store.record('r1', makeDecision({ decidedAt: now - 100, traceId: 't1' }), 'CONTINUE' as RuntimeAction, 't1', 1)
    await store.record('r2', makeDecision({ decidedAt: now - 50, traceId: 't2' }), 'WARNING' as RuntimeAction, 't2', 2)
    await store.record('r3', makeDecision({ decidedAt: now, traceId: 't3' }), 'TERMINATE' as RuntimeAction, 't3', 3)

    const recent = await svc.listRecent(2)
    expect(recent.length).toBe(2)
    // DESC order: r3, r2
    expect(recent[0].decisionId).toBe('r3')
    expect(recent[1].decisionId).toBe('r2')
  })

  it('返回精简字段（只含 decisionId/traceId/action/runtimeAction/decidedAt）', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const svc = new DecisionQueryService(store)

    await store.record('s1', makeDecision({ traceId: 't1' }), 'CONTINUE' as RuntimeAction, 't1', 1)

    const recent = await svc.listRecent(1)
    expect(recent.length).toBe(1)
    expect(recent[0]).toHaveProperty('decisionId')
    expect(recent[0]).toHaveProperty('traceId')
    expect(recent[0]).toHaveProperty('action')
    expect(recent[0]).toHaveProperty('runtimeAction')
    expect(recent[0]).toHaveProperty('decidedAt')
    // 不包含 signals/policyVersion/turn
    expect(Object.keys(recent[0]).sort()).toEqual(['action', 'decidedAt', 'decisionId', 'runtimeAction', 'traceId'].sort())
  })
})

// ══════════════════════════════════════════════
// Q-6: getDecision null delegation
// ══════════════════════════════════════════════

describe('Q-6: getDecision null delegation', () => {
  it('store.getDecision 返回 null 时 state = UNAVAILABLE', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const svc = new DecisionQueryService(store)

    const result = await svc.getDecision('not_written_yet')
    expect(result.state).toBe('UNAVAILABLE')
  })

  it('store.getDecision 因 DB 失败返回 null → UNAVAILABLE', async () => {
    const store = new GuardrailDecisionStore() // no raw db
    const svc = new DecisionQueryService(store)

    const result = await svc.getDecision('any_id')
    expect(result.state).toBe('UNAVAILABLE')
  })
})
