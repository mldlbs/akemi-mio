'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-memstore-' + label + '-'))
}

function makeStore(dataDir, overrides = {}) {
  const { createMemoryStore } = require('../server/memory-store.js')
  return createMemoryStore({
    dataDir,
    projectName: () => 'proj-a',
    agentId: () => 'test-agent',
    ...overrides,
  })
}

test('record then query round-trips with latin, prefix, and CJK matching', () => {
  const dataDir = tempDir('rt')
  const store = makeStore(dataDir)

  const recorded = store.recordMemory({
    content: 'PySWMM result_data 写入 PostgreSQL 后 statisticsData 为 null 的根因是持久化字段缺失',
    kind: 'problem',
    tags: 'pyswmm, postgres',
  })
  assert.ok(recorded.id.startsWith('mem_'))
  assert.equal(recorded.project, 'proj-a')
  assert.equal(recorded.source, 'test-agent')

  // latin token match
  const byLatin = store.queryMemory({ query: 'postgres statisticsdata' })
  assert.ok(byLatin.count >= 1)
  assert.equal(byLatin.results[0].id, recorded.id)

  // latin prefix match (partial token)
  const byPrefix = store.queryMemory({ query: 'postgre' })
  assert.ok(byPrefix.count >= 1)

  // CJK bigram match
  const byCjk = store.queryMemory({ query: '持久化字段' })
  assert.ok(byCjk.count >= 1)
})

test('project and global scope filtering behaves like the MCP server', () => {
  const dataDir = tempDir('scope')
  const store = makeStore(dataDir)

  store.recordMemory({ content: 'akemi-mio monorepo split decision' })
  store.recordMemory({ content: 'global user preference about minimal ui', scope: 'global' })

  // default project scope: only the project record
  const projectScope = store.queryMemory({ query: 'monorepo' })
  assert.equal(projectScope.count, 1)
  assert.equal(projectScope.results[0].project, 'proj-a')

  // same record not visible from another project in project scope
  const other = makeStore(dataDir, { projectName: () => 'proj-b' })
  assert.equal(other.queryMemory({ query: 'monorepo' }).count, 0)

  // global record visible from any project in 'all' scope
  const allScope = other.queryMemory({ query: 'minimal ui', scope: 'all' })
  assert.equal(allScope.count, 1)
  assert.equal(allScope.layers.global, 1)

  // 'global' scope returns only global records
  assert.equal(other.queryMemory({ query: 'minimal ui', scope: 'global' }).count, 1)
  assert.equal(other.queryMemory({ query: 'monorepo', scope: 'global' }).count, 0)
})

test('archived records are excluded and kind/tags filters apply', () => {
  const dataDir = tempDir('filters')
  const store = makeStore(dataDir)
  const keep = store.recordMemory({ content: 'failover priority rotation plan', kind: 'decision', tags: ['gateway'] })
  const drop = store.recordMemory({ content: 'failover old plan', kind: 'note' })

  const file = store.memoryPath
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const archived = lines.map((l) => (l.id === drop.id ? { ...l, archived: true } : l))
  fs.writeFileSync(file, archived.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')

  const result = store.queryMemory({ query: 'failover plan' })
  assert.equal(result.count, 1)
  assert.equal(result.results[0].id, keep.id)

  const byKind = store.queryMemory({ query: 'failover plan', kind: 'decision' })
  assert.equal(byKind.count, 1)
  const byWrongKind = store.queryMemory({ query: 'failover plan', kind: 'context' })
  assert.equal(byWrongKind.count, 0)
  const byTag = store.queryMemory({ query: 'failover plan', tags: ['gateway'] })
  assert.equal(byTag.count, 1)
})

test('evidence weights boost reused memories in ranking', () => {
  const dataDir = tempDir('evidence')
  const store = makeStore(dataDir)
  const plain = store.recordMemory({ content: 'gateway failover approach one' })
  const reused = store.recordMemory({ content: 'gateway failover approach two' })

  fs.appendFileSync(
    store.experienceReusePath,
    JSON.stringify({
      id: 'x1',
      timestamp: new Date().toISOString(),
      sourceAgent: 'a',
      targetAgent: 'b',
      experienceId: reused.id,
      reuse: true,
      behaviorChanged: true,
      outcomeImproved: true,
    }) + '\n',
    'utf8'
  )

  const result = store.queryMemory({ query: 'gateway failover approach', limit: 2 })
  assert.equal(result.count, 2)
  assert.equal(result.results[0].id, reused.id, 'evidence-boosted record ranks first')
  assert.ok(result.results[0].evidence && result.results[0].evidence.reuseCount === 1)
  assert.equal(result.results[1].id, plain.id)
})

test('CLI mio remember + mio recall round-trip against MIO_HOME', () => {
  const mioHome = tempDir('cli')
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-memstore-cwd-'))
  const env = { ...process.env, MIO_HOME: mioHome }

  const remember = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js'),
      'remember', 'sub2api 网关 default 别名必须多宿主轮换', '--kind', 'decision', '--tags', 'sub2api,gateway'],
    { cwd, encoding: 'utf8', env }
  )
  assert.equal(remember.status, 0, remember.stderr)
  assert.ok(remember.stdout.includes('Recorded mem_'))

  const recall = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js'), 'recall', 'sub2api gateway 轮换', '--json'],
    { cwd, encoding: 'utf8', env }
  )
  assert.equal(recall.status, 0, recall.stderr)
  const payload = JSON.parse(recall.stdout)
  assert.equal(payload.count, 1)
  assert.equal(payload.results[0].kind, 'decision')
  assert.equal(payload.results[0].source, 'cli')
  assert.ok(payload.results[0].content.includes('多宿主轮换'))

  // project isolation: the record belongs to the temp cwd basename project
  const projectName = path.basename(cwd)
  assert.equal(payload.project, projectName)
})
