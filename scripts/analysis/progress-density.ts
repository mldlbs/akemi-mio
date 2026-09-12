/**
 * Observation v1.2 — Progress Density Analysis
 *
 * 离线重放 ProgressAnalyzer 的分组逻辑，计算两种 Trace 的 Progress Density：
 *   - Healthy Long Traces (≥20 model calls, no guardrail)
 *   - Triggered Traces (any guardrail event)
 *
 * ProgressDensity = ProgressTurns / EligibleTurns
 *   一轮中有 tool.completed / agent.response / task/workflow 事件即为有进展。
 */
import { createRequire } from 'module'

const DB_PATH = 'C:/Users/gf191/AppData/Roaming/akemi-mio/akemi-mio.db'

function query(db: any, sql: string, params?: any[]): Record<string, any>[] {
  // sql.js prepared statement bind is unreliable with sqlite-proxy;
  // use exec() for simplicity.
  const r = db.exec(sql)
  if (!r || !r[0]) return []
  const cols = r[0].columns
  return r[0].values.map((v: any[]) => {
    const obj: Record<string, any> = {}
    cols.forEach((c: string, i: number) => {
      obj[c] = v[i]
    })
    return obj
  })
}

function parsePayload(r: Record<string, any>): any {
  return typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

async function main() {
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
  console.log('║    Observation v1.2 — Progress Density Analysis            ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')

  // ── Identify trace groups ──
  const triggeredIds = new Set(
    query(db, "SELECT DISTINCT trace_id FROM evaluation_events WHERE type LIKE 'guardrail.%'").map((r) => r.trace_id as string),
  )
  console.log(`Triggered trace IDs: ${[...triggeredIds].join(', ')}`)
  console.log()

  // Long traces: ≥20 model.invoked events
  const longTraceIds = query(
    db,
    "SELECT trace_id FROM evaluation_events WHERE type='model.invoked' AND trace_id IS NOT NULL AND trace_id != '' GROUP BY trace_id HAVING COUNT(*) >= 20",
  ).map((r) => r.trace_id as string)

  const healthyLongIds = longTraceIds.filter((id) => !triggeredIds.has(id))
  console.log(`Long traces (≥20 model calls): ${longTraceIds.length}`)
  console.log(`  Healthy (no guardrail): ${healthyLongIds.length}`)
  console.log(`  Triggered: ${longTraceIds.filter((id) => triggeredIds.has(id)).length}`)
  console.log()

  // ── Helper: group events into turns ──
  function computeDensity(events: Record<string, any>[]): {
    density: number
    totalTurns: number
    progressTurns: number
    signalSummary: string
  } {
    const sorted = [...events].sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
    const turns: Array<{ events: Record<string, any>[] }> = []
    let current: Record<string, any>[] = []

    for (const ev of sorted) {
      if (ev.type === 'model.invoked' && current.length > 0) {
        turns.push({ events: current })
        current = [ev]
      } else {
        current.push(ev)
      }
    }
    if (current.length > 0) turns.push({ events: current })

    let progressTurns = 0
    let consecutiveStagnant = 0
    let maxConsecutiveStagnant = 0

    for (const turn of turns) {
      let hasProgress = false
      for (const ev of turn.events) {
        if (
          ['tool.completed', 'agent.response', 'task.started', 'task.completed', 'workflow.started', 'workflow.completed'].includes(ev.type)
        ) {
          hasProgress = true
          break
        }
        // Also check non-empty model output
        if (ev.type === 'model.completed') {
          const p = parsePayload(ev)
          if ((p.responseLength ?? 0) > 20) {
            hasProgress = true
            break
          }
        }
      }
      if (hasProgress) {
        progressTurns++
        consecutiveStagnant = 0
      } else {
        consecutiveStagnant++
        if (consecutiveStagnant > maxConsecutiveStagnant) maxConsecutiveStagnant = consecutiveStagnant
      }
    }

    const density = turns.length > 0 ? progressTurns / turns.length : 0
    return {
      density,
      totalTurns: turns.length,
      progressTurns,
      signalSummary: `density=${(density * 100).toFixed(0)}%  progress=${progressTurns}/${turns.length}  maxStagnant=${maxConsecutiveStagnant}`,
    }
  }

  // ── Helper: escape for SQL injection safety (trace_ids are UUID-like, safe to inline) ──
  function sqlesc(id: string): string {
    return id.replace(/'/g, "''")
  }

  // ── Analyze Healthy Long Traces ──
  console.log('── Healthy Long Traces (≥20 calls, no guardrail) ──')
  const healthyDensities: number[] = []
  const healthyStagnant: number[] = []

  for (const tid of healthyLongIds) {
    const events = query(db, `SELECT type, payload, timestamp FROM evaluation_events WHERE trace_id = '${sqlesc(tid)}' ORDER BY timestamp`)
    const result = computeDensity(events)
    healthyDensities.push(result.density)
    healthyStagnant.push(parseInt(result.signalSummary.match(/maxStagnant=(\d+)/)?.[1] ?? '0'))

    if (healthyLongIds.length <= 15) {
      // Also get token info if available
      const tokenEv = query(
        db,
        `SELECT payload FROM evaluation_events WHERE trace_id = '${sqlesc(tid)}' AND type='model.invoked' AND payload LIKE '%tokenBreakdown%' LIMIT 1`,
      )
      let tokenInfo = ''
      if (tokenEv.length > 0) {
        const p = parsePayload(tokenEv[0])
        if (p.tokenBreakdown) {
          const tb = p.tokenBreakdown
          const total =
            (tb.history ?? 0) +
            (tb.tools ?? 0) +
            (tb.user ?? 0) +
            (tb.system ?? 0) +
            (tb.memory ?? 0) +
            (tb.retrieval ?? 0) +
            (tb.runtime ?? 0)
          tokenInfo = `  hist=${(((tb.history ?? 0) / total) * 100).toFixed(0)}% tools=${(((tb.tools ?? 0) / total) * 100).toFixed(0)}%`
        }
      }
      console.log(`  ${tid}: ${result.signalSummary}${tokenInfo}`)
    }
  }

  const hSorted = [...healthyDensities].sort((a, b) => a - b)
  const hStagSorted = [...healthyStagnant].sort((a, b) => a - b)
  console.log(
    `  Density — P50: ${(percentile(hSorted, 50) * 100).toFixed(0)}%  P90: ${(percentile(hSorted, 90) * 100).toFixed(0)}%  P95: ${(percentile(hSorted, 95) * 100).toFixed(0)}%`,
  )
  console.log(
    `  MaxStagnant — P50: ${percentile(hStagSorted, 50)}  P90: ${percentile(hStagSorted, 90)}  P95: ${percentile(hStagSorted, 95)}`,
  )
  console.log()

  // ── Analyze Triggered Traces ──
  console.log('── Triggered Traces ──')
  const triggeredDensities: number[] = []
  const triggeredStagnant: number[] = []

  for (const tid of triggeredIds) {
    const events = query(db, `SELECT type, payload, timestamp FROM evaluation_events WHERE trace_id = '${sqlesc(tid)}' ORDER BY timestamp`)
    const result = computeDensity(events)

    const guardrailEvs = query(
      db,
      `SELECT payload FROM evaluation_events WHERE trace_id = '${sqlesc(tid)}' AND type LIKE 'guardrail.%' ORDER BY timestamp`,
    )
    const reasons = guardrailEvs
      .map((ev) => {
        const p = parsePayload(ev)
        return `${p.decision ?? 'terminated'}@${p.turn}`
      })
      .join(' → ')

    triggeredDensities.push(result.density)
    triggeredStagnant.push(parseInt(result.signalSummary.match(/maxStagnant=(\d+)/)?.[1] ?? '0'))
    console.log(`  ${tid}: ${result.signalSummary}  guardrail=[${reasons}]`)
  }

  const tSorted = [...triggeredDensities].sort((a, b) => a - b)
  const tStagSorted = [...triggeredStagnant].sort((a, b) => a - b)
  console.log(
    `  Density — P50: ${(percentile(tSorted, 50) * 100).toFixed(0)}%  P90: ${(percentile(tSorted, 90) * 100).toFixed(0)}%  P95: ${(percentile(tSorted, 95) * 100).toFixed(0)}%`,
  )
  console.log(
    `  MaxStagnant — P50: ${percentile(tStagSorted, 50)}  P90: ${percentile(tStagSorted, 90)}  P95: ${percentile(tStagSorted, 95)}`,
  )
  console.log()

  // ── Comparison ──
  console.log('── Comparison Summary ──')
  console.log(`                       Healthy Long (n=${healthyDensities.length})   Triggered (n=${triggeredDensities.length})`)
  console.log(
    `  Density P50:         ${(percentile(hSorted, 50) * 100).toFixed(0)}%                          ${(percentile(tSorted, 50) * 100).toFixed(0)}%`,
  )
  console.log(
    `  Density P90:         ${(percentile(hSorted, 90) * 100).toFixed(0)}%                          ${(percentile(tSorted, 90) * 100).toFixed(0)}%`,
  )
  console.log(`  MaxStagnant P50:     ${percentile(hStagSorted, 50)}                             ${percentile(tStagSorted, 50)}`)
  console.log(`  MaxStagnant P90:     ${percentile(hStagSorted, 90)}                             ${percentile(tStagSorted, 90)}`)

  db.close()
}

main().catch(console.error)
