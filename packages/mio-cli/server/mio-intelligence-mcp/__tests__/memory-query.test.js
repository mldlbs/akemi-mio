'use strict'

// Integration test for mio.memory.query kind/tags filters.
// Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-memquery-'))
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
    tags: ['mcp', 'performance'],
    ...overrides,
  }
}

function queryIds(result) {
  return result.results.map((record) => record.id).sort()
}

test('memory.query filters by kind', async () => {
  writeMemories([
    memory({ id: 'r1', kind: 'decision' }),
    memory({ id: 'r2', kind: 'problem', content: 'MCP 载荷导致 token 尖峰，需要流式解析处理' }),
    memory({ id: 'r3', kind: 'decision', content: '使用内存归档整理重复记忆记录以保持 MCP 检索精确', tags: ['architecture'] }),
  ])

  const decisions = await callTool('mio.memory.query', { query: 'mcp', kind: 'decision' })
  assert.deepEqual(queryIds(decisions), ['r1', 'r3'])
  assert.equal(decisions.kind, 'decision')

  const problems = await callTool('mio.memory.query', { query: 'mcp', kind: 'problem' })
  assert.deepEqual(queryIds(problems), ['r2'])
})

test('memory.query filters by tags (AND semantics)', async () => {
  writeMemories([
    memory({ id: 'r1', tags: ['mcp', 'performance'] }),
    memory({ id: 'r2', tags: ['mcp'], content: 'MCP 载荷导致 token 尖峰，需要流式解析处理' }),
    memory({ id: 'r3', tags: ['architecture'], content: '使用内存归档整理重复记忆记录以保持 MCP 检索精确' }),
  ])

  const withPerformance = await callTool('mio.memory.query', { query: 'mcp', tags: ['performance'] })
  assert.deepEqual(queryIds(withPerformance), ['r1'])

  const withMcp = await callTool('mio.memory.query', { query: 'mcp', tags: ['mcp'] })
  assert.deepEqual(queryIds(withMcp), ['r1', 'r2'])

  const combined = await callTool('mio.memory.query', {
    query: 'mcp',
    tags: ['mcp', 'performance'],
  })
  assert.deepEqual(queryIds(combined), ['r1'])
  assert.deepEqual(combined.tags, ['mcp', 'performance'])
})

test('memory.query kind+tags combined filter can return no results', async () => {
  writeMemories([memory({ id: 'r1', kind: 'decision', tags: ['mcp', 'performance'] })])
  const result = await callTool('mio.memory.query', {
    query: 'mcp',
    kind: 'problem',
    tags: ['performance'],
  })
  assert.equal(result.count, 0)
  assert.deepEqual(queryIds(result), [])
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})
