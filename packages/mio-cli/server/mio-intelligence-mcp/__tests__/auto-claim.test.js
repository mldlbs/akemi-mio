'use strict'

// Integration test for the query -> task_outcome auto-claim loop.
// The MCP server resolves MIO_DATA_DIR/MIO_CONTEXT at require time, so the
// environment must be set before the module is loaded.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-autoclaim-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'akemi-mio',
  workspace: 'D:/work/code/akemi-mio',
  sessionId: 'test-session',
})
delete process.env.MIO_REUSE_MATCH_WINDOW_MIN

const { callTool, rl } = require('../index.js')

function queryRecords() {
  const file = path.join(dataDir, 'queries.jsonl')
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf8').trim()
  if (!raw) return []
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function writeQueryEntry(overrides = {}) {
  const now = Date.now()
  const entry = {
    agent: 'codex',
    project: 'akemi-mio',
    query: 'remote query from another process',
    resultIds: ['mem-remote-1'],
    resultSources: ['opencode'],
    timestamp: now,
    expiresAt: now + 60 * 60 * 1000,
    ...overrides,
  }
  fs.writeFileSync(path.join(dataDir, 'queries.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
}

function reuseRecords() {
  const file = path.join(dataDir, 'experience_reuse.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('memory.query followed by task_outcome produces an auto-claimed reuse record', async () => {
  // Another agent (opencode) produced the experience.
  const memory = await callTool('mio.memory.record', {
    content: 'Use streaming JSON parsing for large MCP payloads to avoid token spikes',
    kind: 'decision',
    tags: ['mcp', 'performance'],
    source: 'opencode',
  })
  assert.ok(memory.id)

  // Codex recalls it.
  const queryResult = await callTool('mio.memory.query', {
    query: 'streaming JSON parsing MCP payloads',
  })
  assert.ok(queryResult.count >= 1)

  // Codex finishes the task with a success outcome.
  const ingestResult = await callTool('mio.observer.ingest', {
    trace_id: 'codex:akemi-mio:auto-claim-test',
    event_type: 'task_outcome',
    outcome: 'success',
    payload: { summary: 'implemented streaming parser' },
  })

  assert.ok(Array.isArray(ingestResult.autoClaims), 'task_outcome should report autoClaims')
  assert.equal(ingestResult.autoClaims.length, 1)

  const claim = ingestResult.autoClaims[0]
  assert.equal(claim.sourceAgent, 'opencode')
  assert.equal(claim.targetAgent, 'codex')
  assert.equal(claim.experienceId, memory.id)
  assert.equal(claim.reuse, true)
  assert.equal(claim.behaviorChanged, false)
  assert.equal(claim.outcomeImproved, true)
  assert.equal(claim.source, 'auto_claim')
  assert.equal(claim.traceId, 'codex:akemi-mio:auto-claim-test')
  assert.equal(claim.project, 'akemi-mio')

  const records = reuseRecords()
  assert.equal(records.length, 1)
  assert.equal(records[0].source, 'auto_claim')

  // The query was persisted and consumed from queries.jsonl.
  assert.deepEqual(queryRecords(), [])
})

test('a persisted query entry survives process restart (file-backed match)', async () => {
  // Simulate another MCP process that wrote its memory.query to queries.jsonl.
  writeQueryEntry()

  const ingestResult = await callTool('mio.observer.ingest', {
    trace_id: 'codex:akemi-mio:file-backed-match',
    event_type: 'task_outcome',
    outcome: 'success',
    payload: { summary: 'task that used a remotely recalled experience' },
  })

  assert.equal(ingestResult.autoClaims.length, 1)
  assert.equal(ingestResult.autoClaims[0].experienceId, 'mem-remote-1')
  assert.equal(ingestResult.autoClaims[0].sourceAgent, 'opencode')
  assert.deepEqual(queryRecords(), [])
})

test('expired persisted queries are pruned without creating claims', async () => {
  writeQueryEntry({ timestamp: Date.now() - 2 * 60 * 60 * 1000, expiresAt: Date.now() - 60 * 60 * 1000 })

  const ingestResult = await callTool('mio.observer.ingest', {
    trace_id: 'codex:akemi-mio:expired-query',
    event_type: 'task_outcome',
    outcome: 'success',
    payload: { summary: 'task after window expired' },
  })

  assert.equal(ingestResult.autoClaims, undefined)
  assert.deepEqual(queryRecords(), [])
})

test('a second task_outcome does not double-claim the consumed query', async () => {
  const before = reuseRecords().length

  const ingestResult = await callTool('mio.observer.ingest', {
    trace_id: 'codex:akemi-mio:auto-claim-test-2',
    event_type: 'task_outcome',
    outcome: 'success',
    payload: { summary: 'follow-up task' },
  })

  assert.equal(ingestResult.autoClaims, undefined)
  assert.equal(reuseRecords().length, before)
})

test('non task_outcome events never create claims', async () => {
  await callTool('mio.memory.query', { query: 'streaming JSON parsing MCP payloads' })
  const ingestResult = await callTool('mio.observer.ingest', {
    trace_id: 'codex:akemi-mio:tool-call-test',
    event_type: 'tool_call',
    outcome: 'success',
    payload: { tool: 'shell' },
  })
  assert.equal(ingestResult.autoClaims, undefined)
})

test('phase0 report counts auto-claims and cross-agent pair', async () => {
  const report = await callTool('mio.phase0.report', {})

  assert.equal(report.metrics.autoClaimedReuse, 2)
  assert.equal(report.metrics.verifiedReuse, 0)
  assert.ok(report.metrics.hosts.includes('codex'))
  assert.ok(report.metrics.hosts.includes('opencode'))
  assert.ok(report.metrics.crossAgentPairs.includes('opencode->codex'))
})

test('agent-reported reuse still records source agent_report and can be verified', async () => {
  const result = await callTool('mio.experience.reuse', {
    sourceAgent: 'opencode',
    targetAgent: 'codex',
    experienceId: 'mem-manual-1',
    reuse: true,
    behaviorChanged: true,
    outcomeImproved: true,
    notes: 'manual confirmation',
  })
  assert.equal(result.evidence.source, 'agent_report')
  assert.equal(result.evidence.reuse, true)

  const report = await callTool('mio.phase0.report', {})
  assert.equal(report.metrics.verifiedReuse, 1)
  assert.equal(report.metrics.autoClaimedReuse, 2)
})


test('experience.confirm upgrades an auto-claimed record to verified reuse', async () => {
  const before = await callTool('mio.phase0.report', {})
  const beforeConfirmed = before.metrics.confirmedReuse
  const beforeVerified = before.metrics.verifiedReuse

  await callTool('mio.memory.query', { query: 'streaming JSON parsing MCP payloads' })
  const ingestResult = await callTool('mio.observer.ingest', {
    trace_id: 'codex:akemi-mio:confirm-test',
    event_type: 'task_outcome',
    outcome: 'success',
    payload: { summary: 'task with confirmable reuse' },
  })
  assert.ok(Array.isArray(ingestResult.autoClaims) && ingestResult.autoClaims.length >= 1)
  const claim = ingestResult.autoClaims[0]
  assert.equal(claim.source, 'auto_claim')
  assert.equal(claim.behaviorChanged, false)

  const confirmResult = await callTool('mio.experience.confirm', {
    id: claim.id,
    confirmedBy: 'agent',
    notes: 'recalled memory changed the implementation approach',
  })
  assert.equal(confirmResult.confirmed, true)
  assert.equal(confirmResult.evidence.behaviorChanged, true)
  assert.equal(confirmResult.evidence.outcomeImproved, true)
  assert.equal(confirmResult.evidence.confirmed, true)
  assert.equal(confirmResult.evidence.confirmedBy, 'agent')
  assert.equal(confirmResult.evidence.source, 'auto_claim')

  const after = await callTool('mio.phase0.report', {})
  assert.equal(after.metrics.confirmedReuse, beforeConfirmed + 1)
  assert.equal(after.metrics.verifiedReuse, beforeVerified + 1)
})

test('experience.confirm rejects unknown ids and non-auto-claim records', async () => {
  await assert.rejects(
    callTool('mio.experience.confirm', { id: 'xfer-does-not-exist' }),
    /No experience reuse record found/
  )

  const manual = await callTool('mio.experience.reuse', {
    sourceAgent: 'opencode',
    targetAgent: 'codex',
    experienceId: 'mem-manual-confirm-reject',
    reuse: true,
    behaviorChanged: true,
    outcomeImproved: true,
  })
  await assert.rejects(
    callTool('mio.experience.confirm', { id: manual.evidence.id }),
    /only applies to source=auto_claim/
  )
})


test('experience.list returns records and filters by status', async () => {
  const all = await callTool('mio.experience.list', { project: 'akemi-mio' })
  assert.ok(all.total >= 3)
  assert.ok(all.records.length > 0)
  assert.ok(all.records.every((record) => record.project === 'akemi-mio'))

  const pending = await callTool('mio.experience.list', { status: 'pending' })
  assert.ok(pending.total >= 1)
  assert.ok(
    pending.records.every(
      (record) => record.source === 'auto_claim' && record.confirmed === false,
    ),
  )

  const verified = await callTool('mio.experience.list', { status: 'verified' })
  assert.ok(verified.total >= 1)
  assert.ok(
    verified.records.every(
      (record) => record.reuse && record.behaviorChanged && record.outcomeImproved,
    ),
  )

  const byTarget = await callTool('mio.experience.list', { targetAgent: 'opencode' })
  assert.ok(byTarget.records.every((record) => record.targetAgent === 'opencode'))

  const limited = await callTool('mio.experience.list', { limit: 1 })
  assert.equal(limited.count, 1)
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  // Close the server's stdin reader so the event loop can drain.
  rl.close()
})
