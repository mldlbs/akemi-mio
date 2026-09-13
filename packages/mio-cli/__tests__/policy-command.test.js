'use strict'

// Tests for `mio policy check` and the shared policy store. Traces are seeded
// directly into a throwaway MIO_HOME so each risk level can be asserted
// exactly; the CLI reads the global MIO_HOME (not a per-project directory), so
// the workspace helper only needs to control that one directory.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-pol-' + label + '-'))
}

function run(cwd, env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env })
}

function workspace(label) {
  const mioHome = tempDir(label)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-pol-cwd-'))
  const env = { ...process.env, MIO_HOME: mioHome }
  return { mioHome, cwd, env, project: path.basename(cwd) }
}

// Seed traces.jsonl directly: precise control over the failure ratio, which is
// what the risk level is derived from.
function seedTraces(ws, traces) {
  fs.mkdirSync(ws.mioHome, { recursive: true })
  fs.writeFileSync(
    path.join(ws.mioHome, 'traces.jsonl'),
    traces.map((t) => JSON.stringify(t)).join('\n') + '\n',
    'utf8'
  )
}

function trace(project, outcome, payload, eventType = 'task_outcome') {
  return {
    id: 'trace_' + Math.random().toString(16).slice(2),
    timestamp: new Date().toISOString(),
    trace_id: 'tid_' + Math.random().toString(16).slice(2),
    event_type: eventType,
    outcome,
    payload,
    agent: 'test',
    host: 'test',
    project,
  }
}

function policyJson(ws, action, extra = []) {
  const result = run(ws.cwd, ws.env, ['policy', 'check', action, '--json', ...extra])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('policy check reports unknown for an action with no history', () => {
  const ws = workspace('unknown')
  seedTraces(ws, [])

  const payload = policyJson(ws, 'npm publish', ['--project', ws.project])
  assert.equal(payload.total, 0)
  assert.equal(payload.risk, null)
  assert.equal(payload.riskLevel, 'unknown')
  assert.match(payload.suggestion, /No history/)

  const text = run(ws.cwd, ws.env, ['policy', 'check', 'npm publish', '--project', ws.project])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /risk: UNKNOWN/)
  assert.match(text.stdout, /no matching traces/)
})

test('policy check derives risk level from the failure share', () => {
  const ws = workspace('levels')
  // 10 matches, 0 failures -> low
  const low = []
  for (let i = 0; i < 10; i++) {
    low.push(trace(ws.project, 'success', { operation: 'deploy-service' }))
  }
  seedTraces(ws, low)
  const lowResult = policyJson(ws, 'deploy-service', ['--project', ws.project])
  assert.equal(lowResult.total, 10)
  assert.equal(lowResult.failures, 0)
  assert.equal(lowResult.riskLevel, 'low')

  // 12 matches, 3 failures (0.25) -> moderate. The threshold itself is 0.2, so
  // a lower failure share would still read as low.
  const moderate = low.concat([
    trace(ws.project, 'failure', { operation: 'deploy-service' }),
    trace(ws.project, 'failure', { operation: 'deploy-service' }),
    trace(ws.project, 'error', { operation: 'deploy-service' }),
  ])
  seedTraces(ws, moderate)
  const moderateResult = policyJson(ws, 'deploy-service', ['--project', ws.project])
  assert.equal(moderateResult.total, 13)
  assert.equal(moderateResult.failures, 3)
  assert.equal(moderateResult.riskLevel, 'moderate')

  // 10 matches, 8 failures (0.8) -> high
  const high = []
  for (let i = 0; i < 10; i++) {
    high.push(
      trace(ws.project, i < 8 ? 'failure' : 'success', { operation: 'deploy-service' })
    )
  }
  seedTraces(ws, high)
  const highResult = policyJson(ws, 'deploy-service', ['--project', ws.project])
  assert.equal(highResult.total, 10)
  assert.equal(highResult.failures, 8)
  assert.equal(highResult.riskLevel, 'high')
  assert.match(highResult.suggestion, /Historically risky/)
})

