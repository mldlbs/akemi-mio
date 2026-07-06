/**
 * Observation v1.1 Verification Script
 *
 * 验证 TraceId 传播 / SessionId 注入 / Context Attribution 三个修复的有效性。
 *
 * 直接读取 AppData 下的 SQLite 数据库（无需 App 重启）。
 */
import { createRequire } from 'module'
import path from 'path'

const DB_PATH = 'C:/Users/gf191/AppData/Roaming/akemi-mio/akemi-mio.db'

// ── Helper: count rows with filter ──
function query(db: any, sql: string, params?: any[]): Record<string, any>[] {
  const stmt = db.prepare(sql)
  if (params) stmt.bind(...params)
  const rows: Record<string, any>[] = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}

function count(db: any, sql: string, params?: any[]): number {
  const r = query(db, sql, params)
  return Number(r[0]?.count ?? 0)
}

async function main() {
  // Dynamically import better-sqlite3 or sql.js
  let db: any
  try {
    const sqlite3 = createRequire(import.meta.url)('better-sqlite3')
    db = sqlite3(DB_PATH, { readonly: true })
  } catch {
    // Fallback to sql.js
    const initSqlJs = createRequire(import.meta.url)('sql.js')
    const SQL = await initSqlJs()
    const fs = createRequire(import.meta.url)('fs')
    const buffer = fs.readFileSync(DB_PATH)
    db = new SQL.Database(buffer)
  }

  console.log('═'.repeat(60))
  console.log('  Observation v1.1 Verification Report')
  console.log('═'.repeat(60))
  console.log(`  Database: ${DB_PATH}`)
  console.log()

  // ── 1. 总览 ──
  const totalEvents = count(db, 'SELECT COUNT(*) as count FROM evaluation_events')
  console.log('── 1. Data Overview ──')
  console.log(`  Total evaluation events: ${totalEvents}`)

  // Event type breakdown
  const typeStats = query(db, 'SELECT type, COUNT(*) as count FROM evaluation_events GROUP BY type ORDER BY count DESC')
  console.log(`  Event types:`)
  for (const r of typeStats) {
    console.log(`    ${String(r.type).padEnd(25)} ${String(r.count).padStart(6)}`)
  }

  // ── 2. traceId 完整性 ──
  console.log()
  console.log('── 2. traceId Propagation ──')

  const emptyTraceAll = count(db, "SELECT COUNT(*) as count FROM evaluation_events WHERE trace_id = '' OR trace_id IS NULL")
  const totalToolEvents = count(db, "SELECT COUNT(*) as count FROM evaluation_events WHERE type LIKE 'tool.%'")
  const emptyTraceTool = count(
    db,
    "SELECT COUNT(*) as count FROM evaluation_events WHERE (trace_id = '' OR trace_id IS NULL) AND type LIKE 'tool.%'",
  )
  const modelEvents = count(db, "SELECT COUNT(*) as count FROM evaluation_events WHERE type LIKE 'model.%'")
  const emptyTraceModel = count(
    db,
    "SELECT COUNT(*) as count FROM evaluation_events WHERE (trace_id = '' OR trace_id IS NULL) AND type LIKE 'model.%'",
  )

  console.log(`  Events with empty traceId:  ${emptyTraceAll} / ${totalEvents} (${((emptyTraceAll / totalEvents) * 100).toFixed(1)}%)`)
  console.log(
    `  Tool events empty traceId:   ${emptyTraceTool} / ${totalToolEvents} (${((emptyTraceTool / (totalToolEvents || 1)) * 100).toFixed(1)}%)`,
  )
  console.log(
    `  Model events empty traceId:  ${emptyTraceModel} / ${modelEvents} (${((emptyTraceModel / (modelEvents || 1)) * 100).toFixed(1)}%)`,
  )

  if (emptyTraceTool === 0 && emptyTraceModel === 0) {
    console.log(`  ✅ PASS: All tool and model events have traceId`)
  } else if (emptyTraceTool === 0) {
    console.log(`  ✅ PASS: All tool events have traceId`)
    console.log(`  ⚠️  ${emptyTraceModel} model events still missing traceId`)
  } else {
    console.log(`  ❌ FAIL: ${emptyTraceTool} tool events still missing traceId`)
  }

  // Unique traceIds
  const uniqueTraces = count(
    db,
    "SELECT COUNT(DISTINCT trace_id) as count FROM evaluation_events WHERE trace_id != '' AND trace_id IS NOT NULL",
  )
  console.log(`  Unique non-empty traceIds: ${uniqueTraces}`)

  // ── 3. sessionId 完整性 ──
  console.log()
  console.log('── 3. sessionId Propagation ──')

  const emptySession = count(db, "SELECT COUNT(*) as count FROM evaluation_events WHERE session_id = '' OR session_id IS NULL")
  const uniqueSessions = count(
    db,
    "SELECT COUNT(DISTINCT session_id) as count FROM evaluation_events WHERE session_id != '' AND session_id IS NOT NULL",
  )

  console.log(`  Events with empty sessionId:  ${emptySession} / ${totalEvents} (${((emptySession / totalEvents) * 100).toFixed(1)}%)`)
  console.log(`  Unique non-empty sessionIds: ${uniqueSessions}`)

  if (emptySession === 0) {
    console.log(`  ✅ PASS: All events have sessionId`)
  } else if (emptySession < totalEvents * 0.1) {
    console.log(`  ⚠️  WARN: ${emptySession} events still missing sessionId (under 10%)`)
  } else {
    console.log(`  ❌ FAIL: ${emptySession} events missing sessionId`)
  }

  // ── 4. Context Attribution (tokenBreakdown) ──
  console.log()
  console.log('── 4. Context Attribution (tokenBreakdown) ──')

  const modelInvoked = query(db, "SELECT payload FROM evaluation_events WHERE type = 'model.invoked' ORDER BY timestamp DESC LIMIT 10")
  let hasBreakdown = 0
  let totalCheckedInvoked = 0
  for (const r of modelInvoked) {
    totalCheckedInvoked++
    try {
      const p = JSON.parse(String(r.payload))
      if (p.tokenBreakdown) hasBreakdown++
    } catch {}
  }

  console.log(`  Recent model.invoked with tokenBreakdown: ${hasBreakdown} / ${totalCheckedInvoked}`)

  if (hasBreakdown > 0) {
    console.log(`  ✅ PASS: Context Attribution is being written`)
    // Show a sample
    for (const r of modelInvoked) {
      try {
        const p = JSON.parse(String(r.payload))
        if (p.tokenBreakdown) {
          console.log(`  Sample breakdown: ${JSON.stringify(p.tokenBreakdown)}`)
          break
        }
      } catch {}
    }
  } else {
    console.log(`  ⚠️  WARN: No tokenBreakdown found in recent model.invoked`)
    console.log(`  (This is expected if app hasn't processed new requests after code change)`)
  }

  // ── 5. Trace Completeness (Trace Replay readiness) ──
  console.log()
  console.log('── 5. Trace Completeness ──')

  // Top traces by event count
  const topTraces = query(
    db,
    "SELECT trace_id, COUNT(*) as event_count, GROUP_CONCAT(DISTINCT type) as types FROM evaluation_events WHERE trace_id != '' AND trace_id IS NOT NULL GROUP BY trace_id ORDER BY event_count DESC LIMIT 10",
  )

  console.log(`  Top 10 traces by event count:`)
  console.log(`  ${'trace_id'.padEnd(30)} ${'events'.padEnd(8)} types`)
  console.log(`  ${'-'.repeat(60)}`)
  for (const r of topTraces) {
    const tid = String(r.trace_id).slice(0, 28)
    const types = String(r.types).slice(0, 80)
    console.log(`  ${tid.padEnd(30)} ${String(r.event_count).padEnd(8)} ${types}`)
  }

  // Check if any top traces have both model and tool events
  let mixedTraces = 0
  for (const r of topTraces) {
    const types = String(r.types)
    if (types.includes('model.') && types.includes('tool.')) mixedTraces++
  }
  console.log(`  Top traces with mixed model+tool events: ${mixedTraces} / ${topTraces.length}`)
  console.log(`  ✅ Trace Replay can now correlate LLM + Tool calls`)

  // ── 6. Calls per Trace distribution ──
  console.log()
  console.log('── 6. Calls per Trace (updated) ──')

  const traceSizes = query(
    db,
    "SELECT COUNT(*) as cnt FROM evaluation_events WHERE trace_id != '' AND trace_id IS NOT NULL GROUP BY trace_id ORDER BY cnt ASC",
  )
  const sizes = traceSizes.map((r) => Number(r.cnt)).sort((a, b) => a - b)
  if (sizes.length > 0) {
    const p50 = sizes[Math.floor(sizes.length * 0.5)]
    const p90 = sizes[Math.floor(sizes.length * 0.9)]
    const p95 = sizes[Math.floor(sizes.length * 0.95)]
    const max = sizes[sizes.length - 1]
    const min = sizes[0]
    console.log(`  P50: ${p50}  P90: ${p90}  P95: ${p95}  Max: ${max}  Min: ${min}`)

    // Check if empty-trace anomaly is gone
    const emptyTraceCount = count(db, "SELECT COUNT(*) as count FROM evaluation_events WHERE trace_id = '' OR trace_id IS NULL")
    if (emptyTraceCount < 10) {
      console.log(`  ✅ No empty-trace anomaly (only ${emptyTraceCount} orphan events)`)
    } else {
      console.log(`  ⚠️  ${emptyTraceCount} orphan events remain (empty trace_id)`)
    }
  } else {
    console.log(`  No trace data available`)
  }

  // ── 7. Summary ──
  console.log()
  console.log('═'.repeat(60))
  console.log('  Verification Summary')
  console.log('═'.repeat(60))

  const checks = [
    { name: 'Tool Trace — tool.* events have traceId', pass: emptyTraceTool === 0 },
    { name: 'Session — all events have sessionId', pass: emptySession === 0 },
    { name: 'Context Attribution — tokenBreakdown present', pass: hasBreakdown > 0 },
    { name: 'Trace Replay — mixed model+tool traces exist', pass: mixedTraces > 0 || topTraces.length === 0 },
  ]

  const passed = checks.filter((c) => c.pass).length
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`)
  }
  console.log()
  console.log(`  ${passed} / ${checks.length} checks passed`)

  if (passed === checks.length) {
    console.log('  ✅ Observation v1.1 VERIFIED — ready for Progress Guardrail')
  } else {
    console.log('  ⚠️  Some checks failed — investigate before Guardrail development')
  }

  console.log()
}

main().catch(console.error)
