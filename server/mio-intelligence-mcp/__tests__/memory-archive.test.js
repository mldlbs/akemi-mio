'use strict'

// Integration test for mio.memory.archive (non-destructive archive + restore).
// Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-archive-'))
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

function memory(overrides = {}) {
  return {
    id: 'mem-1',
    timestamp: '2026-08-17T00:00:00.000Z',
    kind: 'decision',
    content: '使用流式 JSON 解析处理大型 MCP 载荷以避免 token 尖峰并减少内存占用',
    project: 'akemi-mio',
    source: 'codex',
    ...overrides,
  }
}

function queryIds(result) {
  return result.results.map((record) => record.id).sort()
}

test('memory.archive excludes records from memory.query', async () => {
  writeMemories([memory({ id: 'r1' }), memory({ id: 'r2' }), memory({ id: 'r3' })])
  const before = await callTool('mio.memory.query', { query: '流式 JSON 解析' })
  assert.equal(before.count, 3)

  const archiveResult = await callTool('mio.memory.archive', {
    ids: ['r1', 'r2'],
    reason: 'duplicate of r3',
  })
  assert.equal(archiveResult.archivedCount, 2)
  assert.deepEqual(archiveResult.archived.sort(), ['r1', 'r2'])
  assert.deepEqual(archiveResult.notFound, [])

  const after = await callTool('mio.memory.query', { query: '流式 JSON 解析' })
  assert.deepEqual(queryIds(after), ['r3'])
})

test('memory.archive reports unknown ids', async () => {
  writeMemories([memory({ id: 'r1' })])
  const result = await callTool('mio.memory.archive', { ids: ['r1', 'does-not-exist'] })
  assert.equal(result.archivedCount, 1)
  assert.deepEqual(result.archived, ['r1'])
  assert.deepEqual(result.notFound, ['does-not-exist'])
})

test('memory.archive restores records and memory.analyze counts archived', async () => {
  writeMemories([memory({ id: 'r1' }), memory({ id: 'r2' })])
  await callTool('mio.memory.archive', { ids: ['r1'] })

  const analyzeArchived = await callTool('mio.memory.analyze', { project: 'akemi-mio' })
  assert.equal(analyzeArchived.total, 1)
  assert.equal(analyzeArchived.archived, 1)

  const restoreResult = await callTool('mio.memory.archive', { ids: ['r1'], restore: true })
  assert.equal(restoreResult.restored, true)
  assert.deepEqual(restoreResult.archived, ['r1'])

  const after = await callTool('mio.memory.query', { query: '流式 JSON 解析' })
  assert.deepEqual(queryIds(after), ['r1', 'r2'])
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})
