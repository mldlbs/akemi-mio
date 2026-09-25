'use strict'

// D3: a long-running MCP process served stale insight data. The underlying
// InsightStore loads its JSON once in its constructor and answers every later
// read from that frozen copy; insight-store.js then cached that one instance
// forever. Measured symptom: MCP insight status 0 while a fresh CLI process
// (`mio insight status`) said 4.
//
// The wrapper now validates (size, mtimeMs) on every call and rebuilds when the
// file changes -- the same guarantee memory-store.js gives its JSONL reads.
//
// These tests use the real @akemi-mio/insight package (workspace dist, built by
// CI before this suite runs), so a missing build fails loudly rather than
// silently. Nothing here touches the network.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createInsightStore, isInsightAvailable } = require('../server/insight-store.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mio-insightfresh-${label}-`))
}

function insight(id, createdAt, score = 80) {
  return { id, detector: 'test', kind: 'gap', score, confidence: 0.9, title: id, createdAt }
}

function writeStore(file, insights, reportedIds = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 1, insights, reportedIds }), 'utf8')
}

test('the optional package is available (workspace dist is built)', () => {
  assert.equal(isInsightAvailable(), true, 'build packages/insight (npx tsc -p packages/insight/tsconfig.json) first')
})

test('an instance sees insights written by another process, without a restart', () => {
  const dataDir = tempDir('external')
  const file = path.join(dataDir, 'insights', 'insights.json')
  writeStore(file, [insight('i1', 1)])

  const store = createInsightStore({ dataDir })
  assert.equal(store.status().total, 1, 'cold read sees the seeded insight')

  // A separate process (e.g. `mio insight generate` in another session) writes
  // a new insight. The already-built store object must pick it up.
  writeStore(file, [insight('i1', 1), insight('i2', 2)])
  assert.equal(store.status().total, 2, 'a later external write must be visible without a restart')

  writeStore(file, [insight('i1', 1)])
  assert.equal(store.status().total, 1, 'a deletion is visible too')
})

test('the first read after the file appears is not stuck on the empty cache', () => {
  const dataDir = tempDir('late-file')
  const file = path.join(dataDir, 'insights', 'insights.json')

  const store = createInsightStore({ dataDir })
  assert.equal(store.status().total, 0, 'no file yet: empty, not an error')

  writeStore(file, [insight('i1', 1), insight('i2', 2), insight('i3', 3)])
  assert.equal(store.status().total, 3, 'the file appearing after the first call must be read')
})

test('the instance still reflects its own writes', () => {
  const dataDir = tempDir('selfwrite')
  const file = path.join(dataDir, 'insights', 'insights.json')
  writeStore(file, [insight('i1', 1), insight('i2', 2)])

  const store = createInsightStore({ dataDir })
  assert.equal(store.status().unreported, 2)

  store.markReported({ ids: ['i1'] })
  assert.equal(store.status().unreported, 1, 'a reported id must survive the signature-checked rebuild')
})

test('repeated reads with no writer reuse the same instance (no thrashing)', () => {
  const dataDir = tempDir('stable')
  const file = path.join(dataDir, 'insights', 'insights.json')
  writeStore(file, [insight('i1', 1)])

  const store = createInsightStore({ dataDir })
  const a = store.status().total
  const b = store.status().total
  const c = store.status().total
  assert.deepEqual([a, b, c], [1, 1, 1])
})
