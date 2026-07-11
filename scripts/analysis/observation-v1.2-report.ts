/**
 * Observation v1.2 Report
 *
 * 分析 Guardrail MVP 上线后的 Trace 数据，重点验证：
 *   1. Guardrail Trigger Rate
 *   2. Warning → Continue / Warning → Terminate 状态迁移
 *   3. Terminate 是否缩短长尾
 *   4. Context Inflation 变化
 *
 * 直接读取 AppData 下的 SQLite 数据库（无需 App 重启）。
 * 遵守 Event 不可修改原则 —— 所有分析结果均为离线计算。
 */
import { createRequire } from 'module'

const DB_PATH = 'C:/Users/gf191/AppData/Roaming/akemi-mio/akemi-mio.db'

// ── Helper: raw query via sql.js ──
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

function parsePayload(r: Record<string, any>): any {
  return typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload
}

// ── Helper: Guardrail state transition labels ──
function classifyTrace(events: Record<string, any>[]): string {
  // Check if a guardrail.terminated event exists
  const hasTerminatedEvent = events.some((e) => e.type === 'guardrail.terminated')
  // Check if any checked decision was 'terminate'
  const hasTerminateDecision = events.some((e) => parsePayload(e).decision === 'terminate')
  // Check if any checked decision was 'warning'
  const hasWarning = events.some((e) => parsePayload(e).decision === 'warning')

  if (hasTerminatedEvent || hasTerminateDecision) {
    return hasWarning ? 'warning_then_terminate' : 'direct_terminate'
  }
  if (hasWarning) return 'warning_only'
  return 'none'
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

async function main() {
  // ── Init DB ──
  let db: any
  try {
    const sqlite3 = createRequire(import.meta.url)('better-sqlite3')
    db = sqlite3(DB_PATH, { readonly: true })
  } catch {
    const initSqlJs = createRequire(import.meta.url)('sql.js')
    const SQL = await initSqlJs()
    const fs = createRequire(import.meta.url)('fs')
    const buffer = fs.readFileSync(DB_PATH)
    db = new SQL.Database(buffer)
  }

  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║           Observation v1.2 — Guardrail Report              ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log(`  Database: ${DB_PATH}`)
  console.log()

  // ══════════════════════════════════════════
  // 1. Data Overview
  // ══════════════════════════════════════════
  const totalEvents = count(db, 'SELECT COUNT(*) as count FROM evaluation_events')
  console.log('── 1. Data Overview ──')
  console.log(`  Total evaluation events: ${totalEvents}`)

  const typeStats = query(db, 'SELECT type, COUNT(*) as count FROM evaluation_events GROUP BY type ORDER BY count DESC')
  console.log('  Event types:')
  for (const r of typeStats) {
    console.log(`    ${String(r.type).padEnd(25)} ${String(r.count).padStart(6)}`)
  }

  const distinctTraces = count(
    db,
    "SELECT COUNT(DISTINCT trace_id) as count FROM evaluation_events WHERE trace_id IS NOT NULL AND trace_id != ''",
  )
  const tracesWithGuardrail = count(db, "SELECT COUNT(DISTINCT trace_id) as count FROM evaluation_events WHERE type LIKE 'guardrail.%'")
  console.log(`  Distinct traces: ${distinctTraces}`)
  console.log(`  Traces touched by guardrail: ${tracesWithGuardrail} (${((tracesWithGuardrail / distinctTraces) * 100).toFixed(1)}%)`)
  console.log()

  // ══════════════════════════════════════════
  // 1b. Coverage Analysis
  // ══════════════════════════════════════════
  //
  // GuardrailPipeline.check() requires:
  //   currentTurn >= minTurnsBeforeCheck (5)
  //   currentTurn - lastCheckedTurn >= checkIntervalTurns (5)
  //
  // Eligible: traces with enough model calls (proxy for turns) to be checked.
  // Triggered: traces that actually produced a guardrail event.
  //
  console.log('── 1b. Coverage Analysis ──')

  const perTraceModelCalls = query(
    db,
    "SELECT trace_id, COUNT(*) as modelCalls FROM evaluation_events WHERE type = 'model.invoked' AND trace_id IS NOT NULL AND trace_id != '' GROUP BY trace_id ORDER BY modelCalls DESC",
  )

  // minTurnsBeforeCheck=5 → eligible if >= 5 model.invoked events
  const MIN_ELIGIBLE_TURNS = 5
  let eligibleTraces = 0
  let eligibleTriggered = 0
  const eligibleModelCallDist: number[] = []
  const triggeredTraceIds = new Set(
    query(db, "SELECT DISTINCT trace_id FROM evaluation_events WHERE type LIKE 'guardrail.%'").map((r) => r.trace_id as string),
  )

  for (const r of perTraceModelCalls) {
    const calls = Number(r.modelCalls)
    if (calls >= MIN_ELIGIBLE_TURNS) {
      eligibleTraces++
      eligibleModelCallDist.push(calls)
      if (triggeredTraceIds.has(r.trace_id as string)) {
        eligibleTriggered++
      }
    }
  }

  // Also count short traces that triggered (shouldn't happen, but verify)
  const shortTriggered = count(
    db,
    "SELECT COUNT(DISTINCT ee.trace_id) as count FROM evaluation_events ee WHERE ee.type LIKE 'guardrail.%' AND ee.trace_id IN (SELECT trace_id FROM evaluation_events WHERE type = 'model.invoked' AND trace_id IS NOT NULL AND trace_id != '' GROUP BY trace_id HAVING COUNT(*) < ?)",
    [MIN_ELIGIBLE_TURNS],
  )

  console.log(`  Eligible traces (≥${MIN_ELIGIBLE_TURNS} model calls):  ${eligibleTraces} (out of ${distinctTraces})`)
  console.log(
    `  Triggered traces:             ${eligibleTriggered} (${eligibleTraces > 0 ? ((eligibleTriggered / eligibleTraces) * 100).toFixed(1) : 'N/A'}% coverage)`,
  )
  if (eligibleModelCallDist.length > 0) {
    const sorted = [...eligibleModelCallDist].sort((a, b) => a - b)
    console.log(`  Eligible trace model call distribution:`)
    console.log(
      `    P50: ${percentile(sorted, 50)}  P90: ${percentile(sorted, 90)}  P95: ${percentile(sorted, 95)}  Min: ${sorted[0]}  Max: ${sorted[sorted.length - 1]}`,
    )
  }
  console.log(`  Short-trace triggers (bug if >0): ${shortTriggered}`)

  console.log(`  Trace length buckets:`)
  // Bucket: 1-2, 3-4, 5-9, 10-19, 20-49, 50+ model calls
  const buckets = ['1-2', '3-4', '5-9', '10-19', '20-49', '50+']
  const bucketRanges = [
    [1, 2],
    [3, 4],
    [5, 9],
    [10, 19],
    [20, 49],
    [50, Infinity],
  ]
  for (let i = 0; i < buckets.length; i++) {
    const [lo, hi] = bucketRanges[i]
    const isUnbounded = !isFinite(hi)
    const havingClause = isUnbounded ? 'COUNT(*) >= ' + lo : '(COUNT(*) >= ' + lo + ' AND COUNT(*) <= ' + hi + ')'
    const cnt = count(
      db,
      "SELECT COUNT(*) as count FROM (SELECT trace_id FROM evaluation_events WHERE type = 'model.invoked' AND trace_id IS NOT NULL AND trace_id != '' GROUP BY trace_id HAVING " +
        havingClause +
        ')',
    )
    const triggeredCnt = count(
      db,
      "SELECT COUNT(*) as count FROM (SELECT trace_id FROM evaluation_events WHERE type = 'model.invoked' AND trace_id IS NOT NULL AND trace_id != '' GROUP BY trace_id HAVING " +
        havingClause +
        ") sub WHERE sub.trace_id IN (SELECT DISTINCT trace_id FROM evaluation_events WHERE type LIKE 'guardrail.%')",
    )
    const pct = cnt > 0 ? ((triggeredCnt / cnt) * 100).toFixed(1) : '-'
    console.log(
      `    ${buckets[i].padStart(5)} model calls: ${String(cnt).padStart(4)} traces, ${String(triggeredCnt).padStart(3)} triggered (${pct}%)`,
    )
  }
  console.log()
  // ══════════════════════════════════════════
  // 1c. Eligible Survival Curve
  //
  // For every turn position (5..max), how many eligible traces
  // are still active? This informs where Policy thresholds
  // would have material impact.
  // ══════════════════════════════════════════
  console.log('── 1c. Eligible Survival Curve ──')

  // For each eligible trace, count how many model.invoked events
  // occurred at each turn position (1st, 2nd, ..., Nth).
  // We approximate "alive at turn T" as "has at least T model.invoked events".
  const perTraceOrdered = query(
    db,
    "SELECT trace_id, COUNT(*) as total FROM evaluation_events WHERE type = 'model.invoked' AND trace_id IS NOT NULL AND trace_id != '' GROUP BY trace_id HAVING COUNT(*) >= 5 ORDER BY trace_id",
  )

  // Build survival counts: survival[t] = traces with ≥t model calls
  const totalCounts2 = perTraceOrdered.map((r) => Number(r.total))
  const maxTurn = Math.max(...totalCounts2, 0)
  const survival: Array<{ turn: number; alive: number }> = []
  for (let t = 5; t <= Math.min(maxTurn, 30); t += 1) {
    survival.push({ turn: t, alive: totalCounts2.filter((c) => c >= t).length })
  }

  // Print in a compact format — groups of 5
  for (let i = 0; i < survival.length; i++) {
    const s = survival[i]
    const pct = ((s.alive / perTraceOrdered.length) * 100).toFixed(0)
    process.stdout.write(`  t=${String(s.turn).padStart(2)}:${String(s.alive).padStart(3)}(${pct}%)`)
    if ((i + 1) % 5 === 0) process.stdout.write('\n')
    else process.stdout.write('  ')
  }
  if (survival.length % 5 !== 0) process.stdout.write('\n')
  console.log()

  // ══════════════════════════════════════════
  // 2. Guardrail Event Breakdown
  // ══════════════════════════════════════════
  const gTypes = query(db, "SELECT type, COUNT(*) as count FROM evaluation_events WHERE type LIKE 'guardrail.%' GROUP BY type")
  console.log('── 2. Guardrail Event Breakdown ──')
  for (const r of gTypes) {
    console.log(`  ${String(r.type).padEnd(25)} ${String(r.count).padStart(4)}`)
  }

  const guardrailTraces = query(
    db,
    "SELECT trace_id, type, payload, timestamp FROM evaluation_events WHERE type LIKE 'guardrail.%' ORDER BY trace_id, timestamp",
  )

  // Group by trace
  const traceMap = new Map<string, Record<string, any>[]>()
  for (const r of guardrailTraces) {
    const tid = r.trace_id as string
    if (!traceMap.has(tid)) traceMap.set(tid, [])
    traceMap.get(tid)!.push(r)
  }

  // Summarize per-trace guardrail outcome
  let warningOnly = 0
  let warningTerminate = 0
  let directTerminate = 0
  const warningCounts: number[] = []

  for (const [tid, events] of traceMap) {
    const outcome = classifyTrace(events)
    const warns = events.filter((e) => parsePayload(e).decision === 'warning').length
    warningCounts.push(warns)

    if (outcome === 'warning_only') warningOnly++
    else if (outcome === 'warning_then_terminate') warningTerminate++
    else if (outcome === 'direct_terminate') directTerminate++
  }

  console.log(`  Traces with guardrail events: ${traceMap.size}`)
  console.log(`    Warning only (natural end):   ${warningOnly}`)
  console.log(`    Warning → Terminate:          ${warningTerminate}`)
  console.log(`    Direct Terminate (no warn):   ${directTerminate}`)
  console.log(`  Warnings per affected trace:`)
  const sortedW = [...warningCounts].sort((a, b) => a - b)
  console.log(
    `    P50: ${percentile(sortedW, 50)}  P90: ${percentile(sortedW, 90)}  P95: ${percentile(sortedW, 95)}  Max: ${sortedW[sortedW.length - 1]}`,
  )
  console.log()

  // ══════════════════════════════════════════
  // 3. Guardrail Decision Detail
  // ══════════════════════════════════════════
  console.log('── 3. Guardrail Decision Detail ──')
  let idx = 0
  for (const [tid, events] of traceMap) {
    console.log(`  Trace ${tid}:`)
    for (const ev of events) {
      const p = parsePayload(ev)
      const evType = ev.type as string
      const tag = evType === 'guardrail.terminated' ? 'TERM' : 'CHECK'
      const dec = p.decision ?? ''
      const reason = p.reason ?? ''
      console.log(`    [${tag}] turn=${p.turn ?? '?'} decision=${dec} reason="${reason.substring(0, 80)}"`)
    }
    // Calculate outcome
    const outcome = classifyTrace(events)
    if (outcome === 'warning_only') {
      console.log(`    → Warning only — trace continued naturally`)
    } else if (outcome === 'terminated') {
      const p = parsePayload(events[events.length - 1])
      console.log(`    → Terminated at turn ${p.turn} / ${p.totalTurns} total`)
    }
    if (outcome === 'warning_then_terminate') {
      const p = parsePayload(events[events.length - 1])
      console.log(`    → Warning then Terminate at turn ${p.turn} / ${p.totalTurns} total`)
    }
    console.log()
  }

  // ══════════════════════════════════════════
  // 4. Calls per Trace — Guardrail vs Non-Guardrail
  // ══════════════════════════════════════════
  console.log('── 4. Calls/Trace — Guardrail vs Non-Guardrail ──')

  // Get all traces and their event counts
  const traceEventCounts = query(
    db,
    "SELECT trace_id, COUNT(*) as cnt FROM evaluation_events WHERE trace_id IS NOT NULL AND trace_id != '' GROUP BY trace_id ORDER BY cnt DESC",
  )

  // Get terminated traces
  const terminatedTraceIds = new Set(
    query(db, "SELECT DISTINCT trace_id FROM evaluation_events WHERE type='guardrail.terminated'").map((r) => r.trace_id as string),
  )
  const guardrailTraceIds = new Set(
    query(db, "SELECT DISTINCT trace_id FROM evaluation_events WHERE type LIKE 'guardrail.%'").map((r) => r.trace_id as string),
  )

  const nonGuardrailCounts: number[] = []
  const guardrailCounts: number[] = []
  const terminatedCounts: number[] = []

  for (const r of traceEventCounts) {
    const tid = r.trace_id as string
    const cnt = Number(r.cnt)
    if (terminatedTraceIds.has(tid)) {
      terminatedCounts.push(cnt)
    } else if (guardrailTraceIds.has(tid)) {
      guardrailCounts.push(cnt)
    } else {
      nonGuardrailCounts.push(cnt)
    }
  }

  function printDist(label: string, arr: number[]) {
    if (arr.length === 0) {
      console.log(`  ${label}: (no samples)`)
      return
    }
    const sorted = [...arr].sort((a, b) => a - b)
    const sum = sorted.reduce((s, v) => s + v, 0)
    console.log(`  ${label} (n=${arr.length}):`)
    console.log(
      `    Mean: ${(sum / sorted.length).toFixed(1)}  P50: ${percentile(sorted, 50)}  P90: ${percentile(sorted, 90)}  P95: ${percentile(sorted, 95)}  Min: ${sorted[0]}  Max: ${sorted[sorted.length - 1]}`,
    )
  }

  printDist('No guardrail', nonGuardrailCounts)
  printDist(
    'Guardrail (warning only)',
    guardrailCounts.filter(() => true),
  )
  printDist('Guardrail (terminated)', terminatedCounts)

  // Context Inflation in terminated traces
  if (terminatedCounts.length > 0) {
    console.log()
    console.log(`  Terminated trace event counts:`)
    for (const r of traceEventCounts) {
      if (terminatedTraceIds.has(r.trace_id as string)) {
        const perType = query(
          db,
          'SELECT type, COUNT(*) as cnt FROM evaluation_events WHERE trace_id = ? GROUP BY type ORDER BY cnt DESC',
          [r.trace_id],
        )
        const typeStr = perType.map((t) => `${t.type}=${t.cnt}`).join(' ')
        console.log(`    ${r.trace_id}: ${r.cnt} events — ${typeStr}`)
      }
    }
  }

  console.log()

  // ══════════════════════════════════════════
  // 5. Context Inflation
  // ══════════════════════════════════════════
  console.log('── 5. Context Inflation (tokenBreakdown) ──')

  // Get model.invoked events with tokenBreakdown for traces with/without guardrail
  const recentTokenized = query(
    db,
    "SELECT trace_id, payload FROM evaluation_events WHERE type = 'model.invoked' AND payload LIKE '%tokenBreakdown%' ORDER BY timestamp DESC LIMIT 50",
  )

  // Group by trace
  const traceTokens = new Map<string, any[]>()
  for (const r of recentTokenized) {
    const p = parsePayload(r)
    if (p.tokenBreakdown) {
      const tid = r.trace_id as string
      if (!traceTokens.has(tid)) traceTokens.set(tid, [])
      traceTokens.get(tid)!.push(p.tokenBreakdown)
    }
  }

  if (traceTokens.size > 0) {
    // Compute last-turn token breakdown per trace
    const guardrailRatios: Array<{ history: number; tools: number; user: number; total: number }> = []
    const normalRatios: Array<{ history: number; tools: number; user: number; total: number }> = []

    for (const [tid, breakdowns] of traceTokens) {
      // Use last record as representative
      const last = breakdowns[breakdowns.length - 1]
      const total =
        (last.history ?? 0) +
        (last.tools ?? 0) +
        (last.user ?? 0) +
        (last.system ?? 0) +
        (last.memory ?? 0) +
        (last.retrieval ?? 0) +
        (last.runtime ?? 0)
      const entry = {
        history: (last.history ?? 0) / total,
        tools: (last.tools ?? 0) / total,
        user: (last.user ?? 0) / total,
        total,
      }
      if (guardrailTraceIds.has(tid)) {
        guardrailRatios.push(entry)
      } else {
        normalRatios.push(entry)
      }
    }

    function printContext(label: string, arr: Array<{ history: number; tools: number; user: number; total: number }>) {
      if (arr.length === 0) {
        console.log(`  ${label}: (no samples)`)
        return
      }
      const avgHist = arr.reduce((s, v) => s + v.history, 0) / arr.length
      const avgTool = arr.reduce((s, v) => s + v.tools, 0) / arr.length
      const avgUser = arr.reduce((s, v) => s + v.user, 0) / arr.length
      const avgTotal = arr.reduce((s, v) => s + v.total, 0) / arr.length
      console.log(`  ${label} (n=${arr.length}):`)
      console.log(`    History: ${(avgHist * 100).toFixed(1)}%  Tool: ${(avgTool * 100).toFixed(1)}%  User: ${(avgUser * 100).toFixed(1)}%`)
      console.log(`    Avg total tokens: ${avgTotal.toFixed(0)}`)
    }

    printContext('Without guardrail', normalRatios)
    printContext('With guardrail', guardrailRatios)
  } else {
    console.log('  No tokenBreakdown data available.')
  }

  console.log()

  // ══════════════════════════════════════════
  // 6. Summary
  // ══════════════════════════════════════════
  console.log('── 6. Guardrail Summary ──')
  console.log(`  Total traces analyzed: ${distinctTraces}`)
  console.log(`  Traces with guardrail: ${traceMap.size} (${((traceMap.size / distinctTraces) * 100).toFixed(1)}%)`)
  console.log(`  Guardrail events total: ${gTypes.reduce((s, r) => s + Number(r.count), 0)}`)
  console.log()

  if (traceMap.size > 0) {
    console.log(`  State transition breakdown:`)
    console.log(`    Warning only (natural end):   ${warningOnly} (${((warningOnly / traceMap.size) * 100).toFixed(0)}%)`)
    console.log(`    Warning → Terminate:          ${warningTerminate} (${((warningTerminate / traceMap.size) * 100).toFixed(0)}%)`)
    console.log(`    Direct Terminate (no warn):   ${directTerminate} (${((directTerminate / traceMap.size) * 100).toFixed(0)}%)`)
    console.log()
    if (guardrailCounts.length + terminatedCounts.length > 0) {
      const allGuardrail = [...guardrailCounts, ...terminatedCounts].sort((a, b) => a - b)
      const normalSorted = [...nonGuardrailCounts].sort((a, b) => a - b)
      console.log(`  Calls/Trace — Guardrail (P50): ${percentile(allGuardrail, 50)} vs Normal (P50): ${percentile(normalSorted, 50)}`)
      console.log(`  Calls/Trace — Guardrail (P95): ${percentile(allGuardrail, 95)} vs Normal (P95): ${percentile(normalSorted, 95)}`)
    }
  } else {
    console.log(`  No guardrail events recorded — intervention layer has not triggered.`)
  }
  console.log()
  console.log('══════════════════════════════════════════════════════════════')
  console.log(`  Report generated at ${new Date().toISOString()}`)
  console.log('══════════════════════════════════════════════════════════════')

  db.close()
}

main().catch(console.error)
