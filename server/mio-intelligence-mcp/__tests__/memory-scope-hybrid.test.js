'use strict'

// Integration test for mio.memory.query scope (project/global/all) and
// hybrid scoring (latin substring recall + CJK bigram phrase ranking).
// Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-scope-'))
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

function queryIds(result) {
  return result.results.map((record) => record.id).sort()
}

test('memory.record defaults to project scope; global stores project null', async () => {
  const proj = await callTool('mio.memory.record', {
    content: '项目级记录：MCP server 用 stdio 协议启动',
    kind: 'note',
  })
  assert.equal(proj.scope, 'project')
  assert.equal(proj.project, 'akemi-mio')

  const global = await callTool('mio.memory.record', {
    content: '全局经验：在任何项目中配置 MCP 都要先检查 opencode.json',
    kind: 'context',
    scope: 'global',
  })
  assert.equal(global.scope, 'global')
  assert.equal(global.project, null)
})

test('memory.query scope=project excludes global records', async () => {
  writeMemories([
    { id: 'r1', timestamp: '2026-08-17T00:00:00.000Z', kind: 'decision', content: '项目记录 A 使用流式 JSON 解析处理大型 MCP 载荷', project: 'akemi-mio', source: 'codex' },
    { id: 'r2', timestamp: '2026-08-17T00:00:00.000Z', kind: 'context', content: '全局经验：MCP server 应优先使用本地路径避免网络依赖', project: null, scope: 'global', source: 'codex' },
  ])
  const result = await callTool('mio.memory.query', { query: 'MCP', scope: 'project' })
  assert.deepEqual(queryIds(result), ['r1'])
  assert.equal(result.scope, 'project')
})

test('memory.query scope=global returns only global records', async () => {
  writeMemories([
    { id: 'r1', timestamp: '2026-08-17T00:00:00.000Z', kind: 'decision', content: '项目记录 A 使用流式 JSON 解析处理大型 MCP 载荷', project: 'akemi-mio', source: 'codex' },
    { id: 'r2', timestamp: '2026-08-17T00:00:00.000Z', kind: 'context', content: '全局经验：MCP server 应优先使用本地路径避免网络依赖', project: null, scope: 'global', source: 'codex' },
  ])
  const result = await callTool('mio.memory.query', { query: 'MCP', scope: 'global' })
  assert.deepEqual(queryIds(result), ['r2'])
})

test('memory.query scope=all returns project and global, excludes other projects', async () => {
  writeMemories([
    { id: 'r1', timestamp: '2026-08-17T00:00:00.000Z', kind: 'decision', content: '项目记录 A 使用流式 JSON 解析处理大型 MCP 载荷', project: 'akemi-mio', source: 'codex' },
    { id: 'r2', timestamp: '2026-08-17T00:00:00.000Z', kind: 'context', content: '全局经验：MCP server 应优先使用本地路径避免网络依赖', project: null, scope: 'global', source: 'codex' },
    { id: 'r3', timestamp: '2026-08-17T00:00:00.000Z', kind: 'decision', content: '其他项目记录不应该被召回', project: 'other-project', source: 'codex' },
  ])
  const result = await callTool('mio.memory.query', { query: 'MCP', scope: 'all' })
  assert.deepEqual(queryIds(result), ['r1', 'r2'])
})

test('memory.query latin substring recall (retriev -> retrieval)', async () => {
  writeMemories([
    { id: 'r1', timestamp: '2026-08-17T00:00:00.000Z', kind: 'decision', content: '采用 retrieval pipeline 检索历史决策', project: 'akemi-mio', source: 'codex' },
    { id: 'r2', timestamp: '2026-08-17T00:00:00.000Z', kind: 'decision', content: 'token 尖峰问题用流式解析解决', project: 'akemi-mio', source: 'codex' },
  ])
  const result = await callTool('mio.memory.query', { query: 'retriev', scope: 'project' })
  assert.deepEqual(queryIds(result), ['r1'])
})

test('memory.query CJK bigram ranks phrase-adjacent record first', async () => {
  writeMemories([
    { id: 'r1', timestamp: '2026-08-17T00:00:00.000Z', kind: 'decision', content: '部署环境限制导致不能使用 Redis', project: 'akemi-mio', source: 'codex' },
    { id: 'r2', timestamp: '2026-08-17T00:00:00.000Z', kind: 'decision', content: '环境与部署相互独立，需分别评估', project: 'akemi-mio', source: 'codex' },
  ])
  const result = await callTool('mio.memory.query', { query: '部署环境', limit: 5 })
  assert.deepEqual(queryIds(result), ['r1', 'r2'])
  assert.equal(result.results[0].id, 'r1', 'phrase-adjacent record should rank first')
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})