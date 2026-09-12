'use strict'

// Agent-health routing loop: digest.generate persists MIO_HOME/digest/latest.json
// and mio.task.route consumes it as an agent-health signal (prefer/avoid).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..', '..')

function tempDir(suffix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-route-health-' + suffix + '-'))
}

function writeJsonl(file, records) {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

// codex: 8 success, claude-code: 1 success 5 failure (degraded), opencode: 2 success
function seedTraces(home) {
  const now = Date.now()
  const records = []
  for (let i = 0; i < 8; i++) {
    records.push({
      id: 'c' + i,
      timestamp: new Date(now - i * 3600000).toISOString(),
      trace_id: 'codex:' + i,
      event_type: 'task_outcome',
      outcome: 'success',
      agent: 'codex',
      project: 'proj-a',
      payload: { summary: 'codex task ' + i },
    })
  }
  for (let i = 0; i < 5; i++) {
    records.push({
      id: 'k' + i,
      timestamp: new Date(now - i * 7200000).toISOString(),
      trace_id: 'claude:' + i,
      event_type: 'task_outcome',
      outcome: 'failure',
      agent: 'claude-code',
      project: 'proj-a',
      payload: {},
    })
  }
  records.push({
    id: 'kok',
    timestamp: new Date(now - 3600000).toISOString(),
    trace_id: 'claude:ok',
    event_type: 'task_outcome',
    outcome: 'success',
    agent: 'claude-code',
    project: 'proj-a',
    payload: {},
  })
  for (let i = 0; i < 2; i++) {
    records.push({
      id: 'o' + i,
      timestamp: new Date(now - i * 3600000).toISOString(),
      trace_id: 'opencode:' + i,
      event_type: 'task_outcome',
      outcome: 'success',
      agent: 'opencode',
      project: 'proj-a',
      payload: { summary: 'opencode task ' + i },
    })
  }
  writeJsonl(path.join(home, 'traces.jsonl'), records)
}

test('task.route consumes the digest agent-health snapshot', async () => {
  const dataDir = tempDir('e2e')
  process.env.MIO_DATA_DIR = dataDir
  process.env.MIO_CONTEXT = JSON.stringify({ agentId: 'route-health-test', project: 'proj-a' })
  const { callTool, rl } = require('../server/mio-intelligence-mcp/index.js')
  test.after(() => { rl.close() })

  // 1. No digest snapshot yet -> agentHealth null
  const bare = await callTool('mio.task.route', { task: 'fix the login bug', project: 'proj-a' })
  assert.equal(bare.agentHealth, null)
  assert.equal(bare.summary.routingSignal, null)

  // 2. Generate digest (writes latest.json) -> health signal appears
  seedTraces(dataDir)
  const { createDigest } = require('../server/digest.js')
  createDigest({ home: dataDir }).generate({ days: 7 })
  const latest = JSON.parse(fs.readFileSync(path.join(dataDir, 'digest', 'latest.json'), 'utf8'))
  assert.equal(latest.agents.length, 3, 'latest.json snapshot persisted')

  const routed = await callTool('mio.task.route', { task: 'fix the login bug', project: 'proj-a' })
  assert.ok(routed.agentHealth, 'agentHealth present after digest')
  assert.equal(routed.agentHealth.stale, false)
  assert.equal(routed.agentHealth.best.agent, 'codex')
  assert.equal(routed.agentHealth.best.successRate, 100)
  assert.deepEqual(
    routed.agentHealth.degraded.map((d) => d.agent),
    ['claude-code'],
    'claude-code (1/6 = 17%) is flagged degraded',
  )
  assert.ok(routed.summary.routingSignal.includes('prefer codex'))
  assert.ok(routed.summary.routingSignal.includes('avoid claude-code'))
  assert.ok(routed.summary.suggestion.includes(routed.summary.routingSignal))

  // 3. Stale snapshot (older than 48h) -> signal suppressed, marked stale
  const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, 'digest', 'latest.json'), 'utf8'))
  snapshot.generatedAt = new Date(Date.now() - 72 * 3600000).toISOString()
  fs.writeFileSync(path.join(dataDir, 'digest', 'latest.json'), JSON.stringify(snapshot) + '\n', 'utf8')
  const stale = await callTool('mio.task.route', { task: 'fix the login bug', project: 'proj-a' })
  assert.equal(stale.agentHealth.stale, true)
  assert.equal(stale.agentHealth.best, null)
  assert.equal(stale.summary.routingSignal, null)
})
