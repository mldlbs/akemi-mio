/**
 * M6.3 Metrics Query Service — Tests
 *
 * 验证 GuardrailMetricsQueryService 的只读查询和状态语义：
 *
 * M-1:  getSummary 正确映射 Store 数据
 * M-2:  queryTimeRange 正确返回 Store 数据
 * M-3:  getLatest 正确返回 Store 数据
 * M-4:  projectionState READY（notifyReady 后）
 * M-5:  projectionState REBUILDING（notifyBuildStarted 后）
 * M-6:  projectionState UNAVAILABLE（初始状态/无 DB）
 * M-7:  不暴露 mutation endpoint（验证类的公共接口）
 * M-8:  summary 空表返回零值
 * M-9:  queryTimeRange 空范围返回空
 * M-10: getLatest 空表返回 null
 */

import { describe, it, expect } from 'vitest'
import { GuardrailMetricsQueryService, type ProjectionState } from '@akemi-mio/core/core/evaluation/GuardrailMetricsQueryService'
import { GuardrailMetricsStore } from '@akemi-mio/core/core/evaluation/GuardrailMetricsStore'
import { GuardrailMetricsProjection } from '@akemi-mio/core/core/evaluation/GuardrailMetricsProjection'
import type { EvaluationRepository } from '@akemi-mio/core/core/evaluation/types'

// ══════════════════════════════════════════════
// Test helpers
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
    )
  `)
  return db
}

function makeStore(db: any): GuardrailMetricsStore {
  const store = new GuardrailMetricsStore()
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
  return store
}

function makeEmptyRepo(): EvaluationRepository {
  return {
    query: async () => [],
    insert: async () => '',
    get: async () => null,
    update: async () => {},
    delete: async () => {},
    close: async () => {},
  } as any
}

async function seedMetricsRow(db: any, overrides?: Record<string, any>): Promise<void> {
  const row = {
    id: '1000000_1003600',
    window_since: 1000000,
    window_until: 1003600,
    checked_count: 10,
    warning_count: 2,
    terminated_count: 1,
    continue_count: 7,
    total_signals_healthy: 15,
    total_signals_degrading: 3,
    total_signals_stalled: 1,
    updated_at: 2000000,
    ...overrides,
  }
  db.run(
    `INSERT OR REPLACE INTO guardrail_metrics
     (id, window_since, window_until, checked_count, warning_count, terminated_count, continue_count,
      total_signals_healthy, total_signals_degrading, total_signals_stalled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.window_since,
      row.window_until,
      row.checked_count,
      row.warning_count,
      row.terminated_count,
      row.continue_count,
      row.total_signals_healthy,
      row.total_signals_degrading,
      row.total_signals_stalled,
      row.updated_at,
    ],
  )
}

// ══════════════════════════════════════════════
// M-1: getSummary
// ══════════════════════════════════════════════

describe('M-1: getSummary', () => {
  it('返回聚合数据：sum of all windows', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    await seedMetricsRow(db, { id: 'w1', checked_count: 5, warning_count: 1 })
    await seedMetricsRow(db, {
      id: 'w2',
      window_since: 1003600,
      window_until: 1007200,
      checked_count: 3,
      terminated_count: 1,
      warning_count: 0,
      continue_count: 0,
    })

    const summary = await svc.getSummary()
    expect(summary.totalChecked).toBe(8)
    expect(summary.totalWarning).toBe(1)
    expect(summary.totalTerminated).toBe(2)
    expect(summary.totalContinue).toBe(7)
    expect(summary.windowCount).toBe(2)
  })

  it('空表返回全零', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    const summary = await svc.getSummary()
    expect(summary.totalChecked).toBe(0)
    expect(summary.totalWarning).toBe(0)
    expect(summary.totalTerminated).toBe(0)
    expect(summary.totalContinue).toBe(0)
    expect(summary.totalSignalsHealthy).toBe(0)
    expect(summary.totalSignalsDegrading).toBe(0)
    expect(summary.totalSignalsStalled).toBe(0)
    expect(summary.windowCount).toBe(0)
  })
})

// ══════════════════════════════════════════════
// M-2: queryTimeRange
// ══════════════════════════════════════════════

describe('M-2: queryTimeRange', () => {
  it('返回指定时间窗口内的 metrics rows', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    await seedMetricsRow(db, { id: 'w1', window_since: 1000000, window_until: 1003600 })
    await seedMetricsRow(db, { id: 'w2', window_since: 1003600, window_until: 1007200 })

    const rows = await svc.queryTimeRange(1000000, 1007200)
    expect(rows.length).toBe(2)
    expect(rows[0].id).toBe('w1')
    expect(rows[1].id).toBe('w2')
  })

  it('超出范围返回空', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    await seedMetricsRow(db)

    const rows = await svc.queryTimeRange(9999999, 99999999)
    expect(rows).toEqual([])
  })
})

// ══════════════════════════════════════════════
// M-3: getLatest
// ══════════════════════════════════════════════

describe('M-3: getLatest', () => {
  it('返回最新的窗口', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    await seedMetricsRow(db, { id: 'old', window_since: 1000000, updated_at: 1000000 })
    await seedMetricsRow(db, { id: 'new', window_since: 2000000, updated_at: 2000000 })

    const latest = await svc.getLatest()
    expect(latest).not.toBeNull()
    expect(latest!.id).toBe('new')
  })

  it('空表返回 null', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    const latest = await svc.getLatest()
    expect(latest).toBeNull()
  })
})

