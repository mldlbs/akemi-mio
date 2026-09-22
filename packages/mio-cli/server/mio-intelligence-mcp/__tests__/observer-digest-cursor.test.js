'use strict'

// Regression tests for the digest cursor's millisecond tie-break.
//
// Both timestamps involved come from the same wall clock:
//   task-store.js        ingestObservation()  timestamp: new Date().toISOString()
//   subscription-store.js digest()            digestTime = new Date().toISOString()
//
// and the gap between the two is a single small `writeFileSync` (the digest
// writes digest_state.json). Comparing time alone with `eventTime <= cursorTime`
// therefore drops every event that lands in the same millisecond as the cursor
// -- silently, and permanently, because the cursor only ever moves forward.
//
// Measured 2026-09-22: that gap is ~2ms on a Defender-scanned Windows box but
// sub-millisecond on a CI runner, which is why `digest respects topic filter`
// passed 30/30 locally and flaked roughly half the time on CI (#35 red, #36
// green, #37 red, #38 green -- with identical test code in #36 and #37).
//
// Freezing the clock pins every `new Date()` to one instant, so the race stops
// being a matter of luck and becomes deterministic.

const FIXED = Date.parse('2026-09-22T12:00:00.000Z')
const FIXED_ISO = new Date(FIXED).toISOString()

// Must happen before index.js is required.
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED)
    else super(...args)
  }

  static now() {
    return FIXED
  }
}
globalThis.Date = FrozenDate

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-digest-cursor-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'akemi-mio',
  workspace: 'D:/work/code/akemi-mio',
  sessionId: 'test-session',
})

const { callTool, rl } = require('../index.js')

const digestStatePath = path.join(dataDir, 'digest_state.json')

test('delivers an event that shares a millisecond with the digest cursor', async () => {
  const project = 'cursor-proj-1'
  await callTool('mio.observer.subscribe', { project, topic: 'database' })
  const first = await callTool('mio.observer.digest', { project })
  assert.equal(first.count, 0)

  // Same frozen millisecond as the cursor that digest just parked.
  await callTool('mio.observer.ingest', {
    project,
    trace_id: 'trace-db-1',
    event_type: 'error',
    outcome: 'error',
    payload: { message: 'database connection lost' },
  })

  const digest = await callTool('mio.observer.digest', { project })
  assert.equal(digest.count, 1, 'an event sharing a millisecond with the cursor must still be delivered')
  assert.equal(digest.events[0].trace_id, 'trace-db-1')
})

test('does not deliver the same event twice when everything shares a millisecond', async () => {
  const project = 'cursor-proj-2'
  await callTool('mio.observer.subscribe', { project, topic: 'database' })
  await callTool('mio.observer.ingest', {
    project,
    trace_id: 'trace-db-2',
    event_type: 'error',
    outcome: 'error',
    payload: { message: 'database connection lost' },
  })

  const first = await callTool('mio.observer.digest', { project })
  assert.equal(first.count, 1)

  // The cursor now sits at the delivered event's own millisecond, so the
  // tie-break has to exclude that exact event without excluding its neighbours.
  const second = await callTool('mio.observer.digest', { project })
  assert.equal(second.count, 0, 'the same event must not be delivered twice')
})

test('a legacy string cursor keeps the old inclusive comparison', async () => {
  const project = 'cursor-proj-3'
  const subscribed = await callTool('mio.observer.subscribe', { project })
  const subscriptionId = subscribed.subscription.id

  // Pre-tie-break state files stored a bare ISO string. Upgrading must not
  // re-deliver events that the old inclusive comparison had already consumed.
  fs.writeFileSync(digestStatePath, JSON.stringify({ [subscriptionId]: FIXED_ISO }), 'utf8')

  await callTool('mio.observer.ingest', {
    project,
    trace_id: 'trace-legacy-1',
    event_type: 'error',
    outcome: 'error',
    payload: { message: 'anything' },
  })

  const digest = await callTool('mio.observer.digest', { project })
  assert.equal(digest.count, 0, 'a legacy cursor compares inclusively on time, so no re-delivery')
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})
