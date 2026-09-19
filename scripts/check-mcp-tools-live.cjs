#!/usr/bin/env node
// Live gate for the MCP surface. Two independent properties:
//
// 1. Every tool the source can dispatch is actually offered by the running
//    server, and vice versa. TOOLS is assembled with conditional spreads like
//    ...(isInsightAvailable() ? [...] : []), so an optional package that fails
//    to resolve hides a tool from tools/list while its dispatch case survives.
//    Neither the source nor the unit tests can see that -- it measured 35 of 48
//    in this checkout before the workspace fallback was added.
//
// 2. No offered tool blows up when called. A tool can be listed and dispatched
//    and still throw a TypeError the moment it runs, which surfaces to the
//    caller as an opaque "Cannot read properties of undefined". This caught
//    mio.observer.collect / .ferment (an options object passed to a constructor
//    that takes a bare string) and mio.creativity.generate (no sources array).
//
// Everything is discovered. There is no hand-written tool list to rot.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MCP_DIR = path.resolve(__dirname, '..', 'packages', 'mio-cli', 'server', 'mio-intelligence-mcp')
const ENTRY = path.resolve(__dirname, '..', 'packages', 'mio-cli', 'bin', 'mio.js')

const { crashMarker } = require('./lib/crash-messages.cjs')

// Arguments for tools whose empty-args path does real network I/O. observer.collect
// fetches from bilibili/hackernews/rss, so it takes ~30s and then only by luck --
// an unknown source name returns immediately and still constructs the
// ObserverService, which is where its one real bug lived.
//
// Deliberately short. Every entry here is a tool this gate does NOT exercise with
// empty arguments, so the list is checked against the live tool list below and a
// stale entry fails the gate rather than quietly shrinking coverage.
const SAFE_ARGS = {
  'mio.observer.collect': { sources: ['__gate_unknown_source__'] },
}

function definedTools() {
  const names = new Set()
  for (const file of ['index.js', 'phase0.js']) {
    const src = fs.readFileSync(path.join(MCP_DIR, file), 'utf8')
    // Digits are required: without them /mio\.[a-z.]+/ drops mio.phase0.report.
    for (const m of src.matchAll(/name:\s*'(mio\.[a-zA-Z0-9_.]+)'/g)) names.add(m[1])
  }
  return names
}

function dispatchedTools() {
  const src = fs.readFileSync(path.join(MCP_DIR, 'index.js'), 'utf8')
  const names = new Set()
  for (const m of src.matchAll(/case\s*'(mio\.[a-zA-Z0-9_.]+)'/g)) names.add(m[1])
  return names
}

// One server process: list the tools, call every one of them with empty
// arguments, then list again to prove none of the calls killed it.
//
// The calls are strictly sequential -- one request, wait for its response, then
// the next. The server's readline handler does not await, so pipelining all 48
// starts 48 concurrent handlers, and once one of them does real network I/O the
// rest stop coming back at all (measured: 11 of 48). Sequential costs wall clock
// but is deterministic, which is what a gate needs.
function probe(timeoutMs) {
  return new Promise((resolve, reject) => {
    // Outside the repo: the server must not leave scratch state in the worktree.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-mcp-gate-'))
    const p = spawn(process.execPath, [ENTRY, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MIO_HOME: home },
    })

    let buf = ''
    let names = []
    const answers = new Map()
    let survived = false
    let next = 0
    let perCallTimer = null

    const timer = setTimeout(() => {
      if (perCallTimer) clearTimeout(perCallTimer)
      p.kill()
      resolve({ names, answers, survived })
    }, timeoutMs)

    function finish() {
      clearTimeout(timer)
      if (perCallTimer) clearTimeout(perCallTimer)
      p.kill()
      resolve({ names, answers, survived })
    }

    function sendNext() {
      if (next >= names.length) {
        // Final list: a server that died on a call never answers this.
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }) + '\n')
        return
      }
      const i = next
      p.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 100 + i, method: 'tools/call',
        params: { name: names[i], arguments: SAFE_ARGS[names[i]] || {} },
      }) + '\n')
      // Nothing here should take long once network-backed tools have safe
      // arguments, so a tool that never answers is a finding, not a weather
      // report -- it only degrades to a warning if it is tolerated silently.
      perCallTimer = setTimeout(() => { next += 1; sendNext() }, 30000)
    }

    p.on('error', reject)
    p.stdout.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue
        let obj
        try { obj = JSON.parse(line) } catch { continue }

        if (obj.id === 2 && obj.result && Array.isArray(obj.result.tools)) {
          names = obj.result.tools.map((t) => t.name).sort()
          sendNext()
          return
        }

        if (obj.id >= 100) {
          if (perCallTimer) { clearTimeout(perCallTimer); perCallTimer = null }
          answers.set(obj.id, obj.error ? { error: obj.error.message || '' } : { ok: true })
          next += 1
          sendNext()
          return
        }

        if (obj.id === 3 && obj.result && Array.isArray(obj.result.tools)) {
          survived = true
          finish()
        }
      }
    })

    p.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-live-gate', version: '1' } },
    }) + '\n')
    setTimeout(() => {
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
    }, 1500)
  })
}

