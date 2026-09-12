'use strict'

// Tests for Agent Registry: mio.agent.register, mio.agent.list, mio.agent.report

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-agent-reg-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'akemi-mio',
  workspace: 'D:/work/code/akemi-mio',
  sessionId: 'test-agent-reg',
})

const { callTool, rl } = require('../index.js')

test.after(() => { rl.close() })

// --- agent.register ---

test('agent.register creates a new agent', async () => {
  const result = await callTool('mio.agent.register', {
    agentId: 'codex',
    hostType: 'mcp',
    capabilities: ['code', 'analysis'],
  })
  assert.equal(result.agentId, 'codex')
  assert.equal(result.registered, true)
  assert.equal(result.sessionCount, 1)
  assert.equal(result.hostType, 'mcp')
  assert.deepEqual(result.capabilities, ['code', 'analysis'])
  assert.ok(result.id.startsWith('agent_'))
})

test('agent.register upserts existing agent', async () => {
  const result = await callTool('mio.agent.register', {
    agentId: 'codex',
    hostType: 'mcp',
    capabilities: ['code'],
  })
  assert.equal(result.registered, false)
  assert.equal(result.sessionCount, 2)
})

test('agent.register requires agentId', async () => {
  await assert.rejects(() => callTool('mio.agent.register', {}), /requires a non-empty agentId/)
})

test('agent.register with different agent creates separate record', async () => {
  const result = await callTool('mio.agent.register', {
    agentId: 'opencode',
    hostType: 'mcp',
  })
  assert.equal(result.agentId, 'opencode')
  assert.equal(result.registered, true)
  assert.equal(result.sessionCount, 1)
})

// --- agent.list ---

test('agent.list returns all agents', async () => {
  const result = await callTool('mio.agent.list', {})
  assert.equal(result.count, 2)
  const ids = result.agents.map((a) => a.agentId).sort()
  assert.deepEqual(ids, ['codex', 'opencode'])
})

test('agent.list filters by project', async () => {
  const result = await callTool('mio.agent.list', { project: 'akemi-mio' })
  assert.ok(result.count >= 1)
  result.agents.forEach((a) => assert.equal(a.project, 'akemi-mio'))
})

test('agent.list returns empty for unknown project', async () => {
  const result = await callTool('mio.agent.list', { project: 'nonexistent' })
  assert.equal(result.count, 0)
  assert.deepEqual(result.agents, [])
})

// --- agent.report ---

test('agent.report returns stats for specific agent', async () => {
  const result = await callTool('mio.agent.report', { agentId: 'codex' })
  assert.equal(result.count, 1)
  const report = result.reports[0]
  assert.equal(report.agentId, 'codex')
  assert.ok(report.taskOutcomes)
  assert.equal(typeof report.taskOutcomes.total, 'number')
  assert.equal(typeof report.taskOutcomes.successRate, 'number')
  assert.equal(typeof report.memories, 'number')
  assert.ok(report.experienceReuses)
  assert.equal(typeof report.active, 'boolean')
})

test('agent.report returns all agents when no agentId', async () => {
  const result = await callTool('mio.agent.report', {})
  assert.ok(result.count >= 2)
  result.reports.forEach((r) => {
    assert.ok(r.agentId)
    assert.ok(r.taskOutcomes)
  })
})

test('agent.report filters by project', async () => {
  const result = await callTool('mio.agent.report', { project: 'akemi-mio' })
  assert.ok(result.count >= 1)
  assert.equal(result.project, 'akemi-mio')
})
