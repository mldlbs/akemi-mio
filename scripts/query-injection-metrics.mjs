#!/usr/bin/env node
/**
 * Context Injection Metrics Query — ADR-013 Phase 3 Observation Window
 *
 * Usage:
 *   node scripts/query-injection-metrics.mjs
 *
 * Reads events.db (sql.js WASM) and computes context injection metrics
 * for Phase 3 Observation Window.
 *
 * events.db 使用 WAL 模式，sql.js 无法直接读 WAL。
 * 如需查询 events.db:
 *   1. 关闭 app（Electron 释放锁）
 *   2. 或先 PRAGMA wal_checkpoint(FULL)
 *   3. 再用 sql.js 读
 */
import initSqlJs from 'sql.js'

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const DB_DIR = join(homedir(), 'AppData', 'Roaming', 'akemi-mio', 'databases')

function average(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function pct(a, b) {
  return b > 0 ? (a / b * 100).toFixed(1) : 'N/A'
}

async function main() {
  const SQL = await initSqlJs()

  // ── Load events.db (may fail on WAL) ──
  let events = null
  try {
    const evBuf = readFileSync(join(DB_DIR, 'events.db'))
    events = new SQL.Database(evBuf)
  } catch (err) {
    console.error('Warning: events.db not readable (WAL mode locked by app?)')
    console.error(`  ${err.message}`)
    console.error('  Run with app closed or PRAGMA wal_checkpoint(FULL) first.')
    console.error('')
    process.exit(1)
  }

  // ── Check table ──
  const hasTable = events.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='evaluation_events'`,
  )
  if (!hasTable.length || !hasTable[0].values.length) {
    console.error('No evaluation_events table found.')
    events.close()
    process.exit(1)
  }

  console.log('═══════════════════════════════════════════════════')
  console.log('ADR-013 Phase 3 — Context Injection Metrics')
  console.log(`Reported at: ${new Date().toISOString()}`)
  console.log('═══════════════════════════════════════════════════')
  console.log('')

  // ── Time window ──
  const times = events.exec(`
    SELECT MIN(timestamp), MAX(timestamp)
    FROM evaluation_events
    WHERE type IN ('memory.context.injected', 'memory.context.injection_skipped')
  `)
  let durationH = 0
  if (times.length && times[0].values.length > 0 && times[0].values[0] && times[0].values[1]) {
    durationH = (times[0].values[1] - times[0].values[0]) / 3600000
    console.log(`Observation window:`)
    console.log(`  start:    ${new Date(times[0].values[0]).toISOString()}`)
    console.log(`  end:      ${new Date(times[0].values[1]).toISOString()}`)
    console.log(`  duration: ${durationH.toFixed(1)}h (${(durationH / 24).toFixed(1)} days)`)
    console.log('')
  }

  // ═══════════════════════════════════════════════
  // Helper: run repetitive queries
  // ═══════════════════════════════════════════════

  function count(type) {
    return events.exec(`SELECT COUNT(*) FROM evaluation_events WHERE type = '${type}'`)[0].values[0][0]
  }

  function countWhere(type, condition) {
    return events.exec(`SELECT COUNT(*) FROM evaluation_events WHERE type = '${type}' AND ${condition}`)[0].values[0][0]
  }

  function extractNums(type, field) {
    const rows = events.exec(`
      SELECT json_extract(payload, '$.${field}') AS val
      FROM evaluation_events
      WHERE type = '${type}' AND val IS NOT NULL
    `)
    return rows.length && rows[0].values.length > 0
      ? rows[0].values.map(r => Number(r[0]))
      : []
  }

  function extractStrs(type, field) {
    const rows = events.exec(`
      SELECT json_extract(payload, '$.${field}') AS val
      FROM evaluation_events
      WHERE type = '${type}'
    `)
    return rows.length && rows[0].values.length > 0
      ? rows[0].values.map(r => String(r[0] || ''))
      : []
  }

  function extractTraceIds(type) {
    const rows = events.exec(`
      SELECT trace_id FROM evaluation_events
      WHERE type = '${type}'
    `)
    return rows.length && rows[0].values.length > 0
      ? rows[0].values.map(r => String(r[0] || ''))
      : []
  }

  const injected = count('memory.context.injected')
  const skipped = count('memory.context.injection_skipped')

  // ═══════════════════════════════════════════════
  // Tier A — Pipeline Health
  // ═══════════════════════════════════════════════

  console.log('───────────────────────────────────────────────')
  console.log('Tier A — Pipeline Health')
  console.log('───────────────────────────────────────────────')
  console.log('')

  // ── A1: Injection count ──
  console.log(`A1  memory.context.injected events                 ${injected}`)

  // ── A2: Skipped rate ──
  const total = injected + skipped
  const skipRate = total > 0 ? (skipped / total * 100) : 0
  console.log(`A2  injection_skipped rate                         ${skipRate.toFixed(1)}% (${skipped}/${total})`)

  if (skipped > 0) {
    const skipReasons = events.exec(`
      SELECT json_extract(payload, '$.reason'), COUNT(*)
      FROM evaluation_events
      WHERE type = 'memory.context.injection_skipped'
      GROUP BY json_extract(payload, '$.reason')
    `)
    if (skipReasons.length && skipReasons[0].values.length > 0) {
      for (const row of skipReasons[0].values) {
        console.log(`    └ ${String(row[0]).padEnd(20)} ${row[1]}`)
      }
    }
  }

  // ── A3: Token overflow = 0 ──
  const tokens = extractNums('memory.context.injected', 'tokenEstimate')
  const overflows = tokens.filter(t => t > 800).length
  console.log(`A3  tokenEstimate > 800 (overflow)                 ${overflows} / ${tokens.length}`)
  if (tokens.length > 0) {
    console.log(`    └ avg: ${average(tokens).toFixed(0)}  min: ${Math.min(...tokens)}  max: ${Math.max(...tokens)}  median: ${median(tokens).toFixed(0)}`)
  }

  // ── A4: Trace correlation rate ──
  const injTraceIds = extractTraceIds('memory.context.injected')
  const withTrace = injTraceIds.filter(id => id.length > 0).length
  const traceRate = injTraceIds.length > 0 ? (withTrace / injTraceIds.length * 100) : 0

  // Cross-reference: how many model.invoked share those traceIds
  const modelTraceRows = events.exec(`SELECT DISTINCT trace_id FROM evaluation_events WHERE type = 'model.invoked'`)
  const modelTraceIds = new Set(
    (modelTraceRows.length ? modelTraceRows[0].values : []).map(r => String(r[0])),
  )
  const matchedTraces = injTraceIds.filter(id => modelTraceIds.has(id)).length

  // 1:N ratio: model.invoked per injection traceId
  let modelPerTrace = 'N/A'
  if (withTrace > 0) {
    const modelCounts = events.exec(`
      SELECT e.trace_id, COUNT(*) AS cnt FROM evaluation_events e
      WHERE e.type = 'model.invoked'
        AND e.trace_id IN (SELECT DISTINCT trace_id FROM evaluation_events WHERE type = 'memory.context.injected' AND trace_id != '')
      GROUP BY e.trace_id
    `)
    if (modelCounts.length && modelCounts[0].values.length > 0) {
      const counts = modelCounts[0].values.map(r => Number(r[1]))
      modelPerTrace = average(counts).toFixed(2)
    }
  }

  console.log(`A4  trace correlation rate                          ${traceRate.toFixed(1)}% (${withTrace}/${injTraceIds.length})`)
  console.log(`    └ model.invoked matching injection traceIds:   ${matchedTraces}`)
  console.log(`    └ model.invoked per injection (avg 1:N):       ${modelPerTrace}`)

  // ── A5: Unique sessions injected ──
  const uniqueSessions = events.exec(`
    SELECT COUNT(DISTINCT json_extract(payload, '$.sessionId'))
    FROM evaluation_events
    WHERE type = 'memory.context.injected'
  `)
  const uniqSess = uniqueSessions.length && uniqueSessions[0].values.length > 0
    ? Number(uniqueSessions[0].values[0][0])
    : 0
  console.log(`A5  unique sessions with injections                ${uniqSess}`)

  // ── A6: Injection coverage per run ──
  // We can't count run() directly from events.db, but we can approximate via model.invoked
  // Each run() generates at least 1 model.invoked. Multiple model.invoked per run share traceId.
  const uniqueRunTraces = new Set(injTraceIds.filter(Boolean)).size
  const allModelInvocations = count('model.invoked')
  // Unique traceIds from model.invoked approximates total run() calls
  const uniqueModelTraceCount = modelTraceIds.size
  const coverageRatio = uniqueModelTraceCount > 0
    ? pct(uniqueRunTraces, uniqueModelTraceCount)
    : 'N/A'
  console.log(`A6  injection coverage ratio (runs with injection)  `)
  console.log(`    └ unique injection traceIds (≈ runs w/ inject): ${uniqueRunTraces}`)
  console.log(`    └ unique model.invoked traceIds  (≈ total runs): ${uniqueModelTraceCount}`)
  console.log(`    └ coverage:                                      ${coverageRatio}%`)
  console.log('')

  // ═══════════════════════════════════════════════
  // Tier B — Context Utilization Baseline (document only)
  // ═══════════════════════════════════════════════

  console.log('───────────────────────────────────────────────')
  console.log('Tier B — Context Utilization Baseline (recorded, not gating)')
  console.log('───────────────────────────────────────────────')
  console.log('')

  // B1: avg tokenEstimate
  const avgTokens = tokens.length > 0 ? average(tokens) : 0
  console.log(`B1  avg tokenEstimate                               ${avgTokens.toFixed(1)}`)

  // B2: avg sourceSessions
  const srcCounts = extractNums('memory.context.injected', 'sourceCount')
  const avgSources = srcCounts.length > 0 ? average(srcCounts) : 0
  console.log(`B2  avg sourceSessions per injection                ${avgSources.toFixed(2)} (min: ${srcCounts.length > 0 ? Math.min(...srcCounts) : 'N/A'}, max: ${srcCounts.length > 0 ? Math.max(...srcCounts) : 'N/A'})`)

  // B3: injected vs skipped — requires cross-session analysis, not available in Phase 3
  console.log(`B3  injected vs skipped response diff              ⏸ DEFERRED (Phase 4)`)

  // B4: user follow-up repetition — requires cross-session analysis
  console.log(`B4  user follow-up repetition rate                 ⏸ DEFERRED (Phase 4)`)
  console.log('')

  // ═══════════════════════════════════════════════
  // Phase 1+2 Baseline (regression check)
  // ═══════════════════════════════════════════════

  console.log('───────────────────────────────────────────────')
  console.log('Phase 1+2 Baseline (regression check)')
  console.log('───────────────────────────────────────────────')
  console.log('')

  const p1events = count('session.digest.retrieved') + count('session.digest.retrieved_noop') + count('memory.compaction.failed')
  const p2events = count('memory.retrieval.scored') + count('memory.scoring.attention_gap')
  console.log(`  Phase 1 events total:   ${p1events}`)
  console.log(`  Phase 2 events total:   ${p2events}`)
  console.log('  (Regression = Phase 3 code change stops Phase 1/2 event emission)')
  console.log('')

  // ═══════════════════════════════════════════════
  // Admission Gate / Exit Criteria
  // ═══════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════')
  console.log('Phase 3 Exit Criteria')
  console.log('═══════════════════════════════════════════════════')
  console.log('')

  console.log(`  Time minimum: 48h                      ${durationH >= 48 ? '✅' : '⏳'} ${durationH.toFixed(1)}h`)
  console.log(`  Sample minimum: 100 injected events     ${injected >= 100 ? '✅' : '⏳'} ${injected}`)
  console.log('')
  console.log(`  Tier A — Pipeline Health:`)
  console.log(`  A1  injected ≥ 100                     ${injected >= 100 ? '✅' : '⏳'} ${injected}`)
  console.log(`  A2  skipped rate < 20%                 ${skipRate < 20 ? '✅' : '⏳'} ${skipRate.toFixed(1)}%`)
  console.log(`  A3  token overflow = 0                 ${overflows === 0 ? '✅' : '⏳'} ${overflows}`)
  console.log(`  A4  trace correlation > 95%            ${traceRate > 95 ? '✅' : '⏳'} ${traceRate.toFixed(1)}%`)
  console.log(`  A5  unique sessions ≥ 3                ${uniqSess >= 3 ? '✅' : '⏳'} ${uniqSess}`)
  console.log(`  A6  injection coverage documented      ${coverageRatio !== 'N/A' ? '✅' : '⏳'} ${coverageRatio}%`)
  console.log('')
  console.log(`  Tier B — Context Utilization Baseline:`)
  console.log(`  B1  avg tokenEstimate                  ${avgTokens > 0 ? '📝' : '📝'} ${avgTokens.toFixed(1)}`)
  console.log(`  B2  avg sourceSessions                 ${avgSources > 0 ? '📝' : '📝'} ${avgSources.toFixed(2)}`)
  console.log(`  B3  injected vs skipped diff           ⏸ DEFERRED`)
  console.log(`  B4  user follow-up repetition          ⏸ DEFERRED`)
  console.log('')

  const tierAPass = injected >= 100 && skipRate < 20 && overflows === 0 && traceRate > 95 && uniqSess >= 3
  const samplePass = injected >= 100
  const timePass = durationH >= 48

  if (timePass && samplePass && tierAPass) {
    console.log('═══ Result: ✅ PHASE 3 READY TO CLOSE ═══')
    console.log('  Tier A Pipeline Health confirmed.')
    console.log('  Tier B data documented for Phase 4 baseline.')
    console.log('  Proceed to Phase 4: Behavioral Value Evaluation.')
  } else {
    console.log('═══ Result: 🔄 OBSERVATION IN PROGRESS ═══')
    console.log('  Continue collection. Re-run script to check progress.')
  }
  console.log('')

  events.close()
}

main().catch(console.error)
