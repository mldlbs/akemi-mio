'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-traceq-' + label + '-'))
}

function writeTraces(tracePath, traces) {
  fs.writeFileSync(tracePath, traces.map((t) => JSON.stringify(t)).join('\n') + '\n', 'utf8')
}

function makeStore(dataDir) {
  const { createMemoryStore } = require('../server/memory-store.js')
  return createMemoryStore({ dataDir, projectName: () => 'proj-a', agentId: () => 'test' })
}

const H = 3600 * 1000

test('queryTraces filters by type/outcome/agent and summarizes the whole matched set', () => {
  const dataDir = tempDir('filters')
  const store = makeStore(dataDir)
  const now = Date.now()
  writeTraces(store.tracePath, [
    { id: 't1', timestamp: new Date(now - 5 * H).toISOString(), trace_id: 'a:1', event_type: 'task_outcome', outcome: 'success', agent: 'codex', host: 'codex', project: 'proj-a', payload: { summary: 'done one' } },
    { id: 't2', timestamp: new Date(now - 4 * H).toISOString(), trace_id: 'a:2', event_type: 'error', outcome: 'error', agent: 'codex', host: 'codex', project: 'proj-a', payload: {} },
    { id: 't3', timestamp: new Date(now - 3 * H).toISOString(), trace_id: 'b:1', event_type: 'task_outcome', outcome: 'failure', agent: 'claude-code', host: 'claude-code', project: 'proj-a', payload: {} },
    { id: 't4', timestamp: new Date(now - 2 * H).toISOString(), trace_id: 'b:2', event_type: 'task_outcome', outcome: 'success', agent: 'claude-code', host: 'claude-code', project: 'other', payload: {} },
    { id: 't5', timestamp: new Date(now - 1 * H).toISOString(), trace_id: 'a:3', event_type: 'task_outcome', outcome: 'success', agent: 'codex', host: 'codex', project: 'proj-a', payload: { summary: 'done last' } },
  ])

  // default: current project only, newest first
  const all = store.queryTraces({ limit: 10 })
  assert.equal(all.matched, 4, 'project filter excludes other projects by default')
  assert.equal(all.results[0].id, 't5')
  assert.equal(all.results[3].id, 't1')
  assert.deepEqual(all.summary.byOutcome, { success: 2, error: 1, failure: 1 })
  assert.deepEqual(all.summary.byEventType, { task_outcome: 3, error: 1 })
  assert.equal(all.total, 5)

  const errors = store.queryTraces({ event_type: 'error', limit: 5 })
  assert.equal(errors.count, 1)
  assert.equal(errors.results[0].id, 't2')

  const byAgent = store.queryTraces({ agent: 'claude-code' })
  assert.equal(byAgent.matched, 1)
  assert.equal(byAgent.results[0].id, 't3')

  const failures = store.queryTraces({ outcome: 'failure' })
  assert.equal(failures.matched, 1)

  const since = store.queryTraces({ since: now - 2.5 * H })
  assert.equal(since.matched, 1)
  assert.equal(since.results[0].id, 't5')

  // empty-string project disables the project filter
  const allProjects = store.queryTraces({ project: '' })
  assert.equal(allProjects.matched, 5)
})

test('queryTraces supports include_payload=false compact mode and limit paging', () => {
  const dataDir = tempDir('compact')
  const store = makeStore(dataDir)
  const now = Date.now()
  writeTraces(store.tracePath, [
    { id: 't1', timestamp: new Date(now - 2 * H).toISOString(), trace_id: 'a:1', event_type: 'task_outcome', outcome: 'success', agent: 'codex', project: 'proj-a', payload: { summary: 'x'.repeat(300) } },
    { id: 't2', timestamp: new Date(now - 1 * H).toISOString(), trace_id: 'a:2', event_type: 'task_outcome', outcome: 'success', agent: 'codex', project: 'proj-a', payload: { summary: 'y'.repeat(300) } },
  ])

  const compact = store.queryTraces({ include_payload: false })
  assert.equal(compact.count, 2)
  assert.deepEqual(Object.keys(compact.results[0].payload).sort(), ['project', 'trace_id'])

  const paged = store.queryTraces({ limit: 1 })
  assert.equal(paged.count, 1)
  assert.equal(paged.matched, 2, 'summary still covers the full matched set')
  assert.equal(paged.results[0].id, 't2')
})

test('MCP dispatch exposes mio.trace.query', async () => {
  const dataDir = tempDir('mcp')
  process.env.MIO_DATA_DIR = dataDir
  process.env.MIO_CONTEXT = JSON.stringify({ agentId: 'traceq-test', project: 'proj-a' })
  const { TOOLS, callTool, rl } = require('../server/mio-intelligence-mcp/index.js')
  test.after(() => { rl.close() })

  assert.ok(TOOLS.some((tool) => tool.name === 'mio.trace.query'), 'tool registered')

  await callTool('mio.observer.ingest', {
    trace_id: 'x:1',
    event_type: 'task_outcome',
    outcome: 'success',
    project: 'proj-a',
    payload: { summary: 'roundtrip check' },
  })

  const result = await callTool('mio.trace.query', { event_type: 'task_outcome', project: 'proj-a' })
  assert.equal(result.count, 1)
  assert.equal(result.results[0].trace_id, 'x:1')
  assert.equal(result.results[0].payload.summary, 'roundtrip check')
  assert.equal(result.summary.byOutcome.success, 1)
})

test('CLI mio traces lists recent traces with outcome summary', () => {
  const mioHome = tempDir('cli')
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-traceq-cwd-'))
  fs.mkdirSync(mioHome, { recursive: true })
  const now = Date.now()
  writeTraces(path.join(mioHome, 'traces.jsonl'), [
    { id: 'trace_1', timestamp: new Date(now - H).toISOString(), trace_id: 'cli:1', event_type: 'task_outcome', outcome: 'success', agent: 'codex', host: 'codex', project: path.basename(cwd), payload: { summary: 'first task done' } },
    { id: 'trace_2', timestamp: new Date(now).toISOString(), trace_id: 'cli:2', event_type: 'error', outcome: 'error', agent: 'codex', host: 'codex', project: path.basename(cwd), payload: {} },
  ])

  const res = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js'), 'traces', '--limit', '5'],
    { cwd, encoding: 'utf8', env: { ...process.env, MIO_HOME: mioHome } }
  )
  assert.equal(res.status, 0, res.stderr)
  assert.ok(res.stdout.includes('2 matched / 2 total'))
  assert.ok(res.stdout.includes('success=1'))
  assert.ok(res.stdout.includes('error=1'))
  assert.ok(res.stdout.includes('first task done'))

  const jsonRes = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js'), 'traces', '--outcome', 'error', '--json'],
    { cwd, encoding: 'utf8', env: { ...process.env, MIO_HOME: mioHome } }
  )
  assert.equal(jsonRes.status, 0, jsonRes.stderr)
  const payload = JSON.parse(jsonRes.stdout)
  assert.equal(payload.count, 1)
  assert.equal(payload.results[0].event_type, 'error')
})
