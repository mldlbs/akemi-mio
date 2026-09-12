'use strict'

// Integration test for the enhanced mio.policy.check (risk level, outcome
// counts, and recent failure examples). Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-policy-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'akemi-mio',
  workspace: 'D:/work/code/akemi-mio',
  sessionId: 'test-session',
})

const { callTool, rl } = require('../index.js')

function writeJsonl(name, records) {
  const file = path.join(dataDir, name)
  fs.writeFileSync(
    file,
    records.length > 0 ? records.map((record) => JSON.stringify(record)).join('\n') + '\n' : '',
    'utf8',
  )
}

function trace(overrides = {}) {
  return {
    id: 'trace-1',
    trace_id: 'tr-1',
    timestamp: '2026-08-17T00:00:00.000Z',
    event_type: 'tool_call',
    outcome: 'success',
    agent: 'codex',
    host: 'mcp',
    project: 'akemi-mio',
    payload: { tool: 'git push production' },
    ...overrides,
  }
}

function memory(overrides = {}) {
  return {
    id: 'mem-1',
    timestamp: '2026-08-15T00:00:00.000Z',
    kind: 'decision',
    content: 'Never deploy to production without a rollback plan (git push).',
    project: 'akemi-mio',
    source: 'codex',
    ...overrides,
  }
}

test('policy.check reports unknown risk when no history matches', async () => {
  writeJsonl('traces.jsonl', [])
  const result = await callTool('mio.policy.check', { action: 'delete staging database' })
  assert.equal(result.total, 0)
  assert.equal(result.risk, null)
  assert.equal(result.riskLevel, 'unknown')
  assert.deepEqual(result.failureExamples, [])
  assert.match(result.suggestion, /No history/)
})

test('policy.check computes risk level and returns failure examples', async () => {
  writeJsonl('traces.jsonl', [
    trace({ id: 't1', trace_id: 'tr-1', event_type: 'tool_call', outcome: 'failure', payload: { tool: 'git push production' }, timestamp: '2026-08-17T01:00:00.000Z' }),
    trace({ id: 't2', trace_id: 'tr-2', event_type: 'task_outcome', outcome: 'success', payload: { summary: 'git push production completed' }, timestamp: '2026-08-17T02:00:00.000Z' }),
    trace({ id: 't3', trace_id: 'tr-3', event_type: 'retry', outcome: 'retry', payload: { tool: 'git' }, timestamp: '2026-08-17T03:00:00.000Z' }),
  ])

  const result = await callTool('mio.policy.check', { action: 'git push production' })
  assert.equal(result.total, 3)
  assert.equal(result.failures, 2)
  assert.ok(Math.abs(result.risk - 0.667) < 0.01)
  assert.equal(result.riskLevel, 'high')
  assert.deepEqual(result.outcomeCounts, { failure: 1, success: 1, retry: 1 })

  assert.equal(result.failureExamples.length, 2)
  assert.equal(result.failureExamples[0].trace_id, 'tr-3')
  assert.equal(result.failureExamples[0].event_type, 'retry')
  assert.equal(result.failureExamples[1].trace_id, 'tr-1')
  assert.match(result.suggestion, /Historically risky/)
})

test('policy.check returns related memories', async () => {
  writeJsonl('memory.jsonl', [memory()])
  const result = await callTool('mio.policy.check', { action: 'git push production' })
  assert.ok(result.related_memories.length >= 1)
  assert.ok(result.related_memories.some((record) => record.id === 'mem-1'))
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})
