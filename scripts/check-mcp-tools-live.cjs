#!/usr/bin/env node
// Live gate: every MCP tool the source can dispatch must actually be offered by
// the running server, and vice versa.
//
// Why this exists: TOOLS is assembled with conditional spreads like
//   ...(isInsightAvailable() ? [{ name: 'mio.insight.status', ... }] : [])
// so when an optional package fails to resolve the tool silently disappears from
// tools/list while its dispatch case stays in the switch. That is invisible from
// the source and invisible from the test suite -- it was measured as 35 of 48
// before the workspace fallback was added.
//
// Everything here is discovered. There is no hand-written tool list to rot.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MCP_DIR = path.resolve(__dirname, '..', 'packages', 'mio-cli', 'server', 'mio-intelligence-mcp')
const ENTRY = path.resolve(__dirname, '..', 'packages', 'mio-cli', 'bin', 'mio.js')

// Digits are required: without them /mio\.[a-z.]+/ drops mio.phase0.report.
const NAME_RE = /mio\.[a-zA-Z0-9_.]+/g

function definedTools() {
  const names = new Set()
  for (const file of ['index.js', 'phase0.js']) {
    const src = fs.readFileSync(path.join(MCP_DIR, file), 'utf8')
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

function liveTools() {
  return new Promise((resolve, reject) => {
    // Outside the repo: the server must not leave scratch state in the worktree.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-mcp-gate-'))
    const p = spawn(process.execPath, [ENTRY, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MIO_HOME: home },
    })
    let buf = ''
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error('timed out waiting for tools/list'))
    }, 30000)

    p.stdout.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        if (obj.id === 2 && obj.result && Array.isArray(obj.result.tools)) {
          clearTimeout(timer)
          p.kill()
          resolve(new Set(obj.result.tools.map((t) => t.name)))
          return
        }
      }
    })

    p.on('error', reject)
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
  const live = await liveTools()

  const problems = []

  const definedOnly = diff(defined, dispatched)
  const dispatchedOnly = diff(dispatched, defined)
  if (definedOnly.length) problems.push('defined but never dispatched: ' + definedOnly.join(', '))
  if (dispatchedOnly.length) problems.push('dispatched but never defined: ' + dispatchedOnly.join(', '))

  // The bug this gate exists for: the case is there, the server does not offer it.
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

  console.log('defined: ' + defined.size + ' | dispatched: ' + dispatched.size + ' | live tools/list: ' + live.size)
  if (problems.length) {
    console.error('\n' + problems.join('\n\n'))
    process.exit(1)
  }
  console.log('every dispatchable tool is offered, and every offered tool is dispatchable')
})().catch((err) => {
  console.error('mcp live gate failed: ' + (err && err.message ? err.message : err))
  process.exit(1)
})
