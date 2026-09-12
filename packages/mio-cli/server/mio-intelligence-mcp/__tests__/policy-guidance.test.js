'use strict'

// Integration test for P4 policy execution guidance: policy.check upgrades from
// advisory risk to actionable guidance when verified evidence exists, while
// never setting a hard gate. Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-policy-guidance-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'akemi-mio',
  workspace: 'D:/work/code/akemi-mio',
  sessionId: 'test-session',
})

const { callTool, rl } = require('../index.js')

function writeMemories(records) {
  const file = path.join(dataDir, 'memory.jsonl')
  fs.writeFileSync(
    file,
    records.length > 0 ? records.map((record) => JSON.stringify(record)).join('\n') + '\n' : '',
    'utf8',
  )
}

function writeReuse(records) {
  const file = path.join(dataDir, 'experience_reuse.jsonl')
  fs.writeFileSync(
    file,
    records.length > 0 ? records.map((record) => JSON.stringify(record)).join('\n') + '\n' : '',
    'utf8',
  )
}

function writeTraces(records) {
  const file = path.join(dataDir, 'traces.jsonl')
  fs.writeFileSync(
    file,
    records.length > 0 ? records.map((record) => JSON.stringify(record)).join('\n') + '\n' : '',
    'utf8',
  )
}

function trace(overrides = {}) {
  return {
    id: 't1',
    timestamp: '2026-08-17T00:00:00.000Z',
    event_type: 'task_outcome',
    outcome: 'failure',
    payload: { summary: 'git push 失败：远端拒绝非快进合并' },
    agent: 'codex',
    project: 'akemi-mio',
    trace_id: 'trace-1',
    ...overrides,
  }
}

test('policy.check returns guidance none when no history', async () => {
  writeMemories([])
  writeTraces([])
  const result = await callTool('mio.policy.check', { action: 'git push' })
  assert.equal(result.guidance.level, 'none')
  assert.equal(result.guidance.hardGate, false)
  assert.ok(result.guidance.rationale)
  assert.equal(result.suggestion, 'No history for this action. Treat as normal risk and record the outcome.')
})

test('policy.check guidance is actionable with verified experience', async () => {
  writeMemories([
    {
      id: 'mem-gp',
      timestamp: '2026-08-17T00:00:00.000Z',
      kind: 'decision',
      content: 'git push 前先 git pull --rebase 再提交，避免非快进拒绝',
      project: 'akemi-mio',
      source: 'codex',
    },
  ])
  writeReuse([
    {
      id: 'x1',
      source: 'auto_claim',
      sourceAgent: 'codex',
      targetAgent: 'opencode',
      experienceId: 'mem-gp',
      reuse: true,
      behaviorChanged: true,
      outcomeImproved: true,
      confirmed: true,
      timestamp: '2026-08-17T00:00:00.000Z',
      project: 'akemi-mio',
    },
  ])
  writeTraces([trace({ id: 't1', outcome: 'success', payload: { summary: 'git push 成功' } })])
  const result = await callTool('mio.policy.check', { action: 'git push' })
  assert.equal(result.guidance.level, 'actionable')
  assert.equal(result.guidance.hardGate, false)
  assert.ok(result.guidance.saferAlternatives.length >= 1)
  assert.equal(result.guidance.saferAlternatives[0].memoryId, 'mem-gp')
  assert.equal(result.guidance.saferAlternatives[0].reuseCount, 1)
  assert.ok(result.guidance.verificationSteps.length >= 2)
  assert.equal(result.riskLevel, 'low')
})

test('policy.check guidance avoids known failure patterns on repeated failures', async () => {
  writeMemories([])
  writeTraces([
    trace({ id: 't1', payload: { summary: 'git push 失败：远端拒绝非快进合并' } }),
    trace({ id: 't2', payload: { summary: 'git push 失败：认证过期' } }),
    trace({ id: 't3', payload: { summary: 'git push 失败：网络超时' } }),
  ])
  const result = await callTool('mio.policy.check', { action: 'git push' })
  assert.equal(result.guidance.level, 'advisory')
  assert.equal(result.guidance.hardGate, false)
  assert.equal(result.riskLevel, 'high')
  assert.ok(result.guidance.avoid.length >= 2)
  assert.ok(result.guidance.avoid.some((text) => text.includes('失败')))
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})