test('policy check counts retry and aborted as failures', () => {
  const ws = workspace('outcomes')
  seedTraces(ws, [
    trace(ws.project, 'retry', { operation: 'sync-index' }),
    trace(ws.project, 'aborted', { operation: 'sync-index' }),
    trace(ws.project, 'success', { operation: 'sync-index' }),
    trace(ws.project, 'success', { operation: 'sync-index' }),
  ])

  const payload = policyJson(ws, 'sync-index', ['--project', ws.project])
  assert.equal(payload.total, 4)
  assert.equal(payload.failures, 2, 'retry and aborted both count against the action')
  assert.equal(payload.outcomeCounts.retry, 1)
  assert.equal(payload.outcomeCounts.aborted, 1)
})

test('policy check surfaces recent failure examples', () => {
  const ws = workspace('examples')
  seedTraces(ws, [
    trace(ws.project, 'failure', { operation: 'npm publish', error: 'E403 token lacks bypass_2fa' }),
    trace(ws.project, 'success', { operation: 'npm publish', summary: 'published 0.5.23' }),
  ])

  const payload = policyJson(ws, 'npm publish', ['--project', ws.project])
  assert.equal(payload.failureExamples.length, 1)
  assert.match(payload.failureExamples[0].summary, /E403/)

  const text = run(ws.cwd, ws.env, ['policy', 'check', 'npm publish', '--project', ws.project])
  assert.match(text.stdout, /Recent failures:/)
  assert.match(text.stdout, /E403/)
})

test('policy check respects project isolation', () => {
  const ws = workspace('isolation')
  seedTraces(ws, [
    trace('proj-a', 'failure', { operation: 'rotate-key' }),
    trace('proj-a', 'failure', { operation: 'rotate-key' }),
    trace('proj-b', 'success', { operation: 'rotate-key' }),
    trace('proj-b', 'success', { operation: 'rotate-key' }),
  ])

  const a = policyJson(ws, 'rotate-key', ['--project', 'proj-a'])
  assert.equal(a.total, 2)
  assert.equal(a.failures, 2)
  assert.equal(a.riskLevel, 'high')

  const b = policyJson(ws, 'rotate-key', ['--project', 'proj-b'])
  assert.equal(b.total, 2)
  assert.equal(b.failures, 0)
  assert.equal(b.riskLevel, 'low')
})

test('policy check warns when the match is carried by generic tokens', () => {
  const ws = workspace('lowsignal')
  // Every trace carries these keys, so matching on them says nothing.
  const traces = []
  for (let i = 0; i < 10; i++) {
    traces.push(trace(ws.project, 'success', { task: `work item ${i}`, summary: `did ${i}` }))
  }
  seedTraces(ws, traces)

  const generic = policyJson(ws, 'task', ['--project', ws.project])
  assert.equal(generic.total, 10)
  assert.equal(generic.diagnostics.lowSignal, true)
  assert.deepEqual(generic.diagnostics.genericTokens, ['task'])
  assert.deepEqual(generic.diagnostics.meaningfulTokens, [])

  const text = run(ws.cwd, ws.env, ['policy', 'check', 'task', '--project', ws.project])
  assert.match(text.stdout, /WARNING: low-signal match/)
  assert.match(text.stdout, /Try a more specific action/)

  // A meaningful token must not be flagged.
  seedTraces(ws, traces.concat([trace(ws.project, 'success', { operation: 'build-bundle' })]))
  const specific = policyJson(ws, 'build-bundle', ['--project', ws.project])
  assert.equal(specific.diagnostics.lowSignal, false)
  assert.equal(specific.diagnostics.meaningfulTokens.includes('build'), true)
})

test('policy check notes a low sample size instead of overclaiming', () => {
  const ws = workspace('lowsample')
  // Background traces keep `rare`/`action` from looking corpus-generic, so the
  // lowSignal warning does not fire and the lowSample note is what surfaces.
  const traces = []
  for (let i = 0; i < 20; i++) {
    traces.push(trace(ws.project, 'success', { operation: `routine-task-${i}` }))
  }
  traces.push(trace(ws.project, 'failure', { operation: 'zz-rare-action' }))
  traces.push(trace(ws.project, 'success', { operation: 'zz-rare-action' }))
  seedTraces(ws, traces)

  const payload = policyJson(ws, 'zz-rare-action', ['--project', ws.project])
  assert.equal(payload.total, 2)
  assert.equal(payload.diagnostics.lowSignal, false)
  assert.equal(payload.diagnostics.lowSample, true)

  const text = run(ws.cwd, ws.env, ['policy', 'check', 'zz-rare-action', '--project', ws.project])
  assert.match(text.stdout, /only 2 matching trace\(s\)/)
})

