/**
 * Integration Test — 全链路：EventBus → Bridge → Store(SQLite) → Iterator → Metrics
 *
 * 验证链路：
 *   EventBus.emit('agent.tool.*')
 *     → ToolEventBridge
 *       → EvaluationEmitter
 *         → EvaluationStore (SQLite, append + flush)
 *           → RepositoryEventIterator
 *             → MetricsEngineImpl.compute()
 *
 * 使用独立的 sql.js 内存数据库，不影响生产数据库。
 *
 * 验证内容：
 * 1. Tool 事件通过 Bridge 完整持久化到 SQLite（type/payload 正确）
 * 2. MetricsEngine 可读取 SQLite 持久化的 model 事件并计算出正确指标
 * 3. Bridge → Emitter → Store → Iterator → Metrics 全链路无断裂
 * 4. shutdown 清理正确
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import initSqlJs from 'sql.js'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from '@akemi-mio/core/db/schema'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { ToolEventBridge } from '@akemi-mio/core/core/evaluation/ToolEventBridge'
import { EvaluationEmitter } from '@akemi-mio/core/core/evaluation/EvaluationEmitter'
import { EvaluationStore } from '@akemi-mio/core/core/evaluation/EvaluationStore'
import { RepositoryEventIterator } from '@akemi-mio/core/core/evaluation/RepositoryEventIterator'
import { MetricsEngineImpl } from '@akemi-mio/core/core/evaluation/MetricsEngine'

/** 创建独立的 sql.js 内存数据库，返回 {sqlite, db, rawDb} */
async function createMemoryDb(): Promise<{
  sqlite: any
  db: ReturnType<typeof drizzle>
  rawDb: { run: (sql: string, params?: any[]) => void; query: (sql: string, params?: any[]) => Record<string, any>[] }
}> {
  const SQL = await initSqlJs()
  const sqlite = new SQL.Database()

  // DDL 与 drizzle schema 一致
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS evaluation_events (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      parent_event_id TEXT
    )
  `)
  sqlite.run('CREATE INDEX IF NOT EXISTS idx_ev_ts ON evaluation_events(timestamp)')
  sqlite.run('CREATE INDEX IF NOT EXISTS idx_ev_type ON evaluation_events(type)')
  sqlite.run('CREATE INDEX IF NOT EXISTS idx_ev_trace ON evaluation_events(trace_id)')

  // Drizzle proxy callback
  async function proxyCallback(sql: string, params: any[], _method: 'run' | 'get' | 'all' | 'values') {
    const converted = sql.replace(/\$\d+/g, '?')
    if (_method === 'run') {
      sqlite.run(converted, params)
      return { rows: [] }
    }
    const stmt = sqlite.prepare(converted)
    stmt.bind(params)
    if (_method === 'get') {
      const row = stmt.step() ? stmt.getAsObject() : null
      stmt.free()
      return { rows: row ? [row] : [] }
    }
    const rows: any[] = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return { rows }
  }

  const db = drizzle(proxyCallback, { schema })

  const rawDb = {
    run: (sql: string, params?: any[]) => sqlite.run(sql, params),
    query: (sql: string, params?: any[]) => {
      const stmt = sqlite.prepare(sql)
      if (params) stmt.bind(params)
      const rows: any[] = []
      while (stmt.step()) rows.push(stmt.getAsObject())
      stmt.free()
      return rows
    },
  }

  return { sqlite, db, rawDb }
}

function resetBus() {
  eventBus.removeAll()
}

describe('Evaluation Full-Chain Integration', () => {
  let sqlite: any
  let store: EvaluationStore
  let emitter: EvaluationEmitter
  let bridge: ToolEventBridge

  beforeEach(async () => {
    resetBus()
    const db = await createMemoryDb()
    sqlite = db.sqlite

    store = new EvaluationStore(db.db as any, db.rawDb)
    await store.init()
    emitter = new EvaluationEmitter(store, 'test-int')
    bridge = new ToolEventBridge(emitter, eventBus)
    bridge.start()
  })

  afterEach(async () => {
    bridge.stop()
    await store.shutdown()
    sqlite.close()
  })

  // ── Chain 1: EventBus → Bridge → Store(SQLite) ──

  it('persists tool.invoked/completed through Bridge into SQLite', async () => {
    eventBus.emit('agent.tool.invoked', { tool: 'read_file', args: { path: '/test.txt' } })
    eventBus.emit('agent.tool.completed', { tool: 'read_file', result: 'file content lines\nline 2\nline 3' })

    await store.forceFlush()

    const rows = sqlite.exec('SELECT type, payload FROM evaluation_events ORDER BY timestamp ASC')
    const allRows = rows[0] ? rows[0].values : []
    expect(allRows.length).toBe(2)

    const [type0, payloadRaw0] = allRows[0]
    const [type1, payloadRaw1] = allRows[1]
    expect(type0).toBe('tool.invoked')
    expect(type1).toBe('tool.completed')

    const invokedPayload = JSON.parse(payloadRaw0)
    expect(invokedPayload.toolName).toBe('read_file')
    expect(invokedPayload.args.path).toBe('/test.txt')

    const completedPayload = JSON.parse(payloadRaw1)
    expect(completedPayload.toolName).toBe('read_file')
    expect(completedPayload.durationMs).toBeGreaterThanOrEqual(0)
    // output 截断到安全长度（5000）
    expect(completedPayload.output.length).toBeLessThanOrEqual(5000)
    expect(completedPayload.output).toContain('file content lines')
  })

  it('persists tool.failed through Bridge into SQLite with error', async () => {
    eventBus.emit('agent.tool.invoked', { tool: 'grep', args: { pattern: 'xyz' } })
    eventBus.emit('agent.tool.failed', { tool: 'grep', error: 'command not found' })

    await store.forceFlush()

    const rows = sqlite.exec('SELECT type, payload FROM evaluation_events ORDER BY timestamp ASC')
    const allRows = rows[0] ? rows[0].values : []
    expect(allRows.length).toBe(2)

    const failedPayload = JSON.parse(allRows[1][1])
    expect(failedPayload.toolName).toBe('grep')
    expect(failedPayload.error).toBe('command not found')
    expect(failedPayload.durationMs).toBeGreaterThanOrEqual(0)
  })

  // ── Chain 2: Store(SQLite) → Iterator → MetricsEngine ──

  it('MetricsEngine reads model events from persisted SQLite and computes correct metrics', async () => {
    // Emit model events directly through Emitter (bypass Bridge, test Store→Iterator→Metrics path)
    const t0 = Date.now()
    emitter.emit('model.invoked', { type: 'model.invoked', modelName: 'deepseek-v4', promptLength: 100, promptTokens: 50 }, {})
    emitter.emit(
      'model.completed',
      {
        type: 'model.completed',
        modelName: 'deepseek-v4',
        durationMs: 500,
        inputTokens: 50,
        outputTokens: 150,
        responseLength: 200,
        responsePreview: 'hello',
      },
      {},
    )
    emitter.emit('model.invoked', { type: 'model.invoked', modelName: 'deepseek-v4', promptLength: 200, promptTokens: 80 }, {})
    emitter.emit(
      'model.completed',
      {
        type: 'model.completed',
        modelName: 'deepseek-v4',
        durationMs: 1200,
        inputTokens: 80,
        outputTokens: 300,
        responseLength: 400,
      },
      {},
    )
    // One failed call
    emitter.emit('model.invoked', { type: 'model.invoked', modelName: 'deepseek-v4', promptLength: 50, promptTokens: 20 }, {})
    emitter.emit(
      'model.completed',
      {
        type: 'model.completed',
        modelName: 'deepseek-v4',
        durationMs: 50,
        inputTokens: 20,
        outputTokens: 0,
        responseLength: 0,
        error: 'TIMEOUT',
      },
      {},
    )
    const t1 = Date.now()

    await store.forceFlush()

    const iterator = new RepositoryEventIterator(store)
    const metrics = new MetricsEngineImpl(iterator)

    const snapshot = await metrics.compute({ since: t0 - 1000, until: t1 + 1000 })

    expect(snapshot.traffic.totalCalls).toBe(3) // 3 invoked
    expect(snapshot.traffic.completedCalls).toBe(2) // 2 success
    expect(snapshot.traffic.failedCalls).toBe(1) // 1 error

    expect(snapshot.quality.completionRate).toBeCloseTo(2 / 3, 2)
    expect(snapshot.quality.avgOutputTokens).toBeCloseTo((150 + 300) / 2, 0)

    expect(snapshot.latency.avgMs).toBeGreaterThanOrEqual(500)
    expect(snapshot.latency.p50Ms).toBeGreaterThanOrEqual(500)
    expect(snapshot.latency.maxMs).toBeGreaterThanOrEqual(1200)

    expect(snapshot.cost.totalInputTokens).toBe(50 + 80 + 20) // includes failed
    expect(snapshot.cost.totalOutputTokens).toBe(150 + 300 + 0) // includes failed
    expect(snapshot.cost.totalTokens).toBe(snapshot.cost.totalInputTokens + snapshot.cost.totalOutputTokens)
  })

  // ── Chain 3: Full combined chain ──

  it('full chain: EventBus → Bridge → Store → Iterator → Metrics with mixed event types', async () => {
    const t0 = Date.now()

    // Tool events via Bridge
    eventBus.emit('agent.tool.invoked', { tool: 'read_file', args: {} })
    eventBus.emit('agent.tool.completed', { tool: 'read_file', result: 'data' })

    // Model events via direct Emitter (model events are the MetricsEngine's domain)
    emitter.emit('model.invoked', { type: 'model.invoked', modelName: 'deepseek-v4', promptLength: 100, promptTokens: 40 }, {})
    emitter.emit(
      'model.completed',
      {
        type: 'model.completed',
        modelName: 'deepseek-v4',
        durationMs: 800,
        inputTokens: 40,
        outputTokens: 200,
        responseLength: 300,
      },
      {},
    )
    const t1 = Date.now()

    await store.forceFlush()

    // Verify both event types coexist in Store
    const allEvents = sqlite.exec('SELECT type FROM evaluation_events ORDER BY timestamp ASC')
    const types = allEvents[0].values.map((r: any) => r[0])
    expect(types).toContain('tool.invoked')
    expect(types).toContain('tool.completed')
    expect(types).toContain('model.invoked')
    expect(types).toContain('model.completed')

    // MetricsEngine correctly filters to model events only
    const iterator = new RepositoryEventIterator(store)
    const metrics = new MetricsEngineImpl(iterator)
    const snapshot = await metrics.compute({ since: t0 - 1000, until: t1 + 1000 })

    expect(snapshot.traffic.totalCalls).toBe(1) // only model.invoked counted
    expect(snapshot.traffic.completedCalls).toBe(1)
    expect(snapshot.quality.completionRate).toBe(1)
    expect(snapshot.latency.avgMs).toBeGreaterThanOrEqual(800)
  })
})
