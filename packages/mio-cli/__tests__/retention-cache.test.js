'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { readJsonlCached, writeJsonl } = require('../server/memory-store.js')
const { createRetention } = require('../server/retention.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-retcache-' + label + '-'))
}

// retention.prune rewrites shared JSONL files. It must invalidate the cross-call
// read cache so that consumers reading through readJsonlCached see the pruned
// (smaller) set rather than a stale pre-prune copy.
test('retention.prune invalidates the shared read cache for the files it rewrites', () => {
  const home = tempDir('prune')
  const tracePath = path.join(home, 'traces.jsonl')
  const fixed = Date.now()
  const oldTs = new Date(fixed - 30 * 86400000).toISOString() // 30 days ago
  const recentTs = new Date(fixed - 3600000).toISOString() // 1 hour ago

  // 4 old + 2 recent task_outcome traces.
  writeJsonl(tracePath, [
    { id: 't1', agent: 'a', event_type: 'task_outcome', outcome: 'success', timestamp: oldTs },
    { id: 't2', agent: 'a', event_type: 'task_outcome', outcome: 'success', timestamp: oldTs },
    { id: 't3', agent: 'a', event_type: 'task_outcome', outcome: 'success', timestamp: oldTs },
    { id: 't4', agent: 'a', event_type: 'task_outcome', outcome: 'success', timestamp: oldTs },
    { id: 't5', agent: 'a', event_type: 'task_outcome', outcome: 'success', timestamp: recentTs },
    { id: 't6', agent: 'a', event_type: 'task_outcome', outcome: 'success', timestamp: recentTs },
  ])

  // Warm the cache through the consumer's read path.
  const cold = readJsonlCached(tracePath).length
  assert.equal(cold, 6, 'sanity: cache holds all 6 traces')

  // Prune anything older than 7 days. The 4 old traces must be removed; the 2
  // recent ones must remain. Crucially, the cache must reflect this.
  const retention = createRetention({ home, now: () => fixed })
  const result = retention.prune({ days: 7, dryRun: false })
  assert.equal(result.totalRemoved, 4, 'prune should report removing the 4 old traces')

  const after = readJsonlCached(tracePath).length
  assert.equal(after, 2, 'cache must be invalidated by the prune so only the 2 recent traces remain')

  // The on-disk file agrees with the cached view (no stale copy).
  const onDisk = readJsonlCached(tracePath).map((r) => r.id).sort()
  assert.deepEqual(onDisk, ['t5', 't6'], 'cached view must match the pruned file')
})

// memory.jsonl is only pruned when includeMemory is set; the same invalidation
// contract applies.
test('retention.prune invalidates the cache for memory.jsonl when includeMemory is set', () => {
  const home = tempDir('mem')
  const memoryPath = path.join(home, 'memory.jsonl')
  const fixed = Date.now()
  const oldTs = new Date(fixed - 30 * 86400000).toISOString()
  const recentTs = new Date(fixed - 3600000).toISOString()

  writeJsonl(memoryPath, [
    { id: 'm1', kind: 'fact', content: 'old memory content here long enough', timestamp: oldTs },
    { id: 'm2', kind: 'fact', content: 'recent memory content here long enough', timestamp: recentTs },
  ])

  const cold = readJsonlCached(memoryPath).length
  assert.equal(cold, 2, 'sanity: cache holds both memories')

  const retention = createRetention({ home, now: () => fixed })
  retention.prune({ days: 7, includeMemory: true, dryRun: false })

  const after = readJsonlCached(memoryPath).length
  assert.equal(after, 1, 'cache must reflect the pruned memory.jsonl (only the recent one remains)')
  assert.deepEqual(
    readJsonlCached(memoryPath).map((r) => r.id),
    ['m2'],
    'cached view must match the pruned memory file'
  )
})

// A dry run must NOT invalidate the cache (no write happens).
test('retention.prune dry run leaves the cache untouched', () => {
  const home = tempDir('dry')
  const tracePath = path.join(home, 'traces.jsonl')
  const fixed = Date.now()
  const oldTs = new Date(fixed - 30 * 86400000).toISOString()
  const recentTs = new Date(fixed - 3600000).toISOString()

  writeJsonl(tracePath, [
    { id: 't1', agent: 'a', event_type: 'task_outcome', outcome: 'success', timestamp: oldTs },
    { id: 't2', agent: 'a', event_type: 'task_outcome', outcome: 'success', timestamp: recentTs },
  ])

  const cold = readJsonlCached(tracePath).length
  assert.equal(cold, 2)

  const retention = createRetention({ home, now: () => fixed })
  const result = retention.prune({ days: 7, dryRun: true })
  assert.equal(result.dryRun, true)
  assert.equal(result.totalRemoved, 1, 'dry run still reports what *would* be removed')

  const after = readJsonlCached(tracePath).length
  assert.equal(after, 2, 'dry run must not change the cache (no write occurred)')
})
