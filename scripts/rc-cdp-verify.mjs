/**
 * Connect to Electron renderer via CDP, send 10 ai:chat messages,
 * then verify ToolDecision log entries against ADR-008 Appendix A.3 baseline.
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

async function main() {
  const ws = new WebSocket(CDP_WS)

  ws.onerror = function (e) { console.error('WS error:', e.message); process.exit(1) }

  const connected = new Promise(function (resolve) {
    ws.onopen = function () { resolve() }
  })

  ws.onmessage = function (event) {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined) {
      const resolve = pending.get(msg.id)
      if (resolve) {
        pending.delete(msg.id)
        resolve(msg)
      }
    }
  }

  await connected
  console.log('CDP connected')

  function send(method, params) {
    params = params || {}
    return new Promise(function (resolve) {
      const id = msgId++
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id: id, method: method, params: params }))
    })
  }

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
      objectGroup: 'mio',
      returnByValue: true,
      awaitPromise: true,
    })

    if (result.error) {
      console.log('CDP error:', result.error)
    } else if (result.result && result.result.exceptionDetails) {
      console.log('Exception:', result.result.exceptionDetails.text)
      console.log(result.result.exceptionDetails.exception ? result.result.exceptionDetails.exception.description : '')
    } else {
      const val = result.result ? result.result.value : null
      const reply = val ? (val.reply || val.error || '(no reply)') : '(no result)'
      console.log(reply.substring(0, 80))
    }

    await new Promise(function (r) { setTimeout(r, 10000) })
  }

  await new Promise(function (r) { setTimeout(r, 5000) })

  const logAfter = readLogLines()
  const newLines = logAfter.slice(beforeCount)
  const decisions = newLines
    .map(function (l) { try { return JSON.parse(l) } catch (e) { return null } })
    .filter(function (e) { return e && e.event === 'behavior_adaptive_scene' })

  console.log('\n' + '='.repeat(95))
  console.log('  ADR-008 真实对话验证报告 — Electron Runtime')
  console.log('  ' + new Date().toISOString())
  console.log('='.repeat(95))
  console.log()
  console.log('  #  text                             scene        pref       reason           filter    prompt  baseline')
  console.log('  ' + '-'.repeat(93))
  console.log('  (found ' + decisions.length + ' entries from ' + newLines.length + ' new log lines)')
  console.log()

  let passed = 0, failed = 0
  const relevant = decisions.slice(-15)

  for (let i = 0; i < SCENARIOS.length; i++) {
    const sc = SCENARIOS[i]
    const baseline = BASELINE[sc.id]
    const entry = relevant[i]
    if (!entry) {
      console.log('  ? ' + String(sc.id).padEnd(3) + ' ' + sc.text.padEnd(32) + ' NO LOG ENTRY')
      failed++
      continue
    }

    const filterStr = entry.toolFilter === undefined ? 'undefined' : String(entry.toolFilter)
    const promptInjected = entry.toolPreference !== 'auto'
    const match = entry.toolPreference === baseline.pref && entry.toolReason === baseline.reason
    if (match) passed++; else failed++

    const marker = match ? 'OK' : 'MISMATCH'
    console.log('  ' + String(sc.id).padEnd(3) + ' ' + sc.text.padEnd(32) + ' ' + String(entry.scene).padEnd(12) + ' ' + String(entry.toolPreference).padEnd(10) + ' ' + String(entry.toolReason).padEnd(18) + ' ' + filterStr.padEnd(9) + ' ' + (promptInjected ? 'YES' : 'NO ') + ' ' + marker + ' ' + baseline.pref + '/' + baseline.reason)
  }

  console.log()
  console.log('  Results: ' + passed + '/' + SCENARIOS.length + ' passed, ' + failed + ' failed')
  console.log()

  ws.close()
  process.exit(0)
}

function readLogLines() {
  try {
    const content = readFileSync(LOG_FILE, 'utf-8')
    return content.split('\n').filter(Boolean)
  } catch (e) {
    return []
  }
}

main()