test('policy check keeps flags that belong to the action', () => {
  const ws = workspace('flags')
  seedTraces(ws, [trace(ws.project, 'success', { operation: 'git reset --hard' })])

  // `--hard` is part of the action, not an option to this command.
  const payload = policyJson(ws, 'git reset --hard', ['--project', ws.project])
  assert.equal(payload.action, 'git reset --hard')
  assert.equal(payload.total, 1)

  // Unquoted multi-word actions join up the same way.
  const unquoted = run(ws.cwd, ws.env, ['policy', 'check', 'git', 'reset', '--hard', '--json', '--project', ws.project])
  assert.equal(unquoted.status, 0, unquoted.stderr)
  assert.equal(JSON.parse(unquoted.stdout).action, 'git reset --hard')
})

test('policy subcommand validates its arguments', () => {
  const ws = workspace('usage')
  seedTraces(ws, [])

  const none = run(ws.cwd, ws.env, ['policy'])
  assert.equal(none.status, 1)
  assert.match(none.stdout, /Usage:/)

  const unknown = run(ws.cwd, ws.env, ['policy', 'bogus'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown policy subcommand: bogus/)

  const noAction = run(ws.cwd, ws.env, ['policy', 'check'])
  assert.equal(noAction.status, 1)
  assert.match(noAction.stderr, /requires an action/)

  const help = run(ws.cwd, ws.env, ['policy', 'help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mio policy check/)
})

test('policy check includes related memory ranked by the memory store', () => {
  const ws = workspace('memory')
  seedTraces(ws, [trace(ws.project, 'success', { operation: 'npm publish' })])
  const memPath = path.join(ws.mioHome, 'memory.jsonl')
  fs.writeFileSync(
    memPath,
    [
      JSON.stringify({
        id: 'mem_pub',
        timestamp: new Date().toISOString(),
        kind: 'decision',
        content: 'npm publish requires a granular token with bypass_2fa enabled',
        tags: [],
        project: ws.project,
        scope: 'project',
        source: 'test',
      }),
      JSON.stringify({
        id: 'mem_unrelated',
        timestamp: new Date().toISOString(),
        kind: 'note',
        content: 'unrelated note about wallpaper rendering',
        tags: [],
        project: ws.project,
        scope: 'project',
        source: 'test',
      }),
    ].join('\n') + '\n',
    'utf8'
  )

  const payload = policyJson(ws, 'npm publish', ['--project', ws.project])
  assert.ok(payload.related_memories.length >= 1)
  assert.equal(payload.related_memories[0].id, 'mem_pub')
  assert.ok(
    !payload.related_memories.some((r) => r.id === 'mem_unrelated'),
    'unrelated memory must not match the action'
  )

  const text = run(ws.cwd, ws.env, ['policy', 'check', 'npm publish', '--project', ws.project])
  assert.match(text.stdout, /Related memory:/)
})

test('the CLI and the shared store agree on the same trace set', () => {
  // The MCP server and the CLI both delegate to server/policy-store.js; this
  // pins the shared implementation so the two cannot drift.
  const { createPolicyStore } = require('../server/policy-store.js')
  const { createMemoryStore } = require('../server/memory-store.js')

  const ws = workspace('store')
  const traces = []
  for (let i = 0; i < 10; i++) {
    traces.push(trace(ws.project, i < 3 ? 'failure' : 'success', { operation: 'rollout' }))
  }
  seedTraces(ws, traces)

  const memoryStore = createMemoryStore({ dataDir: ws.mioHome, projectName: () => ws.project })
  const policyStore = createPolicyStore({
    dataDir: ws.mioHome,
    projectName: () => ws.project,
    memoryStore,
  })

  const direct = policyStore.policyCheck({ action: 'rollout', project: ws.project })
  const viaCli = policyJson(ws, 'rollout', ['--project', ws.project])

  assert.equal(direct.total, viaCli.total)
  assert.equal(direct.failures, viaCli.failures)
  assert.equal(direct.risk, viaCli.risk)
  assert.equal(direct.riskLevel, viaCli.riskLevel)
  assert.deepEqual(direct.outcomeCounts, viaCli.outcomeCounts)
  assert.deepEqual(direct.diagnostics, viaCli.diagnostics)

  // A missing action is a programming error in the shared store, too.
  assert.throws(() => policyStore.policyCheck({}), /requires action/)
})
