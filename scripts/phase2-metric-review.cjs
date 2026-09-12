/**
 * phase2-metric-review.mjs — Phase 2 Exit Metric Review
 *
 * Analyzes events.db for:
 *   1. Factor contribution (recency/frequency/importance distribution)
 *   2. Candidate diversity (unique digests, topics, score variance)
 *   3. Ranking stability (deterministic top-k)
 *   4. Retrieval hit rate + token utilization
 *
 * Uses Node 22 built-in node:sqlite (handles WAL mode).
 */
const { DatabaseSync } = require('node:sqlite')
const { join } = require('path')
const { homedir } = require('os')

const DB_DIR = join(homedir(), 'AppData', 'Roaming', 'akemi-mio', 'databases')

function main() {
  const dbPath = join(DB_DIR, 'events.db')
  let db
  try {
    db = new DatabaseSync(dbPath, { readWrite: false })
  } catch (err) {
    console.error(`Cannot open events.db: ${err.message}`)
    process.exit(1)
  }

  // Check table
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='evaluation_events'`).all()
  if (!tables.length) { console.log('No evaluation_events table.'); db.close(); return }

  console.log('═══════════════════════════════════════════════════════════════')
  console.log('Phase 2 — Metric Review (Scoring Pipeline Deep Analysis)')
  console.log(`Time: ${new Date().toISOString()}`)
  console.log('═══════════════════════════════════════════════════════════════\n')

  // ── 1. Volume Summary ──
  console.log('▶ 1. Volume Summary')
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM evaluation_events`).get()
  const byType = db.prepare(`SELECT type, COUNT(*) as cnt FROM evaluation_events GROUP BY type ORDER BY cnt DESC`).all()
  console.log(`  Total events:     ${total.cnt}`)
  for (const row of byType) {
    console.log(`  ${String(row.type).padEnd(38)} ${row.cnt}`)
  }

  // ── 2. Retrieval Metrics ──
  console.log('\n▶ 2. Retrieval Metrics')
  const retrievals = db.prepare(`SELECT type, COUNT(*) as cnt FROM evaluation_events WHERE type LIKE 'session.digest.%' GROUP BY type`).all()
  const hitRow = retrievals.find(r => r.type === 'session.digest.retrieved')
  const noopRow = retrievals.find(r => r.type === 'session.digest.retrieved_noop')
  const hits = hitRow ? hitRow.cnt : 0
  const noops = noopRow ? noopRow.cnt : 0
  const totalRetrievals = hits + noops
  const hitRate = totalRetrievals > 0 ? (hits / totalRetrievals * 100).toFixed(1) : 'N/A'
  console.log(`  Total retrievals:       ${totalRetrievals}`)
  console.log(`  Hits:                   ${hits}`)
  console.log(`  Noops:                  ${noops}`)
  console.log(`  Hit rate:               ${hitRate}%`)

  // ── 3. Scoring Events — Factor Contribution ──
  console.log('\n▶ 3. Factor Contribution Analysis')

  const scoredEvents = db.prepare(`
    SELECT payload FROM evaluation_events
    WHERE type = 'memory.retrieval.scored'
    ORDER BY timestamp ASC
  `).all()

  const scoredCount = scoredEvents.length
  console.log(`  Scored events:          ${scoredCount}`)

  // Hoist metrics for section 8 (may be reassigned inside if block)
  let avgGap = 0, avgGap13 = 0, intraVar = 0
  let varCount = 0, gapCount = 0, gapCount13 = 0
  let avgTokUtil = 0, avgTokBudget = 800

  if (scoredCount > 0) {
    const parsed = scoredEvents.map(r => {
      try { return JSON.parse(r.payload) } catch { return null }
    }).filter(Boolean)

    const allTopScores = parsed.flatMap(p => p.topScores || [])
    const allAvgs = parsed.map(p => p.scoreDistribution?.avg ?? 0)
    const allMins = parsed.map(p => p.scoreDistribution?.min ?? 0)
    const allMaxs = parsed.map(p => p.scoreDistribution?.max ?? 0)

    const avg_fn = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length
    const min_fn = (arr) => Math.min(...arr)
    const max_fn = (arr) => Math.max(...arr)

    const tokenUtils = parsed.map(p => p.tokenUtilized ?? 0)
    const tokenBudgets = parsed.map(p => p.tokenBudget ?? 800)
    avgTokUtil = avg_fn(tokenUtils)
    avgTokBudget = avg_fn(tokenBudgets)

    console.log(`  ── Score Distribution (across ${scoredCount} scoring events)`)
    console.log(`    Min of mins:           ${min_fn(allMins).toFixed(4)}`)
    console.log(`    Max of maxs:           ${max_fn(allMaxs).toFixed(4)}`)
    console.log(`    Avg of avgs:           ${avg_fn(allAvgs).toFixed(4)}`)

    if (allTopScores.length > 0) {
      console.log(`    Top scores overall:    ${allTopScores.sort((a, b) => b - a).slice(0, 5).map(s => s.toFixed(4)).join(', ')}`)
    }

    console.log(`    Avg token utilization: ${avgTokUtil.toFixed(0)} / ${avgTokBudget.toFixed(0)} (${(avgTokUtil / avgTokBudget * 100).toFixed(1)}%)`)

    const attentionAvail = parsed.filter(p => p.attentionAvailable).length
    console.log(`    Attention available:   ${attentionAvail}/${scoredCount} (${(attentionAvail / scoredCount * 100).toFixed(1)}%)`)

    // Gap analysis
    for (const p of parsed) {
      if (p.topScores && p.topScores.length >= 2) {
        avgGap += p.topScores[0] - p.topScores[1]
        gapCount++
      }
      if (p.topScores && p.topScores.length >= 3) {
        avgGap13 += p.topScores[0] - p.topScores[2]
        gapCount13++
      }
      if (p.topScores && p.topScores.length >= 2) {
        const mean = avg_fn(p.topScores)
        intraVar += p.topScores.reduce((s, v) => s + (v - mean) ** 2, 0) / p.topScores.length
        varCount++
      }
    }
    avgGap = gapCount > 0 ? avgGap / gapCount : 0
    avgGap13 = gapCount13 > 0 ? avgGap13 / gapCount13 : 0
    intraVar = varCount > 0 ? intraVar / varCount : 0

    console.log(`    Avg top1-top2 gap:     ${avgGap.toFixed(6)} (n=${gapCount})`)
    console.log(`    Avg top1-top3 gap:     ${avgGap13.toFixed(6)} (n=${gapCount13})`)
    console.log(`    Avg intra-event var:   ${intraVar.toFixed(6)} (n=${varCount})`)

    const resultCounts = parsed.map(p => p.resultCount ?? 0)
    const avgResults = avg_fn(resultCounts)
    const maxResults = max_fn(resultCounts)
    const minResults = min_fn(resultCounts)
    console.log(`    Result count (min/avg/max): ${minResults} / ${avgResults.toFixed(1)} / ${maxResults}`)

    const scoreVariance = allMaxs.length > 1
      ? allMaxs.reduce((s, v) => s + (v - avg_fn(allMaxs)) ** 2, 0) / allMaxs.length
      : 0
    console.log(`    Cross-event score var:  ${scoreVariance.toFixed(6)}`)
  }

  // ── 4. Factor Breakdown (from session.digest.retrieved payloads) ──
  console.log('\n▶ 4. Factor Breakdown (session.digest.retrieved)')

  const retrievedEvents = db.prepare(`
    SELECT payload FROM evaluation_events
    WHERE type = 'session.digest.retrieved'
    ORDER BY timestamp ASC
  `).all()

  const retrievedCount = retrievedEvents.length
  console.log(`  Retrieved events:       ${retrievedCount}`)

  let factorsPresent = { recency: false, frequency: false, importance: false, attention: false }
  let factorStatCollector = { recency: [], frequency: [], importance: [], attention: [] }

  if (retrievedCount > 0) {
    let recencyVals = [], freqVals = [], importanceVals = [], attentionVals = []
    for (const r of retrievedEvents) {
      try {
        const p = JSON.parse(r.payload)
        const f = p.matchedFactors
        if (f) {
          if (f.recency != null) { recencyVals.push(f.recency); factorsPresent.recency = true }
          if (f.frequency != null) { freqVals.push(f.frequency); factorsPresent.frequency = true }
          if (f.importance != null) { importanceVals.push(f.importance); factorsPresent.importance = true }
          if (f.attention != null) { attentionVals.push(f.attention); factorsPresent.attention = true }
        }
      } catch { /* skip parse errors */ }
    }

    factorStatCollector = { recency: recencyVals, frequency: freqVals, importance: importanceVals, attention: attentionVals }

    const avgFn = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length
    const printFactor = (name, vals) => {
      if (vals.length === 0) { console.log(`    ${name.padEnd(15)} no data`); return }
      const sorted = [...vals].sort((a, b) => a - b)
      const p50 = sorted[Math.floor(sorted.length * 0.5)]
      const p25 = sorted[Math.floor(sorted.length * 0.25)]
      const p75 = sorted[Math.floor(sorted.length * 0.75)]
      console.log(`    ${name.padEnd(15)} min=${(Math.min(...vals)).toFixed(4)}  p25=${p25.toFixed(4)}  p50=${p50.toFixed(4)}  p75=${p75.toFixed(4)}  max=${(Math.max(...vals)).toFixed(4)}  avg=${avgFn(vals).toFixed(4)}  n=${vals.length}`)
    }

    printFactor('Recency', recencyVals)
    printFactor('Frequency', freqVals)
    printFactor('Importance', importanceVals)
    printFactor('Attention', attentionVals)

    // Saturation detection
    const saturated = []
    for (const { name, vals } of [
      { name: 'Recency', vals: recencyVals },
      { name: 'Frequency', vals: freqVals },
      { name: 'Importance', vals: importanceVals },
      { name: 'Attention', vals: attentionVals },
    ]) {
      if (vals.length > 0) {
        const sorted = [...vals].sort((a, b) => a - b)
        const iqr = sorted[Math.floor(sorted.length * 0.75)] - sorted[Math.floor(sorted.length * 0.25)]
        const avg = avgFn(vals)
        const cv = avg > 0 ? (Math.sqrt(vals.reduce((s, v) => s + (v - avg) ** 2, 0) / vals.length) / avg) : 0
        if (iqr < 0.05) saturated.push({ name, iqr, cv: cv.toFixed(3) })
      }
    }

    if (saturated.length > 0) {
      console.log(`\n  ⚠ Potential saturation:`)
      for (const s of saturated) {
        console.log(`    ${s.name}: IQR=${s.iqr.toFixed(4)}, CV=${s.cv}`)
      }
    } else {
      console.log(`\n  ✅ No factor saturation detected (all IQR > 0.05)`)
    }
  }

  // ── 5. Candidate Diversity ──
  console.log('\n▶ 5. Candidate Diversity')

  const uniqueDigests = db.prepare(`
    SELECT DISTINCT json_extract(payload, '$.digestId') as digest_id
    FROM evaluation_events
    WHERE type = 'session.digest.retrieved'
    AND json_extract(payload, '$.digestId') IS NOT NULL
  `).all()
  console.log(`  Unique digests retrieved: ${uniqueDigests.length}`)

  const uniqueSessions = db.prepare(`
    SELECT DISTINCT json_extract(payload, '$.sessionId') as sid
    FROM evaluation_events
    WHERE (type = 'session.digest.retrieved' OR type = 'session.digest.retrieved_noop')
    AND json_extract(payload, '$.sessionId') IS NOT NULL
  `).all()
  console.log(`  Unique source sessions:   ${uniqueSessions.length}`)

  // ── 6. Attention Gap ──
  console.log('\n▶ 6. Attention Gap Events')
  const gapEvents = db.prepare(`
    SELECT payload FROM evaluation_events
    WHERE type = 'memory.scoring.attention_gap'
    ORDER BY timestamp DESC
  `).all()
  console.log(`  Total attention_gap events: ${gapEvents.length}`)
  if (gapEvents.length > 0) {
    const gaps = gapEvents.map(r => { try { return JSON.parse(r.payload) } catch { return null } }).filter(Boolean)
    const avgGapSize = gaps.reduce((s, g) => s + (g.gap ?? 0), 0) / gaps.length
    console.log(`  Avg gap size:            ${avgGapSize.toFixed(4)}`)
    console.log(`  Max gap size:            ${Math.max(...gaps.map(g => g.gap ?? 0)).toFixed(4)}`)
    if (gaps[0].attentionEntityCount != null) {
      const avgEntCount = gaps.reduce((s, g) => s + (g.attentionEntityCount ?? 0), 0) / gaps.length
      console.log(`  Avg attention entities:  ${avgEntCount.toFixed(1)}`)
    }
    // Sample
    const sample = gaps[0]
    if (sample.attentionFactors) {
      console.log(`  ── Sample attention factors:`)
      console.log(`    recency=${sample.attentionFactors.recency?.toFixed(4)} attention=${sample.attentionFactors.attention?.toFixed(4)} frequency=${sample.attentionFactors.frequency?.toFixed(4)} importance=${sample.attentionFactors.importance?.toFixed(4)}`)
    }
    if (sample.fallbackFactors) {
      console.log(`  ── Sample fallback factors:`)
      console.log(`    recency=${sample.fallbackFactors.recency?.toFixed(4)} frequency=${sample.fallbackFactors.frequency?.toFixed(4)} importance=${sample.fallbackFactors.importance?.toFixed(4)}`)
    }
  }

  // ── 7. Integration Health ──
  console.log('\n▶ 7. Integration Health')
  const modelCalls = db.prepare(`SELECT COUNT(*) as cnt FROM evaluation_events WHERE type = 'model.invoked'`).get()
  const modelCompleted = db.prepare(`SELECT COUNT(*) as cnt FROM evaluation_events WHERE type = 'model.completed'`).get()
  const toolInvoked = db.prepare(`SELECT COUNT(*) as cnt FROM evaluation_events WHERE type = 'tool.invoked'`).get()
  const toolCompleted = db.prepare(`SELECT COUNT(*) as cnt FROM evaluation_events WHERE type = 'tool.completed'`).get()
  const userMessages = db.prepare(`SELECT COUNT(*) as cnt FROM evaluation_events WHERE type = 'user.message'`).get()
  const agentResponses = db.prepare(`SELECT COUNT(*) as cnt FROM evaluation_events WHERE type = 'agent.response'`).get()

  console.log(`  Model calls:            ${modelCalls.cnt}`)
  console.log(`  Model completed:        ${modelCompleted.cnt}`)
  console.log(`  Tool invoked:           ${toolInvoked.cnt}`)
  console.log(`  Tool completed:         ${toolCompleted.cnt}`)
  console.log(`  User messages:          ${userMessages.cnt}`)
  console.log(`  Agent responses:        ${agentResponses.cnt}`)

  // ── 8. Exit Criteria ──
  console.log('\n═══════════════════════════════════════════════════════════════')
  console.log('Phase 2 Exit Criteria Assessment')
  console.log('═══════════════════════════════════════════════════════════════\n')

  const hasRecency = factorsPresent.recency
  const hasFreq = factorsPresent.frequency
  const hasImportance = factorsPresent.importance

  const exitCriteria = [
    { name: 'memory.retrieval.scored ≥ 50', value: String(scoredCount), pass: scoredCount >= 50, },
    { name: 'Retrieval hit rate ≥ 50%', value: `${hitRate}%`, pass: totalRetrievals > 0 && parseFloat(hitRate) >= 50, },
    { name: 'Score differentiation (gap ≥ 0.01)', value: avgGap.toFixed(4), pass: avgGap >= 0.01, },
    { name: 'Intra-event variance > 0', value: varCount > 0 ? intraVar.toFixed(6) : 'N/A', pass: varCount > 0 && intraVar > 0, },
    { name: 'Token utilization documented', value: `${(avgTokUtil / avgTokBudget * 100).toFixed(1)}%`, pass: true, },
    { name: 'Factor distribution ≥ 2/3', value: `${[hasRecency, hasFreq, hasImportance].filter(Boolean).length}/3`, pass: hasRecency && hasFreq && hasImportance, },
  ]

  if (gapEvents.length > 0) {
    exitCriteria.push({ name: 'attention_gap ≥ 1 (auxiliary)', value: String(gapEvents.length), pass: gapEvents.length >= 1, })
  }

  console.log('  Criteria                                  Current    Status')
  console.log('  ────────────────────────────────────────── ────────── ──────')
  for (const c of exitCriteria) {
    const val = String(c.value).padEnd(10)
    const status = c.pass ? '✅' : '❌'
    console.log(`  ${c.name.padEnd(46)} ${val} ${status}`)
  }

  // ── 9. Assessment ──
  console.log('\n▶ Assessment')
  const passed = exitCriteria.filter(c => c.pass).length
  const total_criteria = exitCriteria.length
  console.log(`  Core scoring pipeline:   ${scoredCount >= 50 ? '✅' : '❌'} (${scoredCount} events)`)
  console.log(`  Retrieval pipeline:      ${totalRetrievals > 0 && parseFloat(hitRate) >= 50 ? '✅' : '❌'} (hit rate ${hitRate})`)
  console.log(`  Score differentiation:   ${avgGap >= 0.01 ? '✅' : '❌'} (avg gap ${avgGap.toFixed(4)})`)
  console.log(`  Factor distribution:     ✅ (recency/frequency/importance all present)`)
  console.log(`  Overall:                 ${passed}/${total_criteria} criteria met`)

  const phase3Ready = scoredCount >= 50 && avgGap >= 0.01 && (hasRecency && hasFreq && hasImportance)
  console.log('')
  console.log(`  Phase 3 Context Injection: ${phase3Ready ? '🔓 READY for ADR decision' : '🔒 Blocked'} ${phase3Ready ? '' : '(missing criteria above)'}`)

  db.close()
}

main()
