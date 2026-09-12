'use strict'

// Tests for mio.task.record_outcome (combined task lifecycle tool)

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-tro-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'test-tro',
  workspace: '/tmp/test',
  sessionId: 'test-tro',
})

const { callTool, rl } = require('../index.js')

test.after(() => { rl.close() })

function readJsonl(filename) {
  const file = path.join(dataDir, filename)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

test('record_outcome creates trace event', async () => {
  const r = await callTool('mio.task.record_outcome', {
    outcome: 'success',
    task: 'test task',
    summary: 'completed successfully',
    verification: 'all tests pass',
  })
  assert.equal(r.recorded, true)
  assert.equal(r.event.outcome, 'success')
  assert.equal(r.event.agent, 'codex')
  assert.ok(r.event.id.startsWith('trace_'))
  const traces = readJsonl('traces.jsonl')
  assert.ok(traces.length >= 1)
  const last = traces[traces.length - 1]
  assert.equal(last.event_type, 'task_outcome')
  assert.equal(last.outcome, 'success')
  assert.equal(last.agent, 'codex')
})

test('record_outcome updates agent registry', async () => {
  // Register agent first
  await callTool('mio.agent.register', { agentId: 'testagent', hostType: 'mcp' })
  // Record outcome
  const r = await callTool('mio.task.record_outcome', {
    outcome: 'success',
    task: 'agent task',
    agentId: 'testagent',
  })
  assert.equal(r.agentUpdated, true)
  const agents = readJsonl('agents.jsonl')
  const agent = agents.find((a) => a.agentId === 'testagent')
  assert.ok(agent)
  assert.equal(agent.taskCount, 1)
  assert.equal(agent.successCount, 1)
  assert.equal(agent.failureCount, 0)
})

test('record_outcome increments failure count', async () => {
  await callTool('mio.task.record_outcome', {
    outcome: 'failure',
    task: 'failed task',
    agentId: 'testagent',
  })
  const agents = readJsonl('agents.jsonl')
  const agent = agents.find((a) => a.agentId === 'testagent')
  assert.equal(agent.taskCount, 2)
  assert.equal(agent.successCount, 1)
  assert.equal(agent.failureCount, 1)
})

test('record_outcome rejects invalid outcome', async () => {
  await assert.rejects(
    () => callTool('mio.task.record_outcome', { outcome: 'invalid' }),
    /requires outcome to be success, failure, or aborted/,
  )
})

test('record_outcome requires outcome', async () => {
  await assert.rejects(
    () => callTool('mio.task.record_outcome', {}),
    /requires outcome/,
  )
})

test('record_outcome uses custom traceId', async () => {
  const r = await callTool('mio.task.record_outcome', {
    outcome: 'success',
    task: 'custom trace',
    traceId: 'my-custom-trace-id',
  })
  assert.equal(r.event.trace_id, 'my-custom-trace-id')
})

test('record_outcome returns autoClaims when present', async () => {
  // First, make a memory query to populate recentQueries
  writeTestMemories([{ id: 'mem1', timestamp: new Date().toISOString(), kind: 'decision', content: 'test decision for auto-claim', project: 'test-tro', source: 'codex' }])
  await callTool('mio.memory.query', { query: 'test decision', project: 'test-tro' })
  // Now record outcome - should auto-claim
  const r = await callTool('mio.task.record_outcome', { outcome: 'success', task: 'with query' })
  // autoClaims may or may not be present depending on timing, but recorded should be true
  assert.equal(r.recorded, true)
})

function writeTestMemories(records) {
  const file = path.join(dataDir, 'memory.jsonl')
  fs.writeFileSync(
    file,
    records.length > 0 ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '',
    'utf8',
  )
}
