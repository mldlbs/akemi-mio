'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createExperienceStore } = require('../server/experience-store.js')
const { createQueryLog } = require('../server/query-log.js')
const { appendJsonl, writeJsonl } = require('../server/memory-store.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-storescache-' + label + '-'))
}

// experience-store reads experience_reuse.jsonl through readJsonlCached and its
// writes go through memory-store's writeJsonl/appendJsonl (which dropCache).
// Guard: warm listReuse == cold, and a write invalidates the cache.
test('experience-store shares the read cache: warm==cold and invalidates on write', () => {
  const dataDir = tempDir('exp')
  const experienceReusePath = path.join(dataDir, 'experience_reuse.jsonl')
  const seed = [
    { id: 'r1', experienceId: 'm1', source: 'manual', confirmed: true, reuse: true, behaviorChanged: true, outcomeImproved: true, timestamp: new Date().toISOString() },
    { id: 'r2', experienceId: 'm2', source: 'auto_claim', confirmed: false, reuse: true, behaviorChanged: false, outcomeImproved: false, timestamp: new Date().toISOString() },
  ]
  writeJsonl(experienceReusePath, seed)

  const store = createExperienceStore({ dataDir, projectName: () => null, agentId: () => 'agent' })
  const cold = store.listReuse({ status: 'all' }).records.map((r) => r.id)
  const warm = store.listReuse({ status: 'all' }).records.map((r) => r.id)
  assert.deepEqual(warm, cold, 'a warm listReuse must return identical records as a cold read')

  // Invalidation: a write via the shared appendJsonl must surface a new record.
  appendJsonl(experienceReusePath, {
    id: 'r3',
    experienceId: 'm3',
    source: 'manual',
    confirmed: true,
    reuse: true,
    behaviorChanged: true,
    outcomeImproved: true,
    timestamp: new Date().toISOString(),
  })
  const after = store.listReuse({ status: 'all' }).records.map((r) => r.id)
  assert.ok(after.includes('r3'), 'cache must be invalidated by the write so the new reuse record is visible')
})

// query-log's persist() was rewired to memory-store's writeJsonl (format-identical
// JSONL, but it also drops the cache). Guard that a recorded entry is visible both
// warm and after a second record -- a stale cache would keep returning the old set.
test('query-log persist invalidates the read cache', () => {
  const dataDir = tempDir('qlog')
  const log = createQueryLog({ dataDir })
  assert.equal(log.load().length, 0, 'sanity: empty before any record')

  log.record({ agent: 'a', project: null, query: 'q1', resultIds: [], resultSources: [], timestamp: Date.now(), expiresAt: Date.now() + 100000 })
  const cold = log.load().length
  const warm = log.load().length
  assert.equal(warm, cold, 'a warm load must equal a cold load')
  assert.equal(cold, 1, 'the recorded entry must be visible')

  log.record({ agent: 'a', project: null, query: 'q2', resultIds: [], resultSources: [], timestamp: Date.now(), expiresAt: Date.now() + 100000 })
  assert.equal(log.load().length, 2, 'cache must be invalidated by persist (writeJsonl) so the 2nd record is visible')
})
