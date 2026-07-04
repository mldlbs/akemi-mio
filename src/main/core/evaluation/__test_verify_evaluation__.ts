/**
 * Evaluation 端到端验证脚本
 *
 * 验证链路：EvaluationEmitter → EvaluationStore → evaluation_events
 *
 * 运行：npx tsx src/main/core/evaluation/__test_verify_evaluation__.ts
 */

import initSqlJs from 'sql.js'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { eq } from 'drizzle-orm'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { EvaluationEmitter } from './EvaluationEmitter'
import { EvaluationStore } from './EvaluationStore'
import * as schema from '../../db/schema'

async function main() {
  // ── 1. 创建独立数据库 ──

  const dbPath = join(tmpdir(), `evaluation_verify_${Date.now()}.db`)
  console.log(`\n=== Evaluation 端到端验证 ===`)
  console.log(`DB: ${dbPath}`)

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
  sqlite.run('CREATE INDEX IF NOT EXISTS idx_ev_trace ON evaluation_events(trace_id)')

  // ── 2. Drizzle proxy ──

  async function proxyCallback(sql: string, params: any[], method: 'run' | 'get' | 'all' | 'values') {
    const converted = sql.replace(/\$\d+/g, '?')
    try {
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
    } catch (err: any) {
      console.error('DB ERROR:', err.message)
      throw err
    }
  }

  const db = drizzle(proxyCallback, { schema })

  // ── 3. 构建 EvaluationStore + EvaluationEmitter ──

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

  const store = new EvaluationStore(db as any, rawDb)
  await store.init()
  const emitter = new EvaluationEmitter(store, 'test-verify')

  // ── 4. 直接验证 DB 插入 ──

  console.log(`\n[Test 0] 直接 DB 写入`)
  await store.forceFlush()
  await db.insert(schema.evaluationEvents).values({
    id: 'direct-1',
    timestamp: Date.now(),
    traceId: 'direct-trace',
    sessionId: 'sess',
    source: 'test',
    type: 'model.invoked',
    payload: JSON.stringify({ modelName: 'test' }),
  })
  const direct = await db.select().from(schema.evaluationEvents).where(eq(schema.evaluationEvents.id, 'direct-1'))
  console.log(`  直接插入返回: ${direct.length}`)

  // ── 5. 模拟模型调用并验证 ──

  const traceId = randomUUID()
  const verifyResult = { successCount: 0, failCount: 0 }

  // 4a: 成功的模型调用
  console.log(`\n[Test 1] 成功模型调用`)
  emitter.emit(
    'model.invoked',
    {
      type: 'model.invoked',
      modelName: 'deepseek-chat',
      promptLength: 123,
      promptTokens: 456,
    },
    { traceId },
  )

  emitter.emit(
    'model.completed',
    {
      type: 'model.completed',
      modelName: 'deepseek-chat',
      durationMs: 2500,
      inputTokens: 456,
      outputTokens: 789,
      responseLength: 1024,
      responsePreview: '你好，我是 AI 助手...',
    },
    { traceId },
  )

  // 强制刷入
  await store.forceFlush()

  // 直接 sqlite 查询验证（绕过 drizzle）
  const rawStmt = sqlite.prepare('SELECT id, type, trace_id FROM evaluation_events WHERE trace_id = ?')
  rawStmt.bind([traceId])
  const rawRows = []
  while (rawStmt.step()) rawRows.push(rawStmt.getAsObject())
  rawStmt.free()
  console.log(`  sqlite 直接查: ${rawRows.length} 条`)
  for (const r of rawRows) console.log(`    id=${r.id} type=${r.type} trace_id=${r.trace_id}`)

  const traceEvents = await store.getTrace(traceId)
  const invokedCount = traceEvents.filter((e) => e.type === 'model.invoked').length
  const completedCount = traceEvents.filter((e) => e.type === 'model.completed').length

  if (invokedCount === 1 && completedCount === 1) {
    console.log(`  ✅ model.invoked (1) + model.completed (1)`)
    verifyResult.successCount++
  } else {
    console.log(`  ❌ 期望 invoked=1 completed=1，实际 invoked=${invokedCount} completed=${completedCount}`)
    verifyResult.failCount++
  }

  const invoked = traceEvents.find((e) => e.type === 'model.invoked')!
  const completed = traceEvents.find((e) => e.type === 'model.completed')!

  const checks = [
    { name: 'invoked.traceId 正确', pass: invoked.traceId === traceId },
    { name: 'invoked.timestamp > 0', pass: invoked.timestamp > 0 },
    { name: 'invoked.id 是 UUID', pass: invoked.id.length === 36 },
    { name: 'invoked.modelName = deepseek-chat', pass: (invoked.payload as any).modelName === 'deepseek-chat' },
    { name: 'completed.traceId 一致', pass: completed.traceId === traceId },
    { name: 'completed.durationMs = 2500', pass: (completed.payload as any).durationMs === 2500 },
    { name: 'completed.inputTokens = 456', pass: (completed.payload as any).inputTokens === 456 },
    { name: 'completed.outputTokens = 789', pass: (completed.payload as any).outputTokens === 789 },
    { name: 'completed.error 不存在（成功）', pass: !(completed.payload as any).error },
    { name: 'completed.timestamp >= invoked.timestamp', pass: completed.timestamp >= invoked.timestamp },
  ]
  const allPassed = checks.every((c) => c.pass)
  if (allPassed) {
    console.log(`  ✅ 所有字段校验通过`)
    verifyResult.successCount++
  } else {
    for (const f of checks.filter((c) => !c.pass)) console.log(`  ❌ ${f.name}`)
    verifyResult.failCount++
  }

  // 4b: 异常模型调用（超时）
  console.log(`\n[Test 2] 异常模型调用（超时）`)
  const traceId2 = randomUUID()

  emitter.emit(
    'model.invoked',
    {
      type: 'model.invoked',
      modelName: 'deepseek-chat',
      promptLength: 50,
      promptTokens: 100,
    },
    { traceId: traceId2 },
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
    { traceId: traceId2 },
  )

  const trace2Events = await store.getTrace(traceId2)
  const t2Completed = trace2Events.find((e) => e.type === 'model.completed')!

  const errChecks = [
    { name: '异常 trace 有 2 个事件', pass: trace2Events.length === 2 },
    { name: '异常 completed.error = TIMEOUT', pass: (t2Completed.payload as any).error === 'TIMEOUT' },
    { name: '异常 outputTokens = 0', pass: (t2Completed.payload as any).outputTokens === 0 },
    { name: '异常 source = test-verify', pass: t2Completed.source === 'test-verify' },
  ]
  const errAllPass = errChecks.every((c) => c.pass)
  if (errAllPass) {
    console.log(`  ✅ 异常路径完整`)
    verifyResult.successCount++
  } else {
    for (const f of errChecks.filter((c) => !c.pass)) console.log(`  ❌ ${f.name}`)
    verifyResult.failCount++
  }

  // 4c: 查询接口验证
  console.log(`\n[Test 3] query() 查询`)
  const allEvents = await store.query({ since: 0 })
  const byType = await store.query({ since: 0, type: 'model.invoked' })

  if (allEvents.length >= 4) {
    console.log(`  ✅ query(since=0) 返回 ${allEvents.length} 个事件（>=4）`)
    verifyResult.successCount++
  } else {
    console.log(`  ❌ query(since=0) 返回 ${allEvents.length} 个，期望至少 4`)
    verifyResult.failCount++
  }
  if (byType.length === 3) {
    console.log(`  ✅ query(type=model.invoked)=${byType.length}`)
    verifyResult.successCount++
  } else {
    console.log(`  ❌ query(type=model.invoked)=${byType.length}，期望 2`)
    verifyResult.failCount++
  }

  // 4d: 顺序验证
  console.log(`\n[Test 4] 事件顺序正确`)
  if (
    completed.timestamp >= invoked.timestamp &&
    t2Completed.timestamp >= (trace2Events.find((e) => e.type === 'model.invoked')?.timestamp ?? 0)
  ) {
    console.log(`  ✅ 所有 completed.timestamp >= invoked.timestamp`)
    verifyResult.successCount++
  } else {
    console.log(`  ❌ 事件顺序异常`)
    verifyResult.failCount++
  }

  // ── 5. 清理 ──

  await store.shutdown()
  sqlite.close()

  // ── 报告 ──

  console.log(`\n${'='.repeat(40)}`)
  console.log(`结果: ${verifyResult.successCount}/${verifyResult.successCount + verifyResult.failCount} 通过`)
  if (verifyResult.failCount === 0) {
    console.log('✅ 全部通过 — Evaluation 事件管道已验证')
  } else {
    console.log(`❌ ${verifyResult.failCount} 项失败`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
