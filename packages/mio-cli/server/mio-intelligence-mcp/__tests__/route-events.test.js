'use strict'

// Durable route-adoption evidence (ADR-017 evaluation metrics 1 & 3).
// Before this change those metrics read `queries.jsonl`, a 1-hour auto-claim
// correlation buffer, so in production they were effectively "no data". Routing
// now also appends a durable `route_events.jsonl` entry; evaluation-store reads
// from it. These tests pin both halves: the write (task.route) and the read
// (agent.evaluation).

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-route-evt-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'opencode',
  project: 'akemi-mio',
  workspace: 'D:/work/code/akemi-mio',
  sessionId: 'test-route-events',
})

const { callTool, rl } = require('../index.js')

function writeJsonl(name, records) {
  const file = path.join(dataDir, name)
  fs.writeFileSync(
    file,
    records.length > 0 ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '',
    'utf8',
  )
}
function writeMemories(records) {
  writeJsonl('memory.jsonl', records)
}
function writeReuse(records) {
  writeJsonl('experience_reuse.jsonl', records)
}
function memory(overrides = {}) {
  return {
    id: 'mem-1',
    timestamp: '2026-08-17T00:00:00.000Z',
    kind: 'decision',
    content: 'WorkBuddy 不应使用 MCP 直连，应采用 passive observer 观察会话转录',
    project: 'akemi-mio',
    source: 'codex',
    ...overrides,
  }
}
function verified(overrides = {}) {
  return {
    id: 'x1',
    source: 'auto_claim',
    sourceAgent: 'codex',
    targetAgent: 'opencode',
    experienceId: 'mem-1',
    reuse: true,
    behaviorChanged: true,
    outcomeImproved: true,
    confirmed: true,
    timestamp: '2026-08-17T00:00:00.000Z',
    project: 'akemi-mio',
    ...overrides,
  }
}

test('task.route writes a durable route_events.jsonl entry (survives the 1h buffer)', async () => {
  writeMemories([memory()])
  writeReuse([verified()])
  const result = await callTool('mio.task.route', {
    task: 'WorkBuddy 接入方式 MCP 直连 passive observer',
  })
  assert.equal(result.count, 1)
  const file = path.join(dataDir, 'route_events.jsonl')
  assert.ok(fs.existsSync(file), 'route_events.jsonl should be created')
  const events = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  assert.equal(events.length, 1)
  const evt = events[0]
  assert.equal(evt.project, 'akemi-mio')
  assert.deepEqual(evt.resultIds, ['mem-1'])
  assert.deepEqual(evt.resultSources, ['experience'])
  assert.ok(typeof evt.timestamp === 'string' && !Number.isNaN(Date.parse(evt.timestamp)))
})

test('agent.evaluation reads route adoption from the durable log (not the 1h buffer)', async () => {
  writeMemories([memory()])
  writeReuse([verified()])
  // A prior route decision, recorded durably -- exactly what task.route now writes.
  writeJsonl('route_events.jsonl', [
    {
      id: 'route-1',
      agent: 'opencode',
      project: 'akemi-mio',
      query: 'WorkBuddy 接入',
      resultIds: ['mem-1'],
      resultSources: ['experience'],
      timestamp: new Date().toISOString(),
    },
  ])
  const report = await callTool('mio.agent.evaluation', { project: 'akemi-mio' })
  assert.equal(report.sources.routeAdoption.file, 'route_events.jsonl')
  assert.equal(report.sources.routeAdoption.durable, true)
  assert.equal(report.routeAdoption.routeHits, 1)
  assert.equal(report.routeAdoption.adopted, 1)
  assert.equal(report.routeAdoption.rate, 100)
  assert.equal(report.recallQuality.queriesWithResults, 1)
  assert.equal(report.recallQuality.yield, 100)
})

test('agent.evaluation reports no adoption with an explicit null (not a silent 0%) when the durable log is empty', async () => {
  writeReuse([verified()])
  writeJsonl('route_events.jsonl', []) // empty durable log
  const report = await callTool('mio.agent.evaluation', { project: 'akemi-mio' })
  assert.equal(report.routeAdoption.routeHits, 0)
  assert.equal(report.routeAdoption.rate, null)
})

test('route_events.jsonl is pruned by age (retention AGE_BASED_FILES)', () => {
  // Imported lazily so MIO_DATA_DIR is set first.
  const { createRetention, AGE_BASED_FILES } = require('../../retention.js')
  assert.ok(
    AGE_BASED_FILES.includes('route_events.jsonl'),
    'route_events.jsonl must be registered for age-based pruning',
  )
  const old = new Date(Date.now() - 90 * 86400000).toISOString()
  writeJsonl('route_events.jsonl', [
    { id: 'old', project: 'akemi-mio', resultIds: ['mem-1'], resultSources: ['experience'], timestamp: old },
  ])
  const retention = createRetention({ home: dataDir, now: () => Date.now() })
  const { files } = retention.prune({ days: 30 })
  const plan = files.find((f) => f.file === 'route_events.jsonl')
  assert.ok(plan, 'route_events.jsonl should be pruned')
  assert.equal(plan.total, 1)
  assert.equal(plan.kept, 0)
  assert.equal(plan.removed, 1)
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})
