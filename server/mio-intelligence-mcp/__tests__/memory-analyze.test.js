'use strict'

// Integration test for mio.memory.analyze (quality analysis + duplicate detection).
// Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-memanalyze-'))
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

test('memory.analyze detects duplicate groups and low-quality records', async () => {
  const duplicateContent =
    '使用流式 JSON 解析处理大型 MCP 载荷以避免 token 尖峰并减少内存占用'
  writeMemories([
    memory({ id: 'r1', content: duplicateContent }),
    memory({ id: 'r2', content: duplicateContent }),
    memory({ id: 'r3', content: '简短', kind: '' }),
    memory({ id: 'r4', project: 'other-repo' }),
  ])

  const result = await callTool('mio.memory.analyze', { project: 'akemi-mio' })
  assert.equal(result.total, 3)
  assert.deepEqual(result.byKind, { decision: 2, unknown: 1 })
  assert.equal(result.issues.lowQuality, 1)
  assert.equal(result.issues.duplicateGroups, 1)
  assert.equal(result.issues.duplicatesSkipped, false)

  assert.equal(result.duplicates.length, 1)
  assert.equal(result.duplicates[0].size, 2)
  const duplicateIds = result.duplicates[0].records.map((record) => record.id).sort()
  assert.deepEqual(duplicateIds, ['r1', 'r2'])

  assert.equal(result.lowQuality.length, 1)
  assert.equal(result.lowQuality[0].id, 'r3')
  assert.ok(result.lowQuality[0].issues.includes('missing kind'))
  assert.ok(result.lowQuality[0].issues.includes('content too short'))

  assert.ok(
    result.suggestions.some((suggestion) => /duplicate group/i.test(suggestion)),
  )
  assert.ok(
    result.suggestions.some((suggestion) => /low-quality/i.test(suggestion)),
  )
})

test('memory.analyze applies project filter', async () => {
  writeMemories([
    memory({ id: 'r1' }),
    memory({ id: 'r2', project: 'other-repo' }),
  ])

  const other = await callTool('mio.memory.analyze', { project: 'other-repo' })
  assert.equal(other.total, 1)
  assert.equal(other.lowQuality.length, 0)
  assert.equal(other.duplicates.length, 0)
})

test('memory.analyze handles an empty dataset', async () => {
  writeMemories([])
  const result = await callTool('mio.memory.analyze', { project: 'akemi-mio' })
  assert.equal(result.total, 0)
  assert.deepEqual(result.byKind, {})
  assert.equal(result.issues.lowQuality, 0)
  assert.equal(result.issues.duplicateGroups, 0)
  assert.ok(result.suggestions.some((suggestion) => /No memory records/i.test(suggestion)))
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})
