'use strict'

// Tests for server/query-log.js -- the shared queries.jsonl implementation.
//
// The point of that module is that memoryStore (which records queries) and
// taskStore (which consumes them for auto-claim) share ONE reader/writer. They
// cannot import each other: memoryStore would need taskStore to attribute
// outcomes, and taskStore needs memoryStore for scoring. So the log is its own
// module and both get an instance. The end-to-end test at the bottom is the
// important one: it proves the phase-0 auto-claim chain still works now that the
// two former duplicate implementations are a single one.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createQueryLog, MAX_RECENT_QUERIES } = require('../server/query-log.js')
const { createMemoryStore } = require('../server/memory-store.js')
const { createTaskStore } = require('../server/task-store.js')

function workspace(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-qlog-' + label + '-'))
}

function readQueries(home) {
  const file = path.join(home, 'queries.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function entry(overrides = {}) {
  return {
    agent: 'codex',
    project: 'demo',
    query: 'deploy service',
    resultIds: ['mem_deploy'],
    resultSources: ['codex'],
    timestamp: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  }
}

test('query log records, loads and persists', () => {
  const home = workspace('basic')
  const log = createQueryLog({ dataDir: home })

  assert.equal(log.load().length, 0)

  log.record(entry())
  assert.equal(fs.existsSync(log.queryPath), true)
  assert.equal(log.load().length, 1)
  assert.equal(log.load()[0].query, 'deploy service')
  assert.equal(readQueries(home).length, 1)
})

test('query log drops expired entries on load', () => {
  const home = workspace('expired')
  const log = createQueryLog({ dataDir: home })

  log.record(entry({ expiresAt: Date.now() - 1000 })) // already expired
  log.record(entry({ query: 'still fresh' }))

  const loaded = log.load()
  assert.equal(loaded.length, 1, 'expired entry is filtered out')
  assert.equal(loaded[0].query, 'still fresh')
})

test('query log caps stored entries at the recent-query limit', () => {
  const home = workspace('cap')
  const log = createQueryLog({ dataDir: home })

  for (let i = 0; i < MAX_RECENT_QUERIES + 25; i += 1) {
    log.record(entry({ query: `q${i}` }))
  }
  const stored = readQueries(home)
  assert.equal(stored.length, MAX_RECENT_QUERIES)
  // Keeps the newest, so the first ones are gone.
  assert.equal(stored[0].query, 'q25')
  assert.equal(stored[stored.length - 1].query, `q${MAX_RECENT_QUERIES + 24}`)
})

test('memory store and task store share one query log (auto-claim still works)', () => {
  // This is the regression guard for de-duplicating queries.jsonl: a query
  // recorded by the memory store must be visible to the task store's auto-claim,
  // even though neither can see the other's internals.
  const home = workspace('e2e')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(home, 'memory.jsonl'),
    JSON.stringify({
      id: 'mem_deploy',
      kind: 'decision',
      content: 'deploy the service to production',
      project: 'demo',
      tags: [],
    }) + '\n',
    'utf8'
  )

  // One instance, handed to both stores -- exactly how the MCP server wires it.
  const queryLog = createQueryLog({ dataDir: home })
  const memoryStore = createMemoryStore({
    dataDir: home,
    projectName: () => 'demo',
    agentId: () => 'codex',
    queryLog,
  })
  const taskStore = createTaskStore({
    dataDir: home,
    projectName: () => 'demo',
    memoryStore,
    queryLog,
    agentId: () => 'codex',
  })

  // A query that matches the seeded memory records an entry via the shared log.
  const result = memoryStore.queryMemory({ query: 'deploy service', project: 'demo' })
  assert.ok(result.results.length > 0, 'the seeded memory is found')
  assert.equal(readQueries(home).length, 1, 'query was recorded through the shared log')

  // A later task_outcome from the same agent+project is attributed to it.
  const claims = taskStore.autoClaimExperienceReuse({
    event_type: 'task_outcome',
    agent: 'codex',
    project: 'demo',
    outcome: 'success',
    trace_id: 'trace-1',
  })
  assert.equal(claims.length, 1, 'auto-claim matched the recorded query')
  assert.equal(claims[0].experienceId, 'mem_deploy')
  assert.equal(claims[0].outcomeImproved, true)
  assert.equal(claims[0].source, 'auto_claim')
  // The matched entry is consumed, not left to match again.
  assert.equal(queryLog.load().length, 0)
})

test('a store without an explicit log still uses the same file', () => {
  // The CLI creates the task store with its own instance; it must read the same
  // queries.jsonl, not a parallel one.
  const home = workspace('default')
  const a = createQueryLog({ dataDir: home })
  a.record(entry())

  const logB = createQueryLog({ dataDir: home })
  assert.equal(logB.load().length, 1, 'a second instance sees the same file')
  assert.equal(logB.windowMs, a.windowMs, 'and the same match window')
})
