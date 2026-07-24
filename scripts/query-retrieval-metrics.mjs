#!/usr/bin/env node
/**
 * Retrieval Quality Metrics Query — ADR-013 Phase 2 Scoring Evaluation
 *
 * Usage:
 *   node scripts/query-retrieval-metrics.mjs
 *
 * Reads events.db (sql.js WASM) and main.db.
 * Computes retrieval quality metrics for Phase 2 evaluation.
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

async function main() {
  const SQL = await initSqlJs()

  // ── Load main.db ──
  const mainBuf = readFileSync(join(DB_DIR, 'main.db'))
  const main = new SQL.Database(mainBuf)

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
  }

  console.log('═══════════════════════════════════════════════════')
  console.log('Phase 2 — Retrieval Quality Metrics')
  console.log(`Time: ${new Date().toISOString()}`)
  console.log('═══════════════════════════════════════════════════')
  console.log('')

  // ── 1. Session Compactions (main.db) ──
  console.log('▶ Compaction Coverage')
  const hasCompactions = main.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='session_compactions'`
  )
  if (hasCompactions.length && hasCompactions[0].values.length > 0) {
    const compCount = main.exec('SELECT COUNT(*) FROM session_compactions')[0].values[0][0]
    const sessCount = main.exec("SELECT COUNT(DISTINCT session_id) FROM messages WHERE session_id IS NOT NULL")[0].values[0][0]
    const density = compCount > 0 ? (compCount / Math.max(1, sessCount) * 100).toFixed(1) : '0.0'
    console.log(`  Compaction rows:      ${compCount}`)
    console.log(`  Total sessions:       ${sessCount}`)
    console.log(`  Compaction density:   ${density}%`)

    // Trigger reason breakdown
    const reasons = main.exec(`
      SELECT trigger_reason, COUNT(*) as cnt
      FROM session_compactions
      GROUP BY trigger_reason
      ORDER BY cnt DESC
    `)
    if (reasons.length && reasons[0].values.length > 0) {
      for (const row of reasons[0].values) {
        console.log(`    └ ${String(row[0]).padEnd(22)} ${row[1]}`)
      }
    }

    // Importance score distribution
    const imp = main.exec('SELECT MIN(importance_score), MAX(importance_score), AVG(importance_score) FROM session_compactions')
    if (imp.length && imp[0].values.length > 0) {
      const [imin, imax, iavg] = imp[0].values[0]
      console.log(`  Importance (min/max/avg): ${imin != null ? (+imin).toFixed(2) : 'N/A'} / ${imax != null ? (+imax).toFixed(2) : 'N/A'} / ${iavg != null ? (+iavg).toFixed(2) : 'N/A'}`)
    }
  } else {
    console.log('  No session_compactions table found.')
  }

  console.log('')

  // ── 2. Retrieval Metrics (events.db) ──
  console.log('▶ Retrieval Metrics')
  if (!events) {
    console.log('  events.db unavailable — skipping retrieval metrics.')
    console.log('  These will appear once events.db is readable.')
  } else {
    const hasEventsTable = events.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='evaluation_events'`
    )
    if (!hasEventsTable.length || !hasEventsTable[0].values.length) {
      console.log('  No evaluation_events table.')
    } else {
      // Total retrieval events
      const totalRetrievals = events.exec(`
        SELECT COUNT(*) FROM evaluation_events
        WHERE type = 'session.digest.retrieved' OR type = 'session.digest.retrieved_noop'
      `)[0].values[0][0]
      const noops = events.exec(`
        SELECT COUNT(*) FROM evaluation_events WHERE type = 'session.digest.retrieved_noop'
      `)[0].values[0][0]
      const hits = events.exec(`
        SELECT COUNT(*) FROM evaluation_events WHERE type = 'session.digest.retrieved'
      `)[0].values[0][0]
      const hitRate = totalRetrievals > 0 ? (hits / totalRetrievals * 100).toFixed(1) : 'N/A'
      console.log(`  Total retrievals:       ${totalRetrievals}`)
      console.log(`  Hits:                   ${hits}`)
      console.log(`  Noops:                  ${noops}`)
      console.log(`  Retrieval hit rate:     ${hitRate}%`)

      // Scoring quality events
      const scoredEvents = events.exec(`
        SELECT COUNT(*) FROM evaluation_events WHERE type = 'memory.retrieval.scored'
      `)[0].values[0][0]
      const gapEvents = events.exec(`
        SELECT COUNT(*) FROM evaluation_events WHERE type = 'memory.scoring.attention_gap'
      `)[0].values[0][0]
      console.log(``)
      console.log(`  memory.retrieval.scored:        ${scoredEvents}`)
      console.log(`  memory.scoring.attention_gap:   ${gapEvents}`)

      // Score distribution
      if (scoredEvents > 0) {
        const scoredPayloads = events.exec(`
          SELECT payload FROM evaluation_events
          WHERE type = 'memory.retrieval.scored'
          ORDER BY timestamp DESC
          LIMIT 100
        `)
        if (scoredPayloads.length && scoredPayloads[0].values.length > 0) {
          const allScores = {
            min: [],
            max: [],
            avg: [],
            attentionAvailable: 0,
            total: 0,
            tokenUtilization: [],
            tokenBudget: [],
            resultCounts: [],
          }
          for (const row of scoredPayloads[0].values) {
            const p = JSON.parse(row[0])
            allScores.min.push(p.scoreDistribution.min)
            allScores.max.push(p.scoreDistribution.max)
            allScores.avg.push(p.scoreDistribution.avg)
            allScores.tokenUtilization.push(p.tokenUtilized)
            allScores.tokenBudget.push(p.tokenBudget)
            allScores.resultCounts.push(p.resultCount)
            if (p.attentionAvailable) allScores.attentionAvailable++
            allScores.total++
          }

          const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length
          console.log(``)
          console.log(`  Average score distribution (across ${allScores.total} retrievals):`)
          console.log(`    min:              ${avg(allScores.min).toFixed(4)}`)
          console.log(`    max:              ${avg(allScores.max).toFixed(4)}`)
          console.log(`    avg:              ${avg(allScores.avg).toFixed(4)}`)
          console.log(`    Attention avail:  ${((allScores.attentionAvailable / allScores.total) * 100).toFixed(1)}%`)
          console.log(`    Token util rate:  ${(avg(allScores.tokenUtilization) / avg(allScores.tokenBudget) * 100).toFixed(1)}% (${avg(allScores.tokenUtilization).toFixed(0)} / ${avg(allScores.tokenBudget).toFixed(0)})`)
          console.log(`    Avg result count: ${avg(allScores.resultCounts).toFixed(1)}`)
        }

        // Top scores analysis
        let totalGap = 0
        let gapCount = 0
        for (const row of scoredPayloads[0].values) {
          const p = JSON.parse(row[0])
          if (p.topScores && p.topScores.length >= 2) {
            totalGap += p.topScores[0] - p.topScores[1]
            gapCount++
          }
        }
        if (gapCount > 0) {
          console.log(`    Avg top-1 to top-2 gap: ${(totalGap / gapCount).toFixed(4)}`)
        }
      }

      // Attention gap events
      if (gapEvents > 0) {
        const gaps = events.exec(`
          SELECT payload FROM evaluation_events
          WHERE type = 'memory.scoring.attention_gap'
          ORDER BY timestamp DESC
        `)
        if (gaps.length && gaps[0].values.length > 0) {
          let totalGap = 0
          let count = 0
          for (const row of gaps[0].values) {
            const p = JSON.parse(row[0])
            totalGap += p.gap
            count++
          }
          console.log(`  Attention gap (avg):   ${(totalGap / count).toFixed(4)}`)
        }
      }

      // Latency / timing
      const modelCalls = events.exec(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'model.invoked'`)[0].values[0][0]
      const toolCalls = events.exec(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'tool.invoked'`)[0].values[0][0]
      console.log(`  Total model calls:    ${modelCalls}`)
      console.log(`  Total tool calls:     ${toolCalls}`)
    }
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════')
  console.log('Phase 2 Exit Criteria')
  console.log('═══════════════════════════════════════════════════')
  console.log('')
  console.log('  Criteria                           Current   Target')
  console.log('  ────────────────────────────────── ───────── ────────')

  if (events) {
    const rCount = events.exec(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'memory.retrieval.scored'`)[0].values[0][0]
    const gCount = events.exec(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'memory.scoring.attention_gap'`)[0].values[0][0]
    console.log(`  memory.retrieval.scored ≥ 10       ${String(rCount).padEnd(9)} ${rCount >= 10 ? '✅' : '≥ 10'}`)
    console.log(`  memory.scoring.attention_gap ≥ 1   ${String(gCount).padEnd(9)} ${gCount >= 1 ? '✅' : '≥ 1'}`)
    console.log(`  Score distribution differentiated  ${'(see avg min/max gap)'.padEnd(9)} —`)

    const noopCount = events.exec(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'session.digest.retrieved_noop'`)[0].values[0][0]
    const hitCount = events.exec(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'session.digest.retrieved'`)[0].values[0][0]
    const totalR = noopCount + hitCount
    const hitRate = totalR > 0 ? (hitCount / totalR * 100).toFixed(1) : 'N/A'
    console.log(`  Hit rate documented                ${String(hitRate + '%').padEnd(9)} documented`)
  } else {
    console.log('  (events.db unavailable — cannot evaluate)')
  }

  console.log('')
  console.log('  Phase 3 Context Injection: 🔒 Blocked')
  console.log('  (requires Phase 2 exit criteria + ADR decision)')
  console.log('')

  main.close()
  if (events) events.close()
}

main().catch(console.error)
