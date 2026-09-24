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

// Regression guard for a real 4x slowdown: queryMemory used to call the scorer
// from inside its sort comparator, so a query over N records invoked the scorer
// O(N log N) times -- measured 6214 invocations for 1094 records on the real
// store, 84 ms of a 111 ms query.
//
// The scorer reads Date.now() once per invocation (its recency boost), and a
// read-only query has no other Date.now() call site, so the call count is a
// faithful proxy for "how many times the scorer ran".
test('queryMemory invokes the scorer at most once per record', () => {
  const dataDir = tempDir('score-once')
  const RECORDS = 120
  const rows = []
  for (let i = 0; i < RECORDS; i++) {
    rows.push(
      JSON.stringify({
        id: 'mem_score_' + i,
        timestamp: new Date(Date.UTC(2026, 0, 1 + (i % 300))).toISOString(),
        kind: 'note',
        content: 'renderer 形态窗口 性能 sharedtoken 第' + i + ' 条',
        tags: ['perf'],
        project: 'proj-a',
        scope: 'project',
        source: 'test-agent',
      })
    )
  }
  fs.writeFileSync(path.join(dataDir, 'memory.jsonl'), rows.join('\n') + '\n', 'utf8')

  const store = makeStore(dataDir)
  const realNow = Date.now
  let nowCalls = 0
  Date.now = () => {
    nowCalls += 1
    return realNow()
  }
  let result
  try {
    result = store.queryMemory({ query: 'renderer 形态窗口 性能', limit: 5 })
  } finally {
    Date.now = realNow
  }

  assert.equal(result.count, 5, 'the query itself must still work')

  // Two branches on purpose. Without the first one, removing the recency boost
  // would zero the counter and silently turn this guard into a no-op that
  // passes no matter how much work the comparator does.
  assert.ok(
    nowCalls > 0,
    'instrumentation is dead: the scorer never read Date.now(), so the bound below proves nothing'
  )
  assert.ok(
    nowCalls <= RECORDS,
    `scorer ran ${nowCalls} times for ${RECORDS} records -- work is happening inside the sort comparator`
  )
})

// The MCP server is long-lived: every tool call re-reads the same append-only
// logs. readJsonlCached() memoizes the parsed records keyed on (size, mtimeMs)
// and drops the entry on every write through appendJsonl/writeJsonl. Two things
// must hold: a warm read is byte-identical to a cold one, and a write made
// through the public API invalidates the cache so a freshly recorded memory is
// immediately queryable. The before/after search below would return the stale
// 0 on a warm cache if dropCache() were not called on write.
test('cross-call read cache is equivalent when warm and invalidates on write', () => {
  const dataDir = tempDir('read-cache')
  const rows = [
    { id: 'mem_cache_1', kind: 'note', content: 'cache invalidation strategy', tags: ['perf'], project: 'proj-a', scope: 'project', source: 'test-agent' },
    { id: 'mem_cache_2', kind: 'note', content: 'warm query cache perf', tags: ['perf'], project: 'proj-a', scope: 'project', source: 'test-agent' },
    { id: 'mem_cache_3', kind: 'decision', content: 'cold read parse cost', tags: ['cache'], project: 'proj-a', scope: 'project', source: 'test-agent' },
  ]
  fs.writeFileSync(
    path.join(dataDir, 'memory.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  )

  const store = makeStore(dataDir)

  const cold = store.queryMemory({ query: 'cache perf', limit: 20 }).results.map((r) => r.id)
  const warm = store.queryMemory({ query: 'cache perf', limit: 20 }).results.map((r) => r.id)
  assert.deepEqual(warm, cold, 'a warm cache read must return identical ids and order as a cold read')

  // Warm the cache against a token that does not exist yet.
  assert.equal(
    store.queryMemory({ query: 'brand-new-token-xyz' }).count,
    0,
    'sanity: the token is not present before the write'
  )
  // Public write path must drop the cache entry so the new record is visible.
  store.recordMemory({ content: 'brand-new-token-xyz recorded via public path', kind: 'note', tags: 'cache' })
  assert.ok(
    store.queryMemory({ query: 'brand-new-token-xyz' }).count >= 1,
    'the cache must be invalidated by the write so the newly recorded memory is immediately queryable'
  )
})
