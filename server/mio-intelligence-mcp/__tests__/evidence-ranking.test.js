'use strict'

// Integration test for P2 evidence-weighted ranking: memories with verified
// reuse evidence rank higher, without enabling recall of irrelevant records.
// Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-evidence-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'opencode',
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

function mem(overrides = {}) {
  return {
    id: 'mem-a',
    timestamp: '2026-08-17T00:00:00.000Z',
    kind: 'decision',
    content: 'token 尖峰问题用流式 JSON 解析解决',
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
    experienceId: 'mem-a',
    reuse: true,
    behaviorChanged: true,
    outcomeImproved: true,
    confirmed: true,
    confirmedBy: 'agent',
    timestamp: '2026-08-17T00:00:00.000Z',
    project: 'akemi-mio',
    traceId: 'trace-1',
    ...overrides,
  }
}

test('memory.query ranks evidence-backed memory first on content tie', async () => {
  const content = 'token 尖峰问题用流式 JSON 解析解决'
  writeMemories([
    mem({ id: 'mem-a', content }),
    mem({ id: 'mem-b', content }),
  ])
  writeReuse([verified({ experienceId: 'mem-a' })])
  const result = await callTool('mio.memory.query', { query: 'token 尖峰 流式', limit: 5 })
  assert.equal(result.results[0].id, 'mem-a')
  assert.deepEqual(queryIds(result), ['mem-a', 'mem-b'])
})

function queryIds(result) {
  return result.results.map((record) => record.id).sort()
}

test('memory.query exposes evidence metadata on routed records', async () => {
  writeMemories([mem()])
  writeReuse([
    verified({ id: 'x1', traceId: 'trace-1' }),
    verified({ id: 'x2', traceId: 'trace-2' }),
  ])
  const result = await callTool('mio.memory.query', { query: 'token 尖峰', limit: 5 })
  const found = result.results.find((record) => record.id === 'mem-a')
  assert.ok(found, 'mem-a returned')
  assert.equal(found.evidence.reuseCount, 2)
  assert.equal(found.evidence.confirmedCount, 2)
  assert.ok(found.evidence.lastReusedAt)
})

test('memory.query evidence does not enable recall of irrelevant records', async () => {
  writeMemories([
    mem({ id: 'mem-a', content: 'token 尖峰问题用流式 JSON 解析解决' }),
    mem({ id: 'mem-c', content: '完全不相关的部署环境限制结论' }),
  ])
  writeReuse([verified({ experienceId: 'mem-c' })])
  const result = await callTool('mio.memory.query', { query: 'token 尖峰', limit: 5 })
  assert.deepEqual(queryIds(result), ['mem-a'])
})

test('policy.check related memories carry evidence metadata', async () => {
  writeMemories([mem()])
  writeReuse([verified()])
  const result = await callTool('mio.policy.check', { action: 'token 尖峰 流式解析' })
  const related = result.related_memories.find((record) => record.id === 'mem-a')
  assert.ok(related, 'mem-a in related memories')
  assert.equal(related.evidence.reuseCount, 1)
  assert.equal(related.evidence.confirmedCount, 1)
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})