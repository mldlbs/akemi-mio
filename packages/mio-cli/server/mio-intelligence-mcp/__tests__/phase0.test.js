'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  analyzePhase0,
  loadPhase0,
  renderPhase0Markdown,
  summarizePhase0,
  PHASE0_THRESHOLDS,
} = require('../phase0')

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-phase0-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function memory(overrides = {}) {
  return {
    id: 'mem-1',
    timestamp: '2026-08-15T00:00:00.000Z',
    kind: 'decision',
    content: 'decided to use shared memory',
    project: 'akemi-mio',
    source: 'codex',
    ...overrides,
  }
}

function trace(overrides = {}) {
  return {
    id: 'trace-1',
    timestamp: '2026-08-15T00:00:00.000Z',
    trace_id: 'task-1',
    event_type: 'task_outcome',
    outcome: 'success',
    agent: 'codex',
    host: 'mcp',
    project: 'akemi-mio',
    ...overrides,
  }
}

function reuse(overrides = {}) {
  return {
    id: 'xfer-1',
    timestamp: '2026-08-15T00:00:00.000Z',
    sourceAgent: 'codex',
    targetAgent: 'opencode',
    experienceId: 'mem-1',
    reuse: true,
    behaviorChanged: true,
    outcomeImproved: true,
    project: 'akemi-mio',
    ...overrides,
  }
}

test('phase0 analyze returns not_started for empty data', () => {
  const report = analyzePhase0({ memories: [], traces: [], reuseRecords: [] })

  assert.equal(report.status, 'not_started')
  assert.equal(report.metrics.hostCount, 0)
  assert.equal(report.metrics.taskOutcomes, 0)
  assert.equal(report.metrics.verifiedReuse, 0)
  assert.equal(report.criteria.every((criterion) => criterion.passed), false)
})

test('phase0 analyze derives hosts and counts verified reuse', () => {
  const report = analyzePhase0({
    memories: [memory(), memory({ id: 'mem-2', source: 'opencode' })],
    traces: [
      trace({ agent: 'codex' }),
      trace({ id: 't2', agent: 'opencode' }),
    ],
    reuseRecords: [
      reuse(),
      reuse({ id: 'r2', behaviorChanged: false, outcomeImproved: false }),
    ],
  })

  assert.deepEqual(report.metrics.hosts, ['codex', 'opencode'])
  assert.equal(report.metrics.claimedReuse, 2)
  assert.equal(report.metrics.verifiedReuse, 1)
  assert.equal(report.metrics.crossAgentPairs[0], 'codex->opencode')
})

test('phase0 analyze marks gate passed at thresholds', () => {
  const memories = [memory(), memory({ id: 'mem-2', source: 'opencode' })]
  const traces = Array.from({ length: 20 }, (_, index) =>
    trace({
      id: `trace-${index}`,
      trace_id: `task-${index}`,
      agent: index % 2 === 0 ? 'codex' : 'opencode',
    }),
  )
  const reuseRecords = Array.from({ length: 5 }, (_, index) =>
    reuse({ id: `xfer-${index}`, experienceId: `mem-${index}` }),
  )

  const report = analyzePhase0({ memories, traces, reuseRecords })

  assert.equal(report.status, 'passed')
  assert.equal(report.metrics.hostCount, PHASE0_THRESHOLDS.minHosts)
  assert.equal(report.metrics.taskOutcomes, PHASE0_THRESHOLDS.minTaskOutcomes)
  assert.equal(report.metrics.verifiedReuse, PHASE0_THRESHOLDS.minVerifiedReuse)
})

