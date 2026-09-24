'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { appendJsonl, writeJsonl } = require('../server/memory-store.js')
const { loadPhase0 } = require('../server/mio-intelligence-mcp/phase0.js')
const { createDigest } = require('../server/digest.js')
const { createEvolutionReport } = require('../server/evolution-report.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-readerscache-' + label + '-'))
}

// --- phase0 (loadPhase0) -------------------------------------------------
// loadPhase0 only reads memory/traces/experience_reuse; it never writes them,
// so the real writers' dropCache keeps its read cache correct. Guard that a
// warm load is identical to a cold one, and that a shared writer (appendJsonl)
// surfaces through the cache.
test('phase0 loadPhase0 shares the read cache: warm==cold and invalidates on write', () => {
  const dataDir = tempDir('phase0')
  writeJsonl(path.join(dataDir, 'memory.jsonl'), [
    { id: 'm1', source: 'agent-a', kind: 'fact', content: 'a memory content long enough', timestamp: new Date().toISOString() },
  ])
  writeJsonl(path.join(dataDir, 'traces.jsonl'), [
    { id: 't1', agent: 'agent-a', event_type: 'task_outcome', outcome: 'success', project: 'p', timestamp: new Date().toISOString() },
  ])
  writeJsonl(path.join(dataDir, 'experience_reuse.jsonl'), [])

  const cold = loadPhase0(dataDir)
  const warm = loadPhase0(dataDir)
  const proj = (r) => ({
    mem: r.metrics.memoryRecords,
    tr: r.metrics.traceEvents,
    reuse: r.metrics.experienceReuseRecords,
    hosts: r.metrics.hostCount,
  })
  assert.deepEqual(proj(warm), proj(cold), 'a warm phase0 load must equal a cold load')

  // Invalidation via the shared writer (the path real writers use).
  appendJsonl(path.join(dataDir, 'memory.jsonl'), {
    id: 'm2',
    source: 'agent-b',
    kind: 'fact',
    content: 'another memory content long enough',
    timestamp: new Date().toISOString(),
  })
  const after = loadPhase0(dataDir)
  assert.equal(after.metrics.memoryRecords, 2, 'cache must surface the appended memory')
  assert.equal(after.metrics.hostCount, 2, 'cache must count the new host')
})

// --- digest (createDigest.generate) -------------------------------------
// createDigest reads traces.jsonl and experience_reuse.jsonl. Guard warm==cold
// and invalidation through appendJsonl.
test('digest generate shares the read cache: warm==cold and invalidates on write', () => {
  const dataDir = tempDir('digest')
  const fixed = Date.now()
  writeJsonl(path.join(dataDir, 'traces.jsonl'), [
    { id: 't1', agent: 'a', event_type: 'task_outcome', outcome: 'success', project: 'p', timestamp: new Date(fixed).toISOString() },
  ])
  writeJsonl(path.join(dataDir, 'experience_reuse.jsonl'), [])

  const digest = createDigest({ home: dataDir, now: () => fixed })
  const cold = digest.generate({ days: 7 })
  const warm = digest.generate({ days: 7 })
  const proj = (r) => ({ tasks: r.overview.tasks, errors: r.overview.errorTraces, reuse: r.reuse.total })
  assert.deepEqual(proj(warm), proj(cold), 'a warm digest generate must equal a cold one')

  appendJsonl(path.join(dataDir, 'traces.jsonl'), {
    id: 't2',
    agent: 'a',
    event_type: 'task_outcome',
    outcome: 'success',
    project: 'p',
    timestamp: new Date(fixed).toISOString(),
  })
  const after = digest.generate({ days: 7 })
  assert.equal(after.overview.tasks, 2, 'cache must surface the appended task_outcome trace')
})

// --- evolution-report (createEvolutionReport.report) --------------------
// Reads memory/trace/reuse/agent. Guard warm==cold and invalidation.
test('evolution-report shares the read cache: warm==cold and invalidates on write', () => {
  const dataDir = tempDir('evorep')
  writeJsonl(path.join(dataDir, 'memory.jsonl'), [
    { id: 'm1', kind: 'fact', content: 'a memory content long enough', timestamp: new Date().toISOString(), project: null },
  ])
  writeJsonl(path.join(dataDir, 'traces.jsonl'), [
    { id: 't1', agent: 'a', event_type: 'task_outcome', outcome: 'success', timestamp: new Date().toISOString(), project: 'p' },
  ])
  writeJsonl(path.join(dataDir, 'experience_reuse.jsonl'), [])
  writeJsonl(path.join(dataDir, 'agents.jsonl'), [
    { agentId: 'a', lastSeenAt: new Date().toISOString() },
  ])

  const { report } = createEvolutionReport({ dataDir, projectName: () => null })
  const cold = report({ period: 'all' })
  const warm = report({ period: 'all' })
  const proj = (r) => ({
    mem: r.ecosystem.totalMemories,
    tasks: r.ecosystem.totalTasks,
    reuse: r.ecosystem.totalReuses,
    agents: r.ecosystem.agents,
  })
  assert.deepEqual(proj(warm), proj(cold), 'a warm evolution report must equal a cold one')

  appendJsonl(path.join(dataDir, 'memory.jsonl'), {
    id: 'm2',
    kind: 'fact',
    content: 'another memory content long enough',
    timestamp: new Date().toISOString(),
    project: null,
  })
  const after = report({ period: 'all' })
  assert.equal(after.ecosystem.totalMemories, 2, 'cache must surface the appended memory')
})
