/**
 * P1.3a Capability Routing Report (Upgraded)
 *
 * 验证能力调用链路完整性：
 *   LLM (model.invoked / model.completed)
 *     ↓  Schema Injection Rate — capability.suggested(llm_function_schema) / model.invoked
 *   LLM selected
 *     ↓  Selection Rate — capability.selected / capability_function_calls
 *   ToolInvocationRouter
 *     ↓  Sel→Inv Rate — Router 是否正确分发
 *   CapabilityService.resolve + invoke
 *     ↓  Inv→Comp Rate — Binding + Provider + Tool 链路
 *   ServerManager.callTool(底层工具)
 *
 * 新增：Schema Coverage、LLM Health、Per-capability 全链路表
 *
 * 使用方式：
 *   node scripts/check-capability-shadow.cjs                    # 使用 .capability-shadow-start
 *   node scripts/check-capability-shadow.cjs --since=2026-07-26 # 指定观测起点
 */

const initSqlJs = require('sql.js')
const { join } = require('path')
const { readFileSync, existsSync } = require('fs')

// ═════════════════════════════════════════════════
// Observation Window
// ═════════════════════════════════════════════════

const SINCE_FILE = join(__dirname, '..', '.capability-shadow-start')
let obsSince = 0

const sinceArg = process.argv.find((a) => a.startsWith('--since='))
if (sinceArg) {
  obsSince = new Date(sinceArg.replace('--since=', '')).getTime()
  if (isNaN(obsSince)) {
    console.error('Invalid --since format. Use ISO 8601.')
    process.exit(1)
  }
} else if (existsSync(SINCE_FILE)) {
  try {
    obsSince = JSON.parse(readFileSync(SINCE_FILE, 'utf-8')).startedAt
  } catch {}
}

// ═════════════════════════════════════════════════
// DB access
// ═════════════════════════════════════════════════

const dbPath = join(process.env.APPDATA || '', 'akemi-mio', 'databases', 'events.db')
if (!existsSync(dbPath)) {
  console.error('events.db not found at:', dbPath)
  console.error('Run Mio first to generate event data.')
  process.exit(1)
}
const buffer = readFileSync(dbPath)