test('phase0 load reads JSONL and filters by project', (t) => {
  const dir = makeTempDir(t)
  fs.writeFileSync(
    path.join(dir, 'memory.jsonl'),
    [
      JSON.stringify(memory()),
      JSON.stringify(memory({ id: 'mem-2', project: 'other-repo' })),
      'invalid-json',
    ].join('\n'),
    'utf8',
  )
  fs.writeFileSync(
    path.join(dir, 'traces.jsonl'),
    [JSON.stringify(trace()), JSON.stringify(trace({ id: 't2', project: 'other-repo' }))].join('\n'),
    'utf8',
  )
  fs.writeFileSync(
    path.join(dir, 'experience_reuse.jsonl'),
    [JSON.stringify(reuse()), JSON.stringify(reuse({ id: 'r2', project: 'other-repo' }))].join('\n'),
    'utf8',
  )

  const filtered = loadPhase0(dir, 'akemi-mio')
  assert.equal(filtered.metrics.memoryRecords, 1)
  assert.equal(filtered.metrics.traceEvents, 1)
  assert.equal(filtered.metrics.experienceReuseRecords, 1)

  const unfiltered = loadPhase0(dir)
  assert.equal(unfiltered.metrics.memoryRecords, 2)
  assert.equal(unfiltered.metrics.traceEvents, 2)
  assert.equal(unfiltered.metrics.experienceReuseRecords, 2)
})

test('phase0 markdown renderer includes gate status', () => {
  const report = analyzePhase0({
    memories: [memory()],
    traces: [trace()],
    reuseRecords: [reuse()],
  })
  const markdown = renderPhase0Markdown(report)

  assert.match(markdown, /# Mio Phase 0 Validation Report/)
  assert.match(markdown, /Status: \*\*in_progress\*\*/)
  assert.match(markdown, /codex->opencode/)
})



test('phase0 analyze counts pending auto-claims awaiting confirmation', () => {
  const report = analyzePhase0({
    memories: [],
    traces: [],
    reuseRecords: [
      reuse({ id: 'r1', source: 'auto_claim', behaviorChanged: false, confirmed: false }),
      reuse({ id: 'r2', source: 'auto_claim', confirmed: true }),
      reuse({ id: 'r3', source: 'agent_report' }),
    ],
  })

  assert.equal(report.metrics.autoClaimedReuse, 2)
  assert.equal(report.metrics.confirmedReuse, 1)
  assert.equal(report.metrics.pendingAutoClaims, 1)
  assert.equal(report.metrics.verifiedReuse, 2)
})

test('phase0 analyze reports host health (activity, sources)', () => {
  const now = Date.now()
  const activeTs = new Date(now - 2 * 60 * 60 * 1000).toISOString()
  const staleTs = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  const report = analyzePhase0({
    memories: [
      memory({ source: 'codex', timestamp: activeTs }),
      memory({ source: 'workbuddy-observer', timestamp: staleTs }),
    ],
    traces: [
      trace({ agent: 'codex', timestamp: activeTs }),
      trace({ id: 't2', agent: 'codex', event_type: 'tool_call', timestamp: activeTs }),
    ],
    reuseRecords: [],
  })

  const codex = report.metrics.agentCoverage.find((coverage) => coverage.agent === 'codex')
  assert.ok(codex)
  assert.equal(codex.active, true)
  assert.equal(codex.taskOutcomes, 1)
  assert.deepEqual(codex.dataSources, ['memory', 'trace'])
  assert.ok(codex.lastActiveHoursAgo !== null && codex.lastActiveHoursAgo < 24)
  assert.ok(codex.lastActiveAt)

  const workbuddy = report.metrics.agentCoverage.find((coverage) => coverage.agent === 'workbuddy-observer')
  assert.ok(workbuddy)
  assert.equal(workbuddy.active, false)
  assert.equal(workbuddy.lastActiveAt, staleTs)
  assert.deepEqual(workbuddy.dataSources, ['memory'])

  assert.equal(report.metrics.activeHostCount, 1)
})

test('phase0 summary reports remaining gate gaps', () => {
  const report = analyzePhase0({
    memories: [memory()],
    traces: [trace()],
    reuseRecords: [],
  })
  const summary = summarizePhase0(report)

  assert.equal(summary.status, 'in_progress')
  assert.equal(summary.passed, false)
  assert.deepEqual(
    summary.remaining.map((criterion) => criterion.key),
    ['hosts', 'tasks', 'verified_reuse', 'measurable_improvement'],
  )
  assert.equal(summary.remaining.find((criterion) => criterion.key === 'tasks').gap, 19)
})
