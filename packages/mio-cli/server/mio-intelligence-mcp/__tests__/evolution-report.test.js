'use strict'

// Tests for mio.evolution.report (Evolution plane - ADR-017)

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-evo-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'test-evo',
  workspace: '/tmp/test',
  sessionId: 'test-evo',
})

const { callTool, rl } = require('../index.js')

test.after(() => { rl.close() })

function writeJsonl(filename, records) {
  const file = path.join(dataDir, filename)
  fs.writeFileSync(
    file,
    records.length > 0 ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '',
    'utf8',
  )
}

test('evolution.report returns ecosystem summary', async () => {
  writeJsonl('traces.jsonl', [
    { id: 't1', timestamp: new Date().toISOString(), trace_id: 'a:1', event_type: 'task_outcome', outcome: 'success', agent: 'codex', project: 'test-evo' },
    { id: 't2', timestamp: new Date().toISOString(), trace_id: 'a:2', event_type: 'task_outcome', outcome: 'failure', agent: 'codex', project: 'test-evo' },
    { id: 't3', timestamp: new Date().toISOString(), trace_id: 'b:1', event_type: 'task_outcome', outcome: 'success', agent: 'opencode', project: 'test-evo' },
  ])
  writeJsonl('memory.jsonl', [
    { id: 'm1', timestamp: new Date().toISOString(), kind: 'decision', content: 'This is a test decision record with sufficient length for quality checks', project: 'test-evo', source: 'codex' },
    { id: 'm2', timestamp: new Date().toISOString(), kind: 'note', content: 'This is a test note record with sufficient length for quality checks', project: 'test-evo', source: 'opencode' },
  ])
  writeJsonl('experience_reuse.jsonl', [
    { id: 'r1', timestamp: new Date().toISOString(), sourceAgent: 'codex', targetAgent: 'opencode', reuse: true, behaviorChanged: true, outcomeImproved: true, confirmed: true, project: 'test-evo', source: 'agent_report' },
  ])
  writeJsonl('agents.jsonl', [
    { id: 'a1', agentId: 'codex', hostType: 'mcp', registeredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), sessionCount: 5, project: 'test-evo' },
    { id: 'a2', agentId: 'opencode', hostType: 'mcp', registeredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), sessionCount: 3, project: 'test-evo' },
  ])

  const r = await callTool('mio.evolution.report', { project: 'test-evo' })
  assert.equal(r.project, 'test-evo')
  assert.equal(r.ecosystem.agents, 2)
  assert.equal(r.ecosystem.totalTasks, 3)
  assert.equal(r.ecosystem.successRate, 67)
  assert.equal(r.ecosystem.totalMemories, 2)
  assert.equal(r.ecosystem.verifiedReuses, 1)
  assert.ok(r.generatedAt)
  assert.equal(r.period, 'all')
})

test('evolution.report includes agent performance', async () => {
  const r = await callTool('mio.evolution.report', { project: 'test-evo' })
  assert.ok(r.agentPerformance.length >= 2)
  const codex = r.agentPerformance.find((a) => a.agentId === 'codex')
  assert.ok(codex)
  assert.equal(codex.tasks.total, 2)
  assert.equal(codex.tasks.success, 1)
  assert.equal(codex.tasks.successRate, 50)
  assert.equal(codex.memories, 1)
})

test('evolution.report detects cross-agent patterns', async () => {
  const r = await callTool('mio.evolution.report', { project: 'test-evo' })
  assert.ok(r.crossAgentPatterns.length >= 1)
  const p = r.crossAgentPatterns.find((p) => p.from === 'codex' && p.to === 'opencode')
  assert.ok(p)
  assert.equal(p.verified, 1)
  assert.equal(p.improved, 1)
})

test('evolution.report includes memory health', async () => {
  const r = await callTool('mio.evolution.report', { project: 'test-evo' })
  assert.equal(r.memoryHealth.total, 2)
  assert.equal(r.memoryHealth.byKind.decision, 1)
  assert.equal(r.memoryHealth.byKind.note, 1)
  assert.equal(r.memoryHealth.qualityScore, 100)
})

test('evolution.report generates routing suggestion when agents differ', async () => {
  writeJsonl('traces.jsonl', [
    ...Array.from({ length: 10 }, (_, i) => ({
      id: 'c' + i, timestamp: new Date().toISOString(), trace_id: 'c:' + i,
      event_type: 'task_outcome', outcome: 'success', agent: 'codex', project: 'test-evo',
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      id: 'o' + i, timestamp: new Date().toISOString(), trace_id: 'o:' + i,
      event_type: 'task_outcome', outcome: i < 5 ? 'success' : 'failure', agent: 'opencode', project: 'test-evo',
    })),
  ])
  const r = await callTool('mio.evolution.report', { project: 'test-evo' })
  const routing = r.suggestions.find((s) => s.category === 'routing')
  assert.ok(routing)
  assert.equal(routing.priority, 'high')
})

test('evolution.report returns empty state gracefully', async () => {
  writeJsonl('traces.jsonl', [])
  writeJsonl('memory.jsonl', [])
  writeJsonl('experience_reuse.jsonl', [])
  writeJsonl('agents.jsonl', [])
  const r = await callTool('mio.evolution.report', { project: 'empty-project' })
  assert.equal(r.ecosystem.agents, 0)
  assert.equal(r.ecosystem.totalTasks, 0)
  assert.equal(r.agentPerformance.length, 0)
  assert.equal(r.crossAgentPatterns.length, 0)
  assert.equal(r.memoryHealth.total, 0)
})

test('evolution.report respects period filter', async () => {
  const old = new Date(Date.now() - 86400000 * 10).toISOString()
  const recent = new Date().toISOString()
  writeJsonl('traces.jsonl', [
    { id: 'old1', timestamp: old, trace_id: 'old:1', event_type: 'task_outcome', outcome: 'success', agent: 'codex', project: 'test-evo' },
    { id: 'new1', timestamp: recent, trace_id: 'new:1', event_type: 'task_outcome', outcome: 'success', agent: 'codex', project: 'test-evo' },
  ])
  writeJsonl('memory.jsonl', [])
  writeJsonl('experience_reuse.jsonl', [])
  writeJsonl('agents.jsonl', [])
  const r = await callTool('mio.evolution.report', { project: 'test-evo', period: '24h' })
  assert.equal(r.period, '24h')
  assert.equal(r.ecosystem.totalTasks, 1)
})
