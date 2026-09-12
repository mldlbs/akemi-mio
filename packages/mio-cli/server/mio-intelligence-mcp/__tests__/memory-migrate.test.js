'use strict'

// Integration test for P3 cross-project memory migration and layered memory
// (project/global) visibility in analyze/query. Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-migrate-'))
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

function mem(overrides = {}) {
  return {
    id: 'mem-1',
    timestamp: '2026-08-17T00:00:00.000Z',
    kind: 'decision',
    content: '如何在本机配置 MCP：先检查 opencode.json 再启动 server',
    project: 'akemi-mio',
    scope: 'project',
    source: 'codex',
    ...overrides,
  }
}

test('memory.migrate moves project record to global layer', async () => {
  writeMemories([mem()])
  const result = await callTool('mio.memory.migrate', {
    ids: ['mem-1'],
    scope: 'global',
    reason: '跨项目可复用',
  })
  assert.deepEqual(result.updated, ['mem-1'])
  assert.equal(result.scope, 'global')
  const all = await callTool('mio.memory.query', { query: 'MCP 配置', scope: 'all' })
  const moved = all.results.find((record) => record.id === 'mem-1')
  assert.equal(moved.scope, 'global')
  assert.equal(moved.project, null)
  assert.ok(moved.migratedAt)
  assert.equal(moved.migratedFrom, 'akemi-mio')
  // project scope must no longer see it
  const projectScope = await callTool('mio.memory.query', { query: 'MCP 配置', scope: 'project' })
  assert.ok(!projectScope.results.some((record) => record.id === 'mem-1'))
})

test('memory.migrate moves global record back to project layer', async () => {
  writeMemories([mem({ scope: 'global', project: null })])
  const result = await callTool('mio.memory.migrate', {
    ids: ['mem-1'],
    scope: 'project',
    project: 'other-repo',
  })
  assert.deepEqual(result.updated, ['mem-1'])
  const all = await callTool('mio.memory.query', { query: 'MCP 配置', scope: 'all', project: 'other-repo' })
  const moved = all.results.find((record) => record.id === 'mem-1')
  assert.equal(moved.scope, 'project')
  assert.equal(moved.project, 'other-repo')
  assert.equal(moved.migratedFrom, 'global')
  // no longer visible from the original project scope
  const original = await callTool('mio.memory.query', { query: 'MCP 配置', scope: 'all' })
  assert.ok(!original.results.some((record) => record.id === 'mem-1'))
})

test('memory.migrate reports unchanged when already in target layer', async () => {
  writeMemories([mem({ scope: 'global', project: null })])
  const result = await callTool('mio.memory.migrate', { ids: ['mem-1'], scope: 'global' })
  assert.deepEqual(result.unchanged, ['mem-1'])
  assert.deepEqual(result.updated, [])
})

test('memory.migrate reports notFound ids', async () => {
  writeMemories([mem()])
  const result = await callTool('mio.memory.migrate', { ids: ['mem-1', 'mem-x'], scope: 'global' })
  assert.deepEqual(result.notFound, ['mem-x'])
})

test('memory.migrate validates inputs', async () => {
  await assert.rejects(() => callTool('mio.memory.migrate', {}), /requires ids/)
  writeMemories([mem()])
  await assert.rejects(
    () => callTool('mio.memory.migrate', { ids: ['mem-1'], scope: 'all' }),
    /scope must be project or global/,
  )
})

test('memory.analyze includes global records and reports layer counts', async () => {
  writeMemories([
    mem({ id: 'mem-p', project: 'akemi-mio', scope: 'project' }),
    mem({ id: 'mem-g', project: null, scope: 'global' }),
  ])
  const result = await callTool('mio.memory.analyze', { project: 'akemi-mio' })
  assert.equal(result.total, 2)
  assert.deepEqual(result.layers, { project: 1, global: 1 })
})

test('memory.query reports layer counts', async () => {
  writeMemories([
    mem({ id: 'mem-p', project: 'akemi-mio', scope: 'project' }),
    mem({ id: 'mem-g', project: null, scope: 'global' }),
  ])
  const all = await callTool('mio.memory.query', { query: 'MCP 配置', scope: 'all' })
  assert.deepEqual(all.layers, { project: 1, global: 1 })
  const projectOnly = await callTool('mio.memory.query', { query: 'MCP 配置', scope: 'project' })
  assert.deepEqual(projectOnly.layers, { project: 1, global: 0 })
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})