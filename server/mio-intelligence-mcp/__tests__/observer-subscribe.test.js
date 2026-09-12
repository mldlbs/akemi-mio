'use strict'

// Integration test for mio.observer.subscribe + mio.observer.digest (pull-based
// event subscription with cursor). Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-subscribe-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'akemi-mio',
  workspace: 'D:/work/code/akemi-mio',
  sessionId: 'test-session',
})

const { callTool, rl } = require('../index.js')

function ingestEvent(overrides = {}) {
  return callTool('mio.observer.ingest', {
    trace_id: 'trace-test',
    event_type: 'tool_call',
    outcome: 'success',
    payload: { tool: 'shell' },
    ...overrides,
  })
}

test('subscribe returns a subscription and digest starts empty', async () => {
  const project = 'sub-proj-1'
  const subscribeResult = await callTool('mio.observer.subscribe', {
    project,
    eventTypes: ['error'],
  })
  assert.equal(subscribeResult.subscribed, true)
  assert.ok(subscribeResult.subscription.id)
  assert.ok(subscribeResult.subscription.expiresAt)
  assert.deepEqual(subscribeResult.subscription.eventTypes, ['error'])

  const digest = await callTool('mio.observer.digest', { project })
  assert.equal(digest.subscriptionCount, 1)
  assert.equal(digest.count, 0)
  assert.deepEqual(digest.events, [])
})

test('digest delivers new events once and advances the cursor', async () => {
  const project = 'sub-proj-2'
  await callTool('mio.observer.subscribe', { project })
  await callTool('mio.observer.digest', { project })

  await ingestEvent({
    project,
    trace_id: 'trace-error-1',
    event_type: 'error',
    outcome: 'error',
    payload: { message: 'shell command failed' },
  })

  const first = await callTool('mio.observer.digest', { project })
  assert.equal(first.count, 1)
  assert.equal(first.events[0].trace_id, 'trace-error-1')
  assert.equal(first.events[0].event_type, 'error')

  const second = await callTool('mio.observer.digest', { project })
  assert.equal(second.count, 0)
})

test('digest respects eventTypes filter', async () => {
  const project = 'sub-proj-3'
  await callTool('mio.observer.subscribe', {
    project,
    eventTypes: ['error'],
  })
  await callTool('mio.observer.digest', { project })

  await ingestEvent({ project, trace_id: 'trace-tool-1', event_type: 'tool_call', outcome: 'success' })
  await ingestEvent({ project, trace_id: 'trace-err-1', event_type: 'error', outcome: 'error' })

  const digest = await callTool('mio.observer.digest', { project })
  assert.equal(digest.count, 1)
  assert.equal(digest.events[0].trace_id, 'trace-err-1')
})

test('digest respects topic filter', async () => {
  const project = 'sub-proj-4'
  await callTool('mio.observer.subscribe', { project, topic: 'database' })
  await callTool('mio.observer.digest', { project })

  await ingestEvent({
    project,
    trace_id: 'trace-db-1',
    event_type: 'error',
    outcome: 'error',
    payload: { message: 'database connection lost' },
  })
  await ingestEvent({
    project,
    trace_id: 'trace-to-1',
    event_type: 'error',
    outcome: 'error',
    payload: { message: 'request timeout' },
  })

  const digest = await callTool('mio.observer.digest', { project })
  assert.equal(digest.count, 1)
  assert.equal(digest.events[0].trace_id, 'trace-db-1')
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})
