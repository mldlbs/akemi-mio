/**
 * Inject a marker, send chat, capture ToolDecision from log by marker.
 * Each scenario in a fresh context via unique requestId.
 */
import { readFileSync } from 'fs'

const APPDATA = process.env.APPDATA || ''
const LOG_FILE = APPDATA + '/akemi-mio/logs/logs/app-2026-07-16.log'
const TARGET_ID = 'C59728D10CA3DB8D77D1A2E9A2D2B4AA'
const CDP_WS = `ws://localhost:9222/devtools/page/${TARGET_ID}`

const SCENARIOS = [
  { id: 1, text: '现在几点了' },
  { id: 2, text: '你好' },
  { id: 3, text: '今天天气怎么样' },
  { id: 4, text: '我刚发了一个文件你看一下' },
  { id: 5, text: '帮我实现一个排序函数' },
  { id: 6, text: '你只会说不会做' },
  { id: 7, text: '用工具查一下这个' },
  { id: 8, text: '今天心情不错' },
  { id: 9, text: '这个bug怎么修' },
  { id: 10, text: '你怎么看这个架构设计' },
]

const BASELINE = {
  1: { pref: 'proactive', reason: 'FRESH_INFORMATION' },
  2: { pref: 'avoid', reason: 'DEFAULT' },
  3: { pref: 'proactive', reason: 'FRESH_INFORMATION' },
  4: { pref: 'proactive', reason: 'FILE_AVAILABLE' },
  5: { pref: 'proactive', reason: 'EXECUTION_TASK' },
  6: { pref: 'proactive', reason: 'META_FEEDBACK' },
  7: { pref: 'proactive', reason: 'USER_REQUEST' },
  8: { pref: 'avoid', reason: 'DEFAULT' },
  9: { pref: 'proactive', reason: 'DEFAULT' },
  10: { pref: 'auto', reason: 'DEFAULT' },
}

let msgId = 1
const pending = new Map()

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

async function main() {
  const ws = new WebSocket(CDP_WS)
  ws.onerror = function (e) { console.error('WS error:', e.message); process.exit(1) }

  await new Promise(function (resolve) { ws.onopen = function () { resolve() } })
  ws.onmessage = function (event) {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined) {
      const resolve = pending.get(msg.id)
      if (resolve) { pending.delete(msg.id); resolve(msg) }
    }
  }
  console.log('CDP connected')

  function send(method, params) {
    params = params || {}
    return new Promise(function (resolve) {
      const id = msgId++
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id: id, method: method, params: params }))
    })
  }

<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
  // Get log size before
  const logBefore = readLogLines()
  const beforeCount = logBefore.length

  for (const sc of SCENARIOS) {
    process.stdout.write('#' + sc.id + ' "' + sc.text + '"... ')
    await send('Runtime.evaluate', {
      expression: "console.log('SCENARIO_" + sc.id + "_START')",
      objectGroup: 'mio',
    })

    const safeText = sc.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    // Use unique sessionId per scenario to isolate conversation context
    const sessionId = 'rc-verify-' + sc.id + '-' + Date.now()
    const result = await send('Runtime.evaluate', {
      expression: 'window.electronAPI.chat("' + safeText + '", undefined, "' + sessionId + '")',
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
=======
  async function evalExpr(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
>>>>>>> Stashed changes
      objectGroup: 'mio',
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.result && r.result.exceptionDetails) {
      return { error: r.result.exceptionDetails.text, desc: r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : '' }
    }
    return { value: r.result ? r.result.value : null }
  }

  // Get log count before
  const beforeCount = readLogLines().length

  for (const sc of SCENARIOS) {
    const marker = 'SCENARIO_' + sc.id + '_' + Date.now()
    process.stdout.write('#' + sc.id + ' "' + sc.text + '"... ')

    // Mark log
    await evalExpr('console.log("' + marker + '")')

    // Call chat
    const safe = sc.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
    const result = await evalExpr('window.electronAPI.chat("' + safe + '")')

    if (result.error) {
      console.log('ERR:', result.error, result.desc)
    } else if (result.value) {
      const v = result.value
      console.log((v.reply || v.error || '(ok)').substring(0, 80))
    } else {
      console.log('(no return value)')
    }

    // Wait for processing to finish
    await sleep(12000)
  }

  await sleep(3000)

  // Now parse all new log entries
  const logAfter = readLogLines()
  const newLines = logAfter.slice(beforeCount)

  // Extract behavior_adaptive_scene entries with their surrounding markers
  const results = []
  let currentScenario = 0
  for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i]
    const markerMatch = line.match(/SCENARIO_(\d+)_\d+/)
    if (markerMatch) {
      currentScenario = parseInt(markerMatch[1])
      continue
    }
    try {
      const entry = JSON.parse(line)
      if (entry.event === 'behavior_adaptive_scene' && currentScenario > 0) {
        results.push({ scenario: currentScenario, entry: entry })
      }
    } catch (e) { /* skip non-json */ }
  }

  console.log('\n' + '='.repeat(95))
  console.log('  ADR-008 真实对话验证报告 — Electron Runtime')
  console.log('  ' + new Date().toISOString())
  console.log('='.repeat(95))
  console.log()

  let passed = 0, failed = 0, issues = []

  for (const sc of SCENARIOS) {
    const baseline = BASELINE[sc.id]
    const matches = results.filter(function (r) { return r.scenario === sc.id })
    // Take the first behavior_adaptive_scene entry (from run(), not toolLoop re-decision)
    const entry = matches.length > 0 ? matches[0].entry : null

    if (!entry) {
      console.log('  ? ' + String(sc.id).padEnd(3) + ' ' + sc.text.padEnd(32) + ' NO LOG ENTRY')
      issues.push('#' + sc.id + ': no log entry')
      failed++
      continue
    }

    const match = entry.toolPreference === baseline.pref && entry.toolReason === baseline.reason
    const filterStr = entry.toolFilter === undefined ? 'undefined' : String(entry.toolFilter)
    const promptInjected = entry.toolPreference !== 'auto'
    const marker = match ? 'OK' : 'MISMATCH'
    if (match) passed++; else failed++
    if (!match) {
      issues.push('#' + sc.id + ' ' + sc.text + ': expected ' + baseline.pref + '/' + baseline.reason + ' got ' + entry.toolPreference + '/' + entry.toolReason + ' (scene=' + entry.scene + ')')
    }

    console.log('  ' + (match ? '✓' : '✗') + ' ' + String(sc.id).padEnd(3) + ' ' + sc.text.padEnd(32) + ' ' + String(entry.scene).padEnd(12) + ' ' + String(entry.toolPreference).padEnd(10) + ' ' + String(entry.toolReason).padEnd(18) + ' ' + filterStr.padEnd(9) + ' ' + (promptInjected ? 'YES' : 'NO ') + ' ' + marker + ' ' + baseline.pref + '/' + baseline.reason)
  }

  console.log('\n  Results: ' + passed + '/' + SCENARIOS.length + ' passed, ' + failed + ' failed')
  if (issues.length > 0) {
    console.log('\n  Issues:')
    for (const iss of issues) {
      console.log('    - ' + iss)
    }
  }
  console.log()
  ws.close()
  process.exit(0)
}

function readLogLines() {
  try {
    const content = readFileSync(LOG_FILE, 'utf-8')
    return content.split('\n').filter(Boolean)
  } catch (e) { return [] }
}

main()
