'use strict'

// Integration test for mio.task.route: routing a task to the most relevant
// verified experiences and related memories (P1). Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-route-'))
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
    confirmedBy: 'agent',
    timestamp: '2026-08-17T00:00:00.000Z',
    project: 'akemi-mio',
    traceId: 'trace-1',
    ...overrides,
  }
}

test('task.route routes verified experiences matching the task', async () => {
  writeMemories([memory()])
  writeReuse([verified()])
  const result = await callTool('mio.task.route', {
    task: 'WorkBuddy 接入方式 MCP 直连 passive observer',
  })
  assert.equal(result.count, 1)
  assert.equal(result.routes[0].experienceId, 'mem-1')
  assert.equal(result.routes[0].reuseCount, 1)
  assert.equal(result.routes[0].confirmed, true)
  assert.equal(result.routes[0].sourceAgents[0], 'codex')
  assert.equal(result.routes[0].targetAgents[0], 'opencode')
  assert.ok(result.routes[0].memory.content.includes('passive observer'))
  assert.equal(result.summary.verifiedRoutes, 1)
})

test('task.route aggregates reuseCount across verified records', async () => {
  writeMemories([memory()])
  writeReuse([verified({ id: 'x1', traceId: 'trace-1' }), verified({ id: 'x2', traceId: 'trace-2' })])
  const result = await callTool('mio.task.route', {
    task: 'WorkBuddy MCP 直连 passive observer 接入',
  })
  assert.equal(result.count, 1)
  assert.equal(result.routes[0].reuseCount, 2)
})

test('task.route excludes unverified records from routes but keeps memory as related', async () => {
  writeMemories([
    memory(),
    memory({ id: 'mem-2', content: 'token 尖峰问题用流式解析解决', kind: 'problem' }),
  ])
  writeReuse([verified({ experienceId: 'mem-2', reuse: true, behaviorChanged: false, outcomeImproved: true })])
  const result = await callTool('mio.task.route', { task: 'token 尖峰 流式解析' })
  assert.equal(result.count, 0)
  assert.ok(result.relatedMemories.some((record) => record.id === 'mem-2'))
  assert.equal(result.summary.verifiedRoutes, 0)
})

test('task.route respects scope for global experiences', async () => {
  writeMemories([
    memory({ id: 'mem-g', scope: 'global', project: null, content: '全局经验：配置 MCP 前先检查 opencode.json' }),
  ])
  writeReuse([verified({ experienceId: 'mem-g' })])
  const projectScope = await callTool('mio.task.route', {
    task: 'opencode.json MCP 配置',
    scope: 'project',
  })
  assert.equal(projectScope.count, 0)
  const allScope = await callTool('mio.task.route', {
    task: 'opencode.json MCP 配置',
    scope: 'all',
  })
  assert.equal(allScope.count, 1)
  assert.equal(allScope.routes[0].experienceId, 'mem-g')
})

test('task.route returns related memories when no verified match exists', async () => {
  writeMemories([memory()])
  writeReuse([])
  const result = await callTool('mio.task.route', { task: 'WorkBuddy 接入' })
  assert.equal(result.count, 0)
  assert.ok(result.relatedMemories.length >= 1)
  assert.equal(result.summary.relatedMemories, result.relatedMemories.length)
})

test('task.route requires a non-empty task', async () => {
  await assert.rejects(() => callTool('mio.task.route', {}), /requires a non-empty task/)
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})