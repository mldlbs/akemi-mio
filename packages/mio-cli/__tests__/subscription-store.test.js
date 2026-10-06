'use strict'

// Unit tests for server/subscription-store.js — the shared implementation
// behind mio.observer.subscribe / mio.observer.digest. Delivery-once,
// eventTypes/topic filters and cursor tie-breaks are covered by
// server/mio-intelligence-mcp/__tests__/observer-subscribe.test.js and
// observer-digest-cursor.test.js; this file covers the store's own
// subscription lifecycle and the paths those wrapper tests do not reach.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createSubscriptionStore, subscribeKey } = require('../server/subscription-store.js')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-sub-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeStore(dir, overrides = {}) {
  return createSubscriptionStore({
    dataDir: dir,
    projectName: () => 'demo',
    agentId: () => 'tester',
    ...overrides,
  })
}

function appendTrace(dir, event) {
  const line = JSON.stringify({
    id: 'trace_1730000000000_abc001',
    trace_id: 'trace_1730000000000_abc001',
    timestamp: new Date(1730000000000).toISOString(),
    agent: 'tester',
    outcome: 'success',
    ...event,
  })
  fs.appendFileSync(path.join(dir, 'traces.jsonl'), line + '\n', 'utf8')
}

function readSubscriptions(dir) {
  const file = path.join(dir, 'subscriptions.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

test('subscribe upserts by key and normalizes eventTypes and topic', (t) => {
  const dir = tempDir(t)
  const store = makeStore(dir)

  const first = store.subscribe({ eventTypes: [' ERROR ', 'Task_Outcome'], topic: '  ipc  ' })
  assert.equal(first.subscribed, true)
  assert.equal(first.project, 'demo')
  assert.deepEqual(first.subscription.eventTypes, ['error', 'task_outcome'])
  assert.equal(first.subscription.topic, 'ipc')
  assert.ok(first.subscription.expiresAt, 'ttl stamped as absolute ISO time')

  const second = store.subscribe({ eventTypes: ['error', 'task_outcome'], topic: 'ipc' })
  assert.equal(second.subscription.id, first.subscription.id, 'same key must upsert, not duplicate')
  assert.equal(readSubscriptions(dir).length, 1)

  const third = store.subscribe({ topic: 'x'.repeat(200) })
  assert.equal(third.subscription.topic.length, 120, 'topic is truncated to 120 chars')

  assert.equal(subscribeKey('a', 'p', ['error'], 't'), 'a|p|error|t')
})

test('subscribe enforces the per-agent subscription cap', (t) => {
  const dir = tempDir(t)
  const store = makeStore(dir)

  for (let i = 0; i < 20; i++) store.subscribe({ topic: 'topic-' + i })
  assert.equal(readSubscriptions(dir).length, 20)
  assert.throws(() => store.subscribe({ topic: 'topic-overflow' }), /Too many subscriptions for agent tester/)
})

test('digest skips expired subscriptions', (t) => {
  const dir = tempDir(t)
  const store = makeStore(dir)
  store.subscribe({ eventTypes: ['error'], ttlDays: 1 })

  const subs = readSubscriptions(dir)
  subs[0].expiresAt = new Date(Date.now() - 60_000).toISOString()
  fs.writeFileSync(path.join(dir, 'subscriptions.jsonl'), subs.map((s) => JSON.stringify(s)).join('\n') + '\n')

  appendTrace(dir, { event_type: 'error', payload: { msg: 'ipc broke' } })
  const result = store.digest()
  assert.equal(result.subscriptionCount, 0, 'expired subscription must not participate')
  assert.equal(result.count, 0)
})

test('digest writes a wall cursor even when nothing matched, then delivers only later matches', (t) => {
  const dir = tempDir(t)
  const store = makeStore(dir)
  store.subscribe({ topic: 'ipc' })

  // The no-match path stamps the cursor at digest time (wall clock), so the
  // events under test have to be relative to now: a fixed 2024 timestamp
  // would sort before the wall cursor and never deliver again.
  appendTrace(dir, {
    id: 'trace_1730000000000_aaa001',
    timestamp: new Date(Date.now() - 5000).toISOString(),
    event_type: 'error',
    payload: { msg: 'unrelated' },
  })
  const first = store.digest()
  assert.equal(first.count, 0, 'topic mismatch delivers nothing')

  const state = JSON.parse(fs.readFileSync(store.digestStatePath, 'utf8'))
  const entry = Object.values(state)[0]
  assert.ok(entry, 'cursor written despite zero matches')
  assert.equal(entry.id, '', 'empty-id wall cursor keeps same-millisecond events deliverable')

  appendTrace(dir, {
    id: 'trace_1730000000001_bbb002',
    timestamp: new Date().toISOString(),
    event_type: 'error',
    payload: { msg: 'ipc broke' },
  })
  const second = store.digest()
  assert.equal(second.count, 1, 'only the new matching event is delivered')
  assert.equal(second.events[0].payload.msg, 'ipc broke')
})

test('digest filters by subscription project and admits events without a project', (t) => {
  const dir = tempDir(t)
  const store = makeStore(dir)
  store.subscribe({ project: 'demo', eventTypes: ['task_outcome'] })

  appendTrace(dir, { id: 'trace_1730000000000_ccc001', project: 'other', event_type: 'task_outcome' })
  appendTrace(dir, { id: 'trace_1730000000000_ddd002', event_type: 'task_outcome' })
  appendTrace(dir, { id: 'trace_1730000000000_eee003', project: 'demo', event_type: 'task_outcome' })

  const result = store.digest()
  assert.equal(result.count, 2, 'foreign project skipped, projectless event admitted')
  const ids = result.events.map((e) => e.id)
  assert.ok(!ids.includes('trace_1730000000000_ccc001'))
})

test('digest eventTypes filter: empty subscription types match any, empty arg means no filter', (t) => {
  const dir = tempDir(t)
  const store = makeStore(dir)
  store.subscribe({ eventTypes: [] })

  appendTrace(dir, { event_type: 'error', payload: { msg: 'ipc broke' } })

  const filtered = store.digest({ eventTypes: ['error'] })
  assert.equal(filtered.count, 1, 'a subscription with no declared types survives a type filter')

  appendTrace(dir, { id: 'trace_1730000000001_fff002', timestamp: new Date(1730000000001).toISOString(), event_type: 'task_outcome' })
  const unfiltered = store.digest({ eventTypes: [] })
  assert.equal(unfiltered.count, 1, 'an empty eventTypes arg means "no filter", not "match nothing"')

  const typed = makeStore(path.join(dir, 'typed'))
  fs.mkdirSync(path.join(dir, 'typed'), { recursive: true })
  typed.subscribe({ eventTypes: ['task_outcome'] })
  fs.copyFileSync(path.join(dir, 'traces.jsonl'), path.join(dir, 'typed', 'traces.jsonl'))
  const wrongType = typed.digest({ eventTypes: ['error'] })
  assert.equal(wrongType.count, 0, 'subscription types outside the filter drop the subscription entirely')
})

test('digest limit is clamped and the cursor continues where the previous run stopped', (t) => {
  const dir = tempDir(t)
  const store = makeStore(dir)
  store.subscribe({ eventTypes: ['error'] })

  for (let i = 0; i < 3; i++) {
    appendTrace(dir, {
      id: `trace_173000000000${i}_00000${i}`,
      timestamp: new Date(1730000000000 + i * 10).toISOString(),
      event_type: 'error',
      payload: { seq: i },
    })
  }

  const first = store.digest({ limit: 1 })
  assert.equal(first.count, 1, 'limit 1 delivers exactly one event')
  const second = store.digest({ limit: 1 })
  assert.equal(second.count, 1, 'cursor advances so the next event is delivered, not the same one again')
  assert.notEqual(first.events[0].id, second.events[0].id)
  const third = store.digest({ limit: 1 })
  assert.equal(third.count, 1)
  const fourth = store.digest({ limit: 1 })
  assert.equal(fourth.count, 0, 'all events consumed')
})