function diff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort()
}

;(async () => {
  const defined = definedTools()
  const dispatched = dispatchedTools()
  const { names, answers, survived } = await probe(150000)
  const live = new Set(names)

  const problems = []

  const definedOnly = diff(defined, dispatched)
  const dispatchedOnly = diff(dispatched, defined)
  if (definedOnly.length) problems.push('defined but never dispatched: ' + definedOnly.join(', '))
  if (dispatchedOnly.length) problems.push('dispatched but never defined: ' + dispatchedOnly.join(', '))

  const notOffered = diff(dispatched, live)
  if (notOffered.length) {
    problems.push(
      'dispatchable but NOT offered by tools/list (' + notOffered.length + '): ' + notOffered.join(', ') +
      '\n  an isXxxAvailable() gate is swallowing them -- check that the optional package resolves' +
      '\n  (a checkout has no node_modules/@akemi-mio, so stores need the workspace fallback)'
    )
  }

  const extra = diff(live, dispatched)
  if (extra.length) problems.push('offered but has no dispatch case: ' + extra.join(', '))

  // Property 2: no tool may crash on empty arguments.
  const crashed = []
  const unanswered = []
  names.forEach((n, i) => {
    const a = answers.get(100 + i)
    if (!a) { unanswered.push(n); return }
    if (a.ok) return
    const marker = crashMarker(a.error)
    if (marker) crashed.push(n + '  [' + marker + ']  ' + String(a.error).split('\n')[0].slice(0, 120))
  })

  if (crashed.length) {
    problems.push(
      'these tools crash instead of rejecting the empty arguments (' + crashed.length + '):\n  ' +
      crashed.join('\n  ') +
      '\n  a caller sees an opaque TypeError that names neither the tool nor the missing field'
    )
  }

  if (!survived) {
    problems.push('the server stopped answering after the smoke calls -- some tool killed it')
  }

  // A tool that never answers is not verified. Tolerating it as a warning would
  // quietly make this gate blind to that tool, which is how observer.collect
  // stayed broken: the old doc gate skipped it "because it has side effects".
  if (unanswered.length) {
    problems.push('no answer within the timeout, so these tools are NOT verified: ' + unanswered.join(', '))
  }

  const staleSafeArgs = Object.keys(SAFE_ARGS).filter((n) => !live.has(n))
  if (staleSafeArgs.length) {
    problems.push('SAFE_ARGS names tools that no longer exist (coverage is quietly shrinking): ' + staleSafeArgs.join(', '))
  }

  console.log(
    'defined: ' + defined.size + ' | dispatched: ' + dispatched.size + ' | live: ' + live.size +
    ' | called: ' + answers.size + ' | crashed: ' + crashed.length +
    ' | unanswered: ' + unanswered.length + ' | survived: ' + survived
  )
  if (unanswered.length) {
    // Network-backed tools can be slow. Not a failure -- the gate is about
    // crashes, not about reachability.
    console.log('  no answer within the timeout (network-backed?): ' + unanswered.join(', '))
  }

  if (problems.length) {
    console.error('\n' + problems.join('\n\n'))
    process.exit(1)
  }
  console.log('every dispatchable tool is offered, and no offered tool crashes when called')
})().catch((err) => {
  console.error('mcp live gate failed: ' + (err && err.message ? err.message : err))
  process.exit(1)
})
