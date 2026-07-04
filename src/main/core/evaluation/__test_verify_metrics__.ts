/**
 * Metrics Engine 端到端验证
 *
 * 验证链路：EvaluationEmitter → EvaluationStore → RepositoryEventIterator → MetricsEngine
 *
 * 运行：npx tsx src/main/core/evaluation/__test_verify_metrics__.ts
 */
import initSqlJs from 'sql.js'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { EvaluationEmitter } from './EvaluationEmitter'
import { EvaluationStore } from './EvaluationStore'
import { MetricsEngineImpl } from './MetricsEngine'
import { RepositoryEventIterator } from './RepositoryEventIterator'
import * as schema from '../../db/schema'

async function main() {
  console.log('\n=== Metrics Engine 端到端验证 ===\n')

  // ── 1. 独立内存数据库 ──
  const SQL = await initSqlJs()
  const sqlite = new SQL.Database()
  sqlite.run('PRAGMA journal_mode = WAL')
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
  const proxyCb = async (sql: string, params: any[], method: 'run' | 'get' | 'all' | 'values') => {
    const converted = sql.replace(/\$\d+/g, '?')
    if (method === 'run') {
      sqlite.run(converted, params)
      return { rows: [] }
    }
    const stmt = sqlite.prepare(converted)
    stmt.bind(params)
    if (method === 'get') {
      const row = stmt.step() ? stmt.getAsObject() : null
      stmt.free()
      return { rows: row ? [row] : [] }
    }
    const rows: any[] = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return { rows }
  }
  const db = drizzle(proxyCb, { schema })

  const store = new EvaluationStore(db as any, rawDb)
  await store.init()
  const emitter = new EvaluationEmitter(store, 'metrics-verify')

  // ── 2. 注入测试事件 ──
  //   2 次成功调用 + 1 次超时
  const sessionId = 'metrics-test-session'
  const t1 = Date.now() - 10000

  const trace1 = randomUUID()
  emitter.emit(
    'model.invoked',
    { type: 'model.invoked', modelName: 'deepseek-chat', promptLength: 100, promptTokens: 200 },
    { traceId: trace1, sessionId },
  )
  emitter.emit(
    'model.completed',
    {
      type: 'model.completed',
      modelName: 'deepseek-chat',
      durationMs: 500,
      inputTokens: 200,
      outputTokens: 300,
      responseLength: 600,
    },
    { traceId: trace1, sessionId },
  )

  const trace2 = randomUUID()
  emitter.emit(
    'model.invoked',
    { type: 'model.invoked', modelName: 'deepseek-chat', promptLength: 150, promptTokens: 350 },
    { traceId: trace2, sessionId },
  )
  emitter.emit(
    'model.completed',
    {
      type: 'model.completed',
      modelName: 'deepseek-chat',
      durationMs: 1200,
      inputTokens: 350,
      outputTokens: 800,
      responseLength: 1500,
    },
    { traceId: trace2, sessionId },
  )

  const trace3 = randomUUID()
  emitter.emit(
    'model.invoked',
    { type: 'model.invoked', modelName: 'deepseek-chat', promptLength: 50, promptTokens: 100 },
    { traceId: trace3, sessionId },
  )
  emitter.emit(
    'model.completed',
    {
      type: 'model.completed',
      modelName: 'deepseek-chat',
      durationMs: 30000,
      inputTokens: 100,
      outputTokens: 0,
      responseLength: 0,
      error: 'TIMEOUT',
    },
    { traceId: trace3, sessionId },
  )

  // 注入一个非模型的无关事件（不参与指标计算）
  emitter.emit('user.message', { type: 'user.message', length: 42, contentType: 'text' }, { traceId: randomUUID(), sessionId })

  await store.forceFlush()

  // ── 3. MetricsEngine compute ──
  const iterator = new RepositoryEventIterator(store)
  const engine = new MetricsEngineImpl(iterator)

  const snapshot = await engine.compute({ since: t1, until: Date.now() + 1000 })

  let pass = 0
  let fail = 0
  const check = (name: string, condition: boolean) => {
    if (condition) {
      console.log(`  ✅ ${name}`)
      pass++
    } else {
      console.log(`  ❌ ${name}`)
      fail++
    }
  }

  console.log('\n[traffic]')
  check('totalCalls = 3', snapshot.traffic.totalCalls === 3)
  check('completedCalls = 2', snapshot.traffic.completedCalls === 2)
  check('failedCalls = 1', snapshot.traffic.failedCalls === 1)

  console.log('\n[quality]')
  check('completionRate = 2/3', Math.abs(snapshot.quality.completionRate - 0.666) < 0.01)
  check('avgOutputTokens = (300 + 800) / 2 = 550', snapshot.quality.avgOutputTokens === 550)

  console.log('\n[latency]')
  check('avgMs = (500 + 1200) / 2 = 850', snapshot.latency.avgMs === 850)
  check('p50Ms = 500（已排序）', snapshot.latency.p50Ms === 500)
  check('p95Ms = 1200（已排序）', snapshot.latency.p95Ms === 1200)
  check('maxMs = 1200', snapshot.latency.maxMs === 1200)

  console.log('\n[cost]')
  check('totalInputTokens = 200 + 350 + 100 = 650', snapshot.cost.totalInputTokens === 650)
  check('totalOutputTokens = 300 + 800 + 0 = 1100', snapshot.cost.totalOutputTokens === 1100)
  check('totalTokens = 650 + 1100 = 1750', snapshot.cost.totalTokens === 1750)

  console.log('\n[snapshot shape]')
  check('capturedAt > 0', snapshot.capturedAt > 0)
  check('window.since = t1', snapshot.window.since === t1)
  check('有 4 个域', !!(snapshot.traffic && snapshot.quality && snapshot.latency && snapshot.cost))

  // ── 4. 空窗口验证 ──
  console.log('\n[empty window]')
  const empty = await engine.compute({ since: 0, until: 1 })
  check('empty totalCalls = 0', empty.traffic.totalCalls === 0)
  check('empty completionRate = 0', empty.quality.completionRate === 0)
  check('empty avgMs = 0', empty.latency.avgMs === 0)
  check('empty totalTokens = 0', empty.cost.totalTokens === 0)

  await store.shutdown()
  sqlite.close()

  console.log(`\n${'='.repeat(40)}`)
  console.log(`结果: ${pass}/${pass + fail} 通过`)
  if (fail === 0) console.log('✅ Metrics Engine 已验证')
  else {
    console.log(`❌ ${fail} 项失败`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
