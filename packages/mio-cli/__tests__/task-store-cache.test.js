'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createMemoryStore } = require('../server/memory-store.js')
const { createTaskStore } = require('../server/task-store.js')
const { appendJsonl } = require('../server/memory-store.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-taskcache-' + label + '-'))
}

// routeTask re-reads memory.jsonl and experience_reuse.jsonl on every call.
// Those reads go through the shared readJsonlCached() in memory-store.js, so the
// same (size, mtimeMs) cache and dropCache-on-write contract apply here too.
// This guards both that a warm route is byte-identical to a cold one and that a
// write made through the public appendJsonl invalidates the cache.
test('routeTask shares the read cache: warm==cold and invalidates on write', () => {
  const dataDir = tempDir('rt')
  const memoryPath = path.join(dataDir, 'memory.jsonl')
  const experienceReusePath = path.join(dataDir, 'experience_reuse.jsonl')

  const memories = []
  for (let i = 0; i < 50; i++) {
    memories.push({
      id: 'mem_rt_' + i,
      kind: 'note',
      content: 'cache performance query route token ' + (i % 3),
      tags: ['perf'],
      project: null,
      scope: 'project',
      source: 'agent',
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
    })
  }
  fs.writeFileSync(memoryPath, memories.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8')

  const reuse = memories.slice(0, 10).map((m) => ({
    experienceId: m.id,
    sourceAgent: 'a',
    targetAgent: 'b',
    confirmed: true,
    reuse: true,
    behaviorChanged: true,
    outcomeImproved: true,
    timestamp: new Date().toISOString(),
  }))
  fs.writeFileSync(experienceReusePath, reuse.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const memoryStore = createMemoryStore({ dataDir, projectName: () => null, agentId: () => 'agent' })
  const taskStore = createTaskStore({ dataDir, memoryStore, projectName: () => null, agentId: () => 'agent' })

  const run = (q) => {
    const r = taskStore.routeTask({ task: q, scope: 'all', limit: 10, persistQuery: false })
    return JSON.stringify({ routes: r.routes.length, related: r.relatedMemories.map((m) => m.id) })
  }

  const cold = run('cache performance query')
  const warm = run('cache performance query')
  assert.equal(warm, cold, 'a warm routeTask must return identical results as a cold read')

  // Invalidation: a token absent before the write must appear only after it.
  assert.equal(
    taskStore.routeTask({ task: 'brandnewtoken-xyz', scope: 'all', limit: 10, persistQuery: false })
      .relatedMemories.length,
    0,
    'sanity: the token is not present before the write'
  )
  appendJsonl(memoryPath, {
    id: 'mem_rt_new',
    kind: 'note',
    content: 'brandnewtoken-xyz recorded via public path',
    tags: ['cache'],
    project: null,
    scope: 'project',
    source: 'agent',
    timestamp: new Date().toISOString(),
  })
  const afterIds = taskStore
    .routeTask({ task: 'brandnewtoken-xyz', scope: 'all', limit: 10, persistQuery: false })
    .relatedMemories.map((m) => m.id)
  assert.ok(
    afterIds.includes('mem_rt_new'),
    'the cache must be invalidated by the write so the newly recorded memory is immediately routable'
  )
})
