/**
 * Trace Forensics: req_173894_42
 *
 * 重组 Evaluation Event 流为 Turn，逐轮分析：
 *   1. 每轮事件类型
 *   2. Progress Signal 状态
 *   3. Guardrail 是否执行及决策
 */
import { createRequire } from 'module'

const DB_PATH = 'C:/Users/gf191/AppData/Roaming/akemi-mio/akemi-mio.db'
const TARGET_TRACE = 'req_173894_42'

function query(db: any, sql: string): Record<string, any>[] {
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
  console.log(`║     Trace Forensics: ${TARGET_TRACE}                    ║`)
  console.log('╚══════════════════════════════════════════════════════════════╝')

  // ── 1. Overview ──
  const total = query(db, `SELECT COUNT(*) as cnt FROM evaluation_events WHERE trace_id = '${TARGET_TRACE}'`)
  console.log(`  Total events: ${total[0]?.cnt ?? '?'}`)

  const types = query(
    db,
    `SELECT type, COUNT(*) as cnt FROM evaluation_events WHERE trace_id = '${TARGET_TRACE}' GROUP BY type ORDER BY cnt DESC`,
  )
  console.log('  Event types:')
  for (const r of types) console.log(`    ${String(r.type).padEnd(25)} ${String(r.cnt).toString().padStart(4)}`)

  const sessionInfo = query(db, `SELECT DISTINCT session_id FROM evaluation_events WHERE trace_id = '${TARGET_TRACE}'`)
  console.log(`  session_id: ${sessionInfo[0]?.session_id ?? '?'}`)

  // Check for guardrail events
  const gEvents = query(db, `SELECT type, payload FROM evaluation_events WHERE trace_id = '${TARGET_TRACE}' AND type LIKE 'guardrail.%'`)
  console.log(`  Guardrail events: ${gEvents.length}`)
  for (const ev of gEvents) {
    const p = parsePayload(ev)
    console.log(`    ${ev.type}: turn=${p.turn} decision=${p.decision ?? '-'} reason="${(p.reason ?? '').substring(0, 80)}"`)
  }
  console.log()

  // ── 2. Check: did this trace ever enter GuardrailPipeline.check()? ──
  // The pipeline checks at turns 5, 10, 15, 20, ...
  // Each check needs: currentTurn >= 5, and currentTurn - lastCheckedTurn >= 5
  // So check triggers at: 5, 10, 15, 20, ...
  const modelCount = query(
    db,
    `SELECT COUNT(*) as cnt FROM evaluation_events WHERE trace_id = '${TARGET_TRACE}' AND type = 'model.invoked'`,
  )
  const totalModelCalls = Number(modelCount[0]?.cnt ?? 0)
  console.log(`  Total model.invoked events: ${totalModelCalls}`)
  console.log(`  Guardrail checks would fire at turns: 5, 10, 15, 20 (interval=5, minTurn=5)`)
  console.log(`  Expected guardrail.checked events: ${Math.max(0, Math.floor(totalModelCalls / 5) - 1)} (turns beyond first check)`)
  console.log()

  // ── 3. Reconstruct Turn Timeline ──
  const events = query(db, `SELECT type, payload, timestamp FROM evaluation_events WHERE trace_id = '${TARGET_TRACE}' ORDER BY timestamp`)

  // Group into turns
  const turns: Array<{ index: number; events: Record<string, any>[] }> = []
  let current: Record<string, any>[] = []
  let turnIndex = 0

  for (const ev of events) {
    if (ev.type === 'model.invoked' && current.length > 0) {
      turns.push({ index: turnIndex, events: current })
      turnIndex++
      current = [ev]
    } else {
      current.push(ev)
    }
  }
  if (current.length > 0) {
    turns.push({ index: turnIndex, events: current })
  }

  console.log(`  Reconstructed turns: ${turns.length}`)
  console.log()

  // ── 4. Per-Turn Analysis ──
  console.log('── PER-TURN ANALYSIS ──')
  console.log('')

  const LOW_OUTPUT_THRESHOLD = 20
  let progressionStagnant = 0 // consecutive turns with no progress
  const guardrailCheckTurns: number[] = []

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    const ev = turn.events
    const index = turn.index
    const displayTurn = index + 1

    // Extract key facts
    const modelInvoked = ev.find((e) => e.type === 'model.invoked')
    const modelCompletedList = ev.filter((e) => e.type === 'model.completed')
    const toolInvokedList = ev.filter((e) => e.type === 'tool.invoked')
    const toolCompletedList = ev.filter((e) => e.type === 'tool.completed')
    const hasAgentResp = ev.some((e) => e.type === 'agent.response')
    const hasTask = ev.some((e) => e.type === 'task.started' || e.type === 'task.completed')
    const hasWorkflow = ev.some((e) => e.type === 'workflow.started' || e.type === 'workflow.completed')

    // Model info
    let modelName = ''
    let inputTokens = 0
    let outputTokens = 0
    let responseLength = 0
    let responsePreview = ''
    let promptTokens = 0

    if (modelInvoked) {
      const p = parsePayload(modelInvoked)
      modelName = p.modelName ?? ''
      promptTokens = p.promptTokens ?? p.promptLength ?? 0
    }
    if (modelCompletedList.length > 0) {
      const p = parsePayload(modelCompletedList[modelCompletedList.length - 1])
      inputTokens = p.inputTokens ?? 0
      outputTokens = p.outputTokens ?? 0
      responseLength = p.responseLength ?? 0
      responsePreview = p.responsePreview ?? ''
      inputTokens = p.inputTokens ?? 0
    }

    // Tool info
    const toolsInvoked = toolInvokedList.map((e) => parsePayload(e).toolName ?? '?').join(', ')
    const toolsCompleted = toolCompletedList
      .map((e) => {
        const p = parsePayload(e)
        return `${p.toolName ?? '?'}(${(p.output ?? '').length}b)`
      })
      .join(', ')

    // Progress signals (mimicking ProgressAnalyzer)
    const hasStateChange = toolCompletedList.length > 0 || hasAgentResp || hasWorkflow || hasTask
    const isLowOutput = responseLength <= LOW_OUTPUT_THRESHOLD
    const hasGoalProgress = hasTask || hasWorkflow

    // Track progression
    if (hasStateChange) {
      progressionStagnant = 0
    } else {
      progressionStagnant++
    }

    // Tool result fingerprints (for novelty detection)
    const toolFingerprints = toolCompletedList.map((e) => {
      const p = parsePayload(e)
      return {
        name: p.toolName ?? '',
        fingerprint: ((p.output ?? '') as string).slice(0, 64),
      }
    })

    // Determine if guardrail should fire at this turn
    // checkIntervalTurns=5, minTurnsBeforeCheck=5
    // Guardrail checks at turn 5, 10, 15, 20...
    const isCheckTurn = displayTurn >= 5 && displayTurn % 5 === 0

    // Detect if guardrail actually fired (from events)
    const guardrailFired = gEvents.some((g) => {
      const p = parsePayload(g)
      return p.turn === displayTurn
    })

    // Print turn summary
    const progressIcon = hasStateChange ? '✓' : '✗'
    const goalIcon = hasGoalProgress ? '✓' : '·'
    const outputStr = isLowOutput ? `LOW(${responseLength})` : `OK(${responseLength})`
    let guardrailStr = ''
    if (isCheckTurn && !guardrailFired) {
      guardrailStr = ' [EXPECTED GUARDRAIL CHECK — NOT FIRED]'
    } else if (guardrailFired) {
      const gEv = gEvents.find((g) => {
        const p = parsePayload(g)
        return p.turn === displayTurn
      })
      if (gEv) {
        const p = parsePayload(gEv)
        guardrailStr = ` [GUARDRAIL → ${p.decision}]`
      }
    }

    // Only print turns with interesting data (skip fully empty turns unless asking)
    const turnSummary = [
      `Turn ${String(displayTurn).padStart(2)}  ` +
        `prog=${progressIcon} goal=${goalIcon} ` +
        `out=${outputStr.padStart(8)} ` +
        `stagnant=${progressionStagnant}  ` +
        `model=${modelName.padEnd(16)} ` +
        `tokens=${String(inputTokens).padStart(6)}i/${String(outputTokens).padStart(4)}o`,
    ]

    if (toolsInvoked) turnSummary.push(`  tools invoked:  ${toolsInvoked}`)
    if (toolsCompleted) turnSummary.push(`  tools complete: ${toolsCompleted}`)
    if (hasAgentResp) turnSummary.push(`  agent.response present`)
    if (hasTask) turnSummary.push(`  task/workflow present`)
    if (guardrailStr) turnSummary.push(`  ${guardrailStr}`)
    if (responsePreview) {
      const preview = responsePreview.substring(0, 80)
      turnSummary.push(`  preview: "${preview}"`)
    }

    console.log(turnSummary.join('\n'))
    console.log()
  }

  // ── 5. Summary ──
  console.log('── FORENSICS CONCLUSION ──')
  if (gEvents.length === 0) {
    console.log(`  Guardrail never fired for this trace (0 guardrail events).`)
    console.log(`  Total turns: ${turns.length}`)
    console.log(`  Checks expected: 5, 10, 15, 20, 25, 30`)
    console.log(`  Candidate hypotheses:`)
    console.log(`    A: Executor returned before toolLoop (non-tool task, guardrail never called)`)
    console.log(`    B: Guardrail was available but skipped this session entirely`)
    console.log(`    C: Trace is from before Guardrail MVP was deployed`)

    // Check if there's any guardrail event BEFORE this trace's timestamp
    const firstEvent = query(db, `SELECT MIN(timestamp) as ts FROM evaluation_events WHERE trace_id = '${TARGET_TRACE}'`)
    const firstTimestamp = (firstEvent[0]?.ts as number) ?? 0
    const anyGuardrailBefore = query(
      db,
      `SELECT COUNT(*) as cnt FROM evaluation_events WHERE type LIKE 'guardrail.%' AND timestamp < ${firstTimestamp}`,
    )
    console.log(`  Guardrail events before this trace: ${anyGuardrailBefore[0]?.cnt ?? '?'}`)
    console.log(`  First guardrail event timestamp vs first trace event:`, firstTimestamp)
  }
  console.log()

  // ── 6. Also check: does this trace have any tool events? ──
  const toolEvents = query(db, `SELECT COUNT(*) as cnt FROM evaluation_events WHERE trace_id = '${TARGET_TRACE}' AND type LIKE 'tool.%'`)
  console.log(`  Tool events in trace: ${toolEvents[0]?.cnt ?? 0}`)

  const agentEvents = query(db, `SELECT COUNT(*) as cnt FROM evaluation_events WHERE trace_id = '${TARGET_TRACE}' AND type LIKE 'agent.%'`)
  console.log(`  Agent events in trace: ${agentEvents[0]?.cnt ?? 0}`)

  const modelEvents = query(
    db,
    `SELECT COUNT(*) as cnt FROM evaluation_events WHERE trace_id = '${TARGET_TRACE}' AND type IN ('model.invoked', 'model.completed')`,
  )
  console.log(`  Model events in trace: ${modelEvents[0]?.cnt ?? 0}`)

  // GuardrailPipeline is created in AppRuntime at line ~253.
  // It's injected via AgentService.setGuardrailPipeline().
  // Guardrail requires this setup — was the session recent?
  const sessionTs = query(
    db,
    `SELECT MIN(timestamp) as firstTs, MAX(timestamp) as lastTs FROM evaluation_events WHERE trace_id = '${TARGET_TRACE}'`,
  )
  if (sessionTs[0]) {
    const first = new Date(Number(sessionTs[0].firstTs)).toISOString()
    const last = new Date(Number(sessionTs[0].lastTs)).toISOString()
    console.log(`  Time range: ${first} → ${last}`)
  }

  db.close()
}

main().catch(console.error)