initSqlJs().then((SQL) => {
  const db = new SQL.Database(buffer)

  const now = Date.now()
  const w = obsSince > 0 ? obsSince : 0
  const since = w > 0 ? ` AND e.timestamp >= ${w}` : ''
  const sinceNoPrefix = w > 0 ? ` AND timestamp >= ${w}` : ''

  function count(sql) {
    return db.exec(sql)[0]?.values?.[0]?.[0] ?? 0
  }

  function rows(sql) {
    return db.exec(sql)
  }

  // ══════════════════════════════════════════════════
  // 1. LLM Health
  // ══════════════════════════════════════════════════

  const modelInvoked = count(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'model.invoked' ${sinceNoPrefix}`)
  const modelCompleted = count(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'model.completed' ${sinceNoPrefix}`)
  const llmHealthRate = modelInvoked > 0 ? ((modelCompleted / modelInvoked) * 100).toFixed(1) : 'N/A'

  // ══════════════════════════════════════════════════
  // 2. Schema Injection (contextSource split)
  // ══════════════════════════════════════════════════

  const suggestedFnSchema = count(
    `SELECT COUNT(*) FROM evaluation_events WHERE type = 'capability.suggested' AND json_extract(payload, '$.contextSource') = 'llm_function_schema' ${sinceNoPrefix}`,
  )
  const suggestedTextContext = count(
    `SELECT COUNT(*) FROM evaluation_events WHERE type = 'capability.suggested' AND json_extract(payload, '$.contextSource') = 'llm_context' ${sinceNoPrefix}`,
  )
  const suggestedOther = count(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'capability.suggested' AND json_extract(payload, '$.contextSource') NOT IN ('llm_function_schema', 'llm_context') ${sinceNoPrefix}`)

  // Schema injection per model invocation
  const schemaInjectionRate = modelInvoked > 0
    ? (suggestedFnSchema / modelInvoked).toFixed(2)
    : 'N/A'
  // Each model.invoked typically injects N capability schemas (one per registered capability)
  // Expected: suggestedFnSchema ≈ modelInvoked * capabilityCount

  // ══════════════════════════════════════════════════
  // 3. Core capability events
  // ══════════════════════════════════════════════════

  const total = count("SELECT COUNT(*) FROM evaluation_events")
  const totalObs = count(`SELECT COUNT(*) FROM evaluation_events WHERE timestamp >= ${w}`)

  const suggested = count(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'capability.suggested' AND timestamp >= ${w}`)
  const selected = count(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'capability.selected' AND timestamp >= ${w}`)
  const invoked = count(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'capability.invoked' AND timestamp >= ${w}`)
  const completedAll = count(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'capability.completed' AND timestamp >= ${w}`)
  const completedSuccess = count(
    `SELECT COUNT(*) FROM evaluation_events WHERE type = 'capability.completed' AND json_extract(payload, '$.success') = 1 AND timestamp >= ${w}`,
  )
  const completedFailed = count(
    `SELECT COUNT(*) FROM evaluation_events WHERE type = 'capability.completed' AND json_extract(payload, '$.success') = 0 AND timestamp >= ${w}`,
  )
  const toolInvoked = count(`SELECT COUNT(*) FROM evaluation_events WHERE type = 'tool.invoked' AND timestamp >= ${w}`)

  // ══════════════════════════════════════════════════
  // 4. Selection → Invocation 链路
  // ══════════════════════════════════════════════════

  let selectedMatchedInvoked = 0
  let selectedNoInvoked = 0
  let selectedRouterErrors = []
  try {
    const raw = rows(
      `SELECT e1.id, e1.trace_id, json_extract(e1.payload, '$.capability') AS cap,
              e1.timestamp AS selected_at
       FROM evaluation_events e1
       WHERE e1.type = 'capability.selected' ${since.replace(/e\./g, 'e1.')}
         AND NOT EXISTS (
           SELECT 1 FROM evaluation_events e2
           WHERE e2.type = 'capability.invoked'
             AND e2.trace_id = e1.trace_id
             AND json_extract(e2.payload, '$.capability') = json_extract(e1.payload, '$.capability')
             AND e2.timestamp >= e1.timestamp
             AND e2.timestamp <= e1.timestamp + 60000
         )`,
    )
    if (raw[0]) {
      selectedRouterErrors = raw[0].values.map(function (r) {
        return { id: r[0], traceId: r[1], capability: r[2], at: new Date(r[3]).toISOString() }
      })
    }
    selectedNoInvoked = selectedRouterErrors.length
    selectedMatchedInvoked = selected - selectedNoInvoked
  } catch {}

  // ══════════════════════════════════════════════════
  // 5. Invocation → Completed 链路
  // ══════════════════════════════════════════════════

  let invokedMatchedCompleted = 0
  let invokedNotCompleted = []
  try {
    const raw = rows(
      `SELECT e1.id, e1.trace_id, json_extract(e1.payload, '$.capability') AS cap,
              e1.timestamp AS invoked_at
       FROM evaluation_events e1
       WHERE e1.type = 'capability.invoked' ${since.replace(/e\./g, 'e1.')}
         AND NOT EXISTS (
           SELECT 1 FROM evaluation_events e2
           WHERE e2.type = 'capability.completed'
             AND e2.trace_id = e1.trace_id
             AND json_extract(e2.payload, '$.capability') = json_extract(e1.payload, '$.capability')
             AND e2.timestamp >= e1.timestamp
             AND e2.timestamp <= e1.timestamp + 120000
         )`,
    )
    if (raw[0]) {
      invokedNotCompleted = raw[0].values.map(function (r) {
        return { id: r[0], traceId: r[1], capability: r[2], at: new Date(r[3]).toISOString() }
      })
    }
    invokedMatchedCompleted = invoked - invokedNotCompleted.length
  } catch {}

  // ══════════════════════════════════════════════════
  // 6. Per-capability 明细
  // ══════════════════════════════════════════════════

  let perCapSelected = []
  let perCapInvoked = []
  let perCapSuccess = []
  try {
    const rawS = rows(
      `SELECT json_extract(payload, '$.capability') AS cap, COUNT(*) AS cnt
       FROM evaluation_events WHERE type = 'capability.selected' ${since.replace(/e\./g, '')}
       GROUP BY cap ORDER BY cnt DESC`,
    )
    if (rawS[0]) perCapSelected = rawS[0].values.map(function (r) { return { cap: r[0], cnt: r[1] } })

    const rawI = rows(
      `SELECT json_extract(payload, '$.capability') AS cap, COUNT(*) AS cnt
       FROM evaluation_events WHERE type = 'capability.invoked' ${since.replace(/e\./g, '')}
       GROUP BY cap ORDER BY cnt DESC`,
    )
    if (rawI[0]) perCapInvoked = rawI[0].values.map(function (r) { return { cap: r[0], cnt: r[1] } })

    const rawSuc = rows(
      `SELECT json_extract(payload, '$.capability') AS cap, COUNT(*) AS cnt
       FROM evaluation_events
       WHERE type = 'capability.completed'
         AND json_extract(payload, '$.success') = 1 ${since.replace(/e\./g, '')}
       GROUP BY cap ORDER BY cnt DESC`,
    )
    if (rawSuc[0]) perCapSuccess = rawSuc[0].values.map(function (r) { return { cap: r[0], cnt: r[1] } })
  } catch {}

  const perCapMap = {}
  for (const r of perCapSelected) perCapMap[r.cap] = { cap: r.cap, selected: r.cnt, invoked: 0, success: 0, failed: 0 }
  for (const r of perCapInvoked) {
    if (!perCapMap[r.cap]) perCapMap[r.cap] = { cap: r.cap, selected: 0, invoked: r.cnt, success: 0, failed: 0 }
    else perCapMap[r.cap].invoked = r.cnt
  }
  for (const r of perCapSuccess) {
    if (perCapMap[r.cap]) perCapMap[r.cap].success = r.cnt
  }
  const perCapFailedRaw = rows(
    `SELECT json_extract(payload, '$.capability') AS cap, COUNT(*) AS cnt
     FROM evaluation_events
     WHERE type = 'capability.completed'
       AND json_extract(payload, '$.success') = 0 ${since.replace(/e\./g, '')}
     GROUP BY cap`,
  )
  if (perCapFailedRaw[0]) {
    for (const r of perCapFailedRaw[0].values) {
      if (perCapMap[r[0]]) perCapMap[r[0]].failed = r[1]
    }
  }

  const perCapList = Object.values(perCapMap).sort(function (a, b) {
    return b.selected + b.invoked - (a.selected + a.invoked)
  })

  // ══════════════════════════════════════════════════
  // 7. Distinct capabilities (from schema injection)
  // ══════════════════════════════════════════════════

  let distinctCaps = []
  try {
    const raw = rows(
      `SELECT DISTINCT json_extract(payload, '$.capability') AS cap
       FROM evaluation_events
       WHERE type = 'capability.suggested'
         AND json_extract(payload, '$.contextSource') = 'llm_function_schema'
         AND json_extract(payload, '$.capability') IS NOT NULL ${sinceNoPrefix}`,
    )
    if (raw[0]) distinctCaps = raw[0].values.map(function (r) { return r[0] }).filter(Boolean)
  } catch {}

  // ══════════════════════════════════════════════════
  // 8. Schema Coverage — per-capability injection count
  // ══════════════════════════════════════════════════

  let capSchemaCounts = []
  try {
    const raw = rows(
      `SELECT json_extract(payload, '$.capability') AS cap, COUNT(*) AS cnt
       FROM evaluation_events
       WHERE type = 'capability.suggested'
         AND json_extract(payload, '$.contextSource') = 'llm_function_schema'
         AND json_extract(payload, '$.capability') IS NOT NULL ${sinceNoPrefix}
       GROUP BY cap ORDER BY cnt DESC`,
    )
    if (raw[0]) capSchemaCounts = raw[0].values.map(function (r) { return { cap: r[0], cnt: r[1] } })
  } catch {}

  // ══════════════════════════════════════════════════
  // 9. Rates
  // ══════════════════════════════════════════════════

  const selToInvRate = selected > 0 ? ((selectedMatchedInvoked / selected) * 100).toFixed(1) : 'N/A'
  const invToCompRate = invoked > 0 ? ((invokedMatchedCompleted / invoked) * 100).toFixed(1) : 'N/A'
  const invSuccessRate = invoked > 0 ? ((completedSuccess / invoked) * 100).toFixed(1) : 'N/A'
  const invFailedRate = invoked > 0 ? ((completedFailed / invoked) * 100).toFixed(1) : 'N/A'
  const selToCompRate = selected > 0 ? ((completedSuccess / selected) * 100).toFixed(1) : 'N/A'

  // ══════════════════════════════════════════════════
  // Output
  // ══════════════════════════════════════════════════

  console.log('')
  console.log('╔══════════════════════════════════════════════╗')
  console.log('║  P1.3a Capability Routing Report             ║')
  console.log('╠══════════════════════════════════════════════╣')
  console.log(`║  ${new Date(now).toISOString().split('T')[0]}                         ║`)
  console.log(`║  Window: ${obsSince > 0 ? new Date(obsSince).toISOString().split('T')[0] : 'all time'} → ${new Date(now).toISOString().split('T')[0]}         ║`)
  console.log('╚══════════════════════════════════════════════╝')
  console.log('')

  // ── 1. LLM Health ──

  console.log('── 1. LLM API Health ──')
  console.log(`  model.invoked:         ${modelInvoked}`)
  console.log(`  model.completed:       ${modelCompleted}`)
  console.log(`  LLM success rate:      ${llmHealthRate}%`)
  if (modelInvoked > 0 && modelCompleted < modelInvoked) {
    console.log(`  ⚠️  ${modelInvoked - modelCompleted} requests failed — LLM provider unavailable`)
  }
  console.log('')

  // ── 2. Schema Injection ──

  console.log('── 2. Capability Schema Injection ──')
  console.log(`  suggested (fn_schema): ${suggestedFnSchema}`)
  console.log(`  suggested (text_ctx):  ${suggestedTextContext}`)
  console.log(`  suggested (other):     ${suggestedOther}`)
  console.log(`  Schema/model.invoked:  ${schemaInjectionRate}x`)
  console.log(`  Distinct capabilities: ${distinctCaps.length}`)
  console.log('')

  // ── 3. Event Volume ──

  console.log('── 3. Event Volume ──')
  console.log(`  Total events:          ${total}`)
  console.log(`  In window:             ${totalObs}`)
  console.log('')

  // ── 4. Capability Event Flow ──

  console.log('── 4. Capability Event Flow ──')
  console.log(`  capability.suggested:  ${suggested}`)
  console.log(`  capability.selected:   ${selected}`)
  console.log(`  capability.invoked:    ${invoked}`)
  console.log(`  capability.completed:  ${completedAll}  (ok: ${completedSuccess}, fail: ${completedFailed})`)
  console.log(`  tool.invoked:          ${toolInvoked}`)
  console.log('')

  // ── 5. Routing Linkage ──

  console.log('── 5. Routing Linkage ──')
  console.log(`  Sel→Inv:  ${selectedMatchedInvoked}/${selected} = ${selToInvRate}%  ${selectedNoInvoked > 0 ? '⚠️ ' + selectedNoInvoked + ' unmatched' : '✅'}`)
  if (selectedNoInvoked > 0) {
    for (const r of selectedRouterErrors.slice(0, 5)) {
      console.log(`    - ${r.capability} @ ${r.at} (trace: ${r.traceId?.slice(0, 16)})`)
    }
    if (selectedRouterErrors.length > 5) console.log(`    ... and ${selectedRouterErrors.length - 5} more`)
  }
  console.log(`  Inv→Comp: ${invokedMatchedCompleted}/${invoked} = ${invToCompRate}%  ${invokedNotCompleted.length > 0 ? '⚠️ ' + invokedNotCompleted.length + ' incomplete' : '✅'}`)
  if (invokedNotCompleted.length > 0) {
    for (const r of invokedNotCompleted.slice(0, 5)) {
      console.log(`    - ${r.capability} @ ${r.at} (trace: ${r.traceId?.slice(0, 16)})`)
    }
    if (invokedNotCompleted.length > 5) console.log(`    ... and ${invokedNotCompleted.length - 5} more`)
  }
  console.log(`  Sel→Comp: ${completedSuccess}/${selected} = ${selToCompRate}%  (end-to-end)`)
  console.log(`  Inv ok:   ${completedSuccess}/${invoked} = ${invSuccessRate}%`)
  console.log(`  Inv fail: ${completedFailed}/${invoked} = ${invFailedRate}%`)
  console.log('')

  // ── 6. Schema Coverage Table ──

  console.log('── 6. Schema Coverage ──')
  if (capSchemaCounts.length === 0) {
    console.log('  (no function schema events yet)')
  } else {
    console.log(`  ${'Capability'.padEnd(22)} ${'Injected'.padEnd(10)} ${'Count'.padEnd(7)}`)
    console.log(`  ${'─'.repeat(22)} ${'─'.repeat(10)} ${'─'.repeat(7)}`)
    for (const r of capSchemaCounts) {
      console.log(`  ${r.cap.padEnd(22)} ${'✅'.padEnd(10)} ${String(r.cnt).padEnd(7)}`)
    }
  }
  console.log('')

  // ── 7. Per-Capability Routing Table ──

  console.log('── 7. Per-Capability Routing ──')
  if (perCapList.length === 0) {
    console.log('  (no capability routing events yet)')
  } else {
    console.log(`  ${'Capability'.padEnd(20)} ${'Sel'.padEnd(6)} ${'Inv'.padEnd(6)} ${'OK'.padEnd(6)} ${'Fail'.padEnd(6)} ${'S→I%'.padEnd(7)} ${'I→C%'.padEnd(7)} ${'S→C%'.padEnd(7)}`)
    console.log(`  ${'─'.repeat(20)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(7)}`)
    for (const r of perCapList) {
      const sir = r.selected > 0 ? ((Math.min(r.invoked, r.selected) / r.selected) * 100).toFixed(0) + '%' : '-'
      const icr = r.invoked > 0 ? ((Math.min(r.success + r.failed, r.invoked) / r.invoked) * 100).toFixed(0) + '%' : '-'
      const scr = r.selected > 0 ? ((r.success / r.selected) * 100).toFixed(0) + '%' : '-'
      if (r.selected === 0 && r.invoked === 0 && r.success === 0 && r.failed === 0) continue
      console.log(
        `  ${r.cap.padEnd(20)} ${String(r.selected).padEnd(6)} ${String(r.invoked).padEnd(6)} ${String(r.success).padEnd(6)} ${String(r.failed).padEnd(6)} ${sir.padEnd(7)} ${icr.padEnd(7)} ${scr.padEnd(7)}`,
      )
    }
  }
  console.log('')

  // ── 8. Router / Resolver Errors ──

  console.log('── 8. Router / Resolver Errors ──')
  const resolverErrors = invokedNotCompleted.length
  const totalErrors = selectedNoInvoked + resolverErrors
  if (totalErrors === 0) {
    console.log('  ✅ No errors detected')
  } else {
    if (selectedNoInvoked > 0) console.log(`  router:   ${selectedNoInvoked} selected without matching invoked`)
    if (resolverErrors > 0) console.log(`  resolver: ${resolverErrors} invoked without matching completed`)
  }
  console.log('')

  // ── 9. Exit Gates ──

  // Gate conditions: meaningful only when selected > 0 (data exists)
  const hasData = selected > 0
  const gates = [
    ['Selected events >0', hasData, `${selected}`],
    ['Sel→Inv rate ≥80%', !hasData || (selectedMatchedInvoked / selected) >= 0.8, `${selToInvRate}%`],
    ['Inv→Comp rate ≥80%', !hasData || (invokedMatchedCompleted / invoked) >= 0.8, `${invToCompRate}%`],
    ['Invocation success ≥80%', !hasData || (completedSuccess / invoked) >= 0.8, `${invSuccessRate}%`],
    ['Router errors = 0', selectedNoInvoked === 0, `${selectedNoInvoked}`],
    ['Resolver errors = 0', resolverErrors === 0, `${resolverErrors}`],
    ['LLM health ≥50%', modelInvoked === 0 || (modelCompleted / modelInvoked) >= 0.5, `${llmHealthRate}%`],
  ]
  const allPass = gates.every(([, p]) => p === true)

  console.log('── 9. P1.3a Exit Gate ──')
  for (const [name, pass, val] of gates) {
    console.log(`  ${pass ? '✅' : hasData || name === 'Selected events >0' || name === 'LLM health ≥50%' ? '⏸' : '⏸'} ${name.padEnd(32)} ${val}`)
  }

  if (hasData && allPass) {
    console.log(`\n  ✅ ALL GATES PASSED — P1.3b Ready`)
  } else if (hasData) {
    console.log(`\n  ⏸  Linkage incomplete — diagnose errors above`)
  } else {
    console.log(`\n  ⏸  No capability routing data yet (LLM API may be down)`)
    if (modelInvoked > 0 && modelCompleted < modelInvoked) {
      console.log(`  → LLM API returning errors: ${modelInvoked - modelCompleted} failed requests`)
      console.log(`  → Fix provider (Console Go/deepseek-v4-flash) before capability test`)
    }
  }

  db.close()
}).catch((e) => console.error('Error:', e.message))