// ══════════════════════════════════════════════
// M-4: projectionState READY
// ══════════════════════════════════════════════

describe('M-4: projectionState READY', () => {
  it('notifyReady 后返回 READY 状态', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    svc.notifyReady()
    const state = await svc.getProjectionState()
    expect(state.status).toBe('READY')
    if (state.status === 'READY') {
      expect(state.lastBuiltAt).toBeGreaterThan(0)
    }
  })

  it('READY 状态包含 windowCount', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    await seedMetricsRow(db)
    svc.notifyReady()
    // 等待异步 windowCount 更新
    await new Promise((r) => setTimeout(r, 50))
    const state = await svc.getProjectionState()
    expect(state.status).toBe('READY')
    if (state.status === 'READY') {
      expect(state.windowCount).toBe(1)
    }
  })
})

// ══════════════════════════════════════════════
// M-5: projectionState REBUILDING
// ══════════════════════════════════════════════

describe('M-5: projectionState REBUILDING', () => {
  it('notifyBuildStarted 后返回 REBUILDING 状态', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    svc.notifyBuildStarted()
    const state = await svc.getProjectionState()
    expect(state.status).toBe('REBUILDING')
    if (state.status === 'REBUILDING') {
      expect(state.startedAt).toBeGreaterThan(0)
      expect(state.windowsBuilt).toBe(0)
    }
  })

  it('notifyWindowBuilt 递增计数', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    svc.notifyBuildStarted()
    svc.notifyWindowBuilt()
    svc.notifyWindowBuilt()
    svc.notifyWindowBuilt()
    const state = await svc.getProjectionState()
    expect(state.status).toBe('REBUILDING')
    if (state.status === 'REBUILDING') {
      expect(state.windowsBuilt).toBe(3)
    }
  })
})

// ══════════════════════════════════════════════
// M-6: projectionState UNAVAILABLE
// ══════════════════════════════════════════════

describe('M-6: projectionState UNAVAILABLE', () => {
  it('初始状态为 UNAVAILABLE', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    const state = await svc.getProjectionState()
    expect(state.status).toBe('UNAVAILABLE')
    if (state.status === 'UNAVAILABLE') {
      expect(state.reason).toBe('not started')
    }
  })

  it('notifyBuildStarted 后不再是 UNAVAILABLE', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    svc.notifyBuildStarted()
    const state = await svc.getProjectionState()
    expect(state.status).not.toBe('UNAVAILABLE')
  })
})

// ══════════════════════════════════════════════
// M-7: 不暴露 mutation endpoint
// ══════════════════════════════════════════════

describe('M-7: no mutation endpoints', () => {
  it('公共接口不包含 rebuild/clear/upsert', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(svc))
    const methods = proto.filter((m) => typeof (svc as any)[m] === 'function')

    // 只读方法
    expect(methods).toContain('getSummary')
    expect(methods).toContain('queryTimeRange')
    expect(methods).toContain('getLatest')
    expect(methods).toContain('getProjectionState')
    // 状态生命周期钩子
    expect(methods).toContain('notifyBuildStarted')
    expect(methods).toContain('notifyWindowBuilt')
    expect(methods).toContain('notifyReady')

    // 不允许暴露的 mutation
    expect(methods).not.toContain('rebuild')
    expect(methods).not.toContain('clear')
    expect(methods).not.toContain('upsert')
  })
})

// ══════════════════════════════════════════════
// M-8/M-9/M-10: 边界场景
// ══════════════════════════════════════════════

describe('M-8: 数据 API 与状态 API 独立', () => {
  it('数据 API 不携带 projectionState 字段', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    await seedMetricsRow(db)

    const summary = await svc.getSummary()
    expect(summary).not.toHaveProperty('projectionState')
    expect(summary.totalChecked).toBe(10)

    const state = await svc.getProjectionState()
    expect(state).toHaveProperty('status')
  })

  it('状态 API 不包含业务数据', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    svc.notifyReady()
    const state = await svc.getProjectionState()
    expect(state).not.toHaveProperty('totalChecked')
    expect(state).not.toHaveProperty('totalWarning')
  })
})

describe('M-9: queryTimeRange 空范围', () => {
  it('传入相同 since/until 返回空', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    await seedMetricsRow(db)
    const rows = await svc.queryTimeRange(Date.now(), Date.now())
    expect(rows).toEqual([])
  })
})

describe('M-10: getLatest 空表返回 null', () => {
  it('无数据时 getLatest 返回 null', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    expect(await svc.getLatest()).toBeNull()
  })
})

// ══════════════════════════════════════════════
// M-11: IPC Contract 不泄漏内部 Store
// ══════════════════════════════════════════════

describe('M-11: IPC contract boundary', () => {
  it('Service 不暴露 setRawDb 或 raw 属性', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    expect((svc as any).raw).toBeUndefined()
    expect(typeof (svc as any).setRawDb).toBe('undefined')
  })

  it('Service 不接受写入指令', async () => {
    const db = await createTestDb()
    const store = makeStore(db)
    const projection = new GuardrailMetricsProjection(makeEmptyRepo(), store)
    const svc = new GuardrailMetricsQueryService(store, projection)

    // 验证 queryService 没有 store 层面的 mutation 能力
    const before = await svc.getSummary()
    // 通过 projection 写入
    // queryService 本身不应能写入
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(svc))).not.toContain('upsert')
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(svc))).not.toContain('clear')
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(svc))).not.toContain('rebuild')
  })
})
