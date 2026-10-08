'use strict'

// Spec Capability 2, injection point 2: explicit --source entries win; when
// fewer than two survive, local memory/traces/stored hypotheses top the list
// up. Empty local data keeps the original "at least two --source" contract.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function workspace(seedMemory) {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-topup-'))
  if (seedMemory) {
    fs.writeFileSync(
      path.join(mioHome, 'memory.jsonl'),
      [
        JSON.stringify({ id: 'mem_d1', timestamp: '2026-10-06T01:00:00.000Z', kind: 'decision', content: '决定把 MCP 调用延迟优先优化', project: 'p', scope: 'project' }),
        JSON.stringify({ id: 'mem_n1', timestamp: '2026-10-06T02:00:00.000Z', kind: 'note', content: '延迟优化的周报记录' }),
      ].join('\n') + '\n'
    )
  }
  return { mioHome }
}

// cwd is the temp home so the observer trends provider reads an empty
// <cwd>/.local/observer instead of this checkout's real data; the endpoint is
// refused instantly, so a topped-up run reaches the engine, fails the pair,
// prints the failure, and exits 0 without touching the network.
function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ws.mioHome,
    encoding: 'utf8',
    env: { ...process.env, MIO_HOME: ws.mioHome, LLM_API_URL: 'http://127.0.0.1:9/v1/chat/completions' },
  })
}

test('zero --source tops up from local memory and runs', () => {
  const ws = workspace(true)
  const out = run(ws, ['creativity', 'generate'])
  assert.equal(out.status, 0, out.stderr)
  assert.doesNotMatch(out.stderr, /at least two --source/)
  assert.match(out.stdout, /Generated 0 hypothesis/)
  assert.match(out.stdout, /pair\(s\) failed/)
})

test('a single --source tops up too', () => {
  const ws = workspace(true)
  const out = run(ws, ['creativity', 'generate', '--source', 'auth|token rotation'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /Generated 0 hypothesis/)
})

test('empty local data keeps the original two-source contract', () => {
  const ws = workspace(false)
  const out = run(ws, ['creativity', 'generate'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /at least two --source/)
})

test('two explicit sources still run without needing local data', () => {
  const ws = workspace(false)
  const out = run(ws, ['creativity', 'generate', '--source', 'auth|token rotation', '--source', 'cache|write-through'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /Generated 0 hypothesis/)
})
