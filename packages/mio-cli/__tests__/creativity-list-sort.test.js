'use strict'

// `mio creativity list --sort novelty` — relative novelty ranking (spec
// Capability 3). noveltyScore is a DEDUP/RANKING signal, never a quality score.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
const { CreativityEngine } = require('../server/creativity-engine.js')

function workspace() {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-sort-'))
  const dir = path.join(mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  return { mioHome, file: path.join(dir, 'creativity-hypotheses.jsonl') }
}

function seed(ws, records) {
  fs.writeFileSync(ws.file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function engine(ws) {
  return new CreativityEngine(path.join(ws.mioHome, 'creativity'), async () => ({ data: [] }))
}

const h = (id, title, idea, novelty, status = 'active') => ({
  id, title, idea, expectedBenefit: 'b', risk: 'r',
  novelty, feasibility: 50, impact: 50, sourceLabels: ['A', 'B'],
  status, createdAt: 1000 + Number(id.replace(/\D/g, '')),
})

test('sort novelty ranks by noveltyScore desc and exposes the field', () => {
  const ws = workspace()
  // unique texts so pairwise similarity stays low; noveltyScore ~= stored novelty
  seed(ws, [
    h('h1', 'Idea about token rotation', 'rotate tokens through cache layer daily', 30),
    h('h2', 'Idea about schema migrations', 'batch schema migrations with dual writes', 80),
    h('h3', 'Idea about trace sampling', 'sample traces by outcome rather than rate', 55),
  ])
  const rows = engine(ws).list({ sort: 'novelty' })
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.id), ['h2', 'h3', 'h1'])
  for (const row of rows) {
    assert.equal(typeof row.noveltyScore, 'number')
    assert.notEqual(row.noveltyScore, row.score, 'noveltyScore must stay distinct from the quality sum `score`')
  }
})

test('sort novelty respects status filter and limit', () => {
  const ws = workspace()
  seed(ws, [
    h('h1', 'Alpha idea one', 'completely different subject matter entirely', 90),
    h('h2', 'Beta idea two', 'another unrelated topic with words', 40, 'rejected'),
    h('h3', 'Gamma idea three', 'third distinct proposition here now', 60),
  ])
  const rows = engine(ws).list({ sort: 'novelty', status: 'active', limit: 1 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'h1')
})

test('sort novelty caps the O(n²) candidate set at the newest 200', () => {
  const ws = workspace()
  const records = []
  for (let i = 0; i < 230; i++) records.push(h(`h${i}`, `Unique title ${i}`, `unique body number ${i} says nothing alike`, 10 + (i % 80)))
  seed(ws, records)
  const rows = engine(ws).list({ sort: 'novelty', limit: 0 })
  assert.equal(rows.length, 200)
})

test('CLI rejects an unknown --sort and accepts novelty', () => {
  const ws = workspace()
  seed(ws, [h('h1', 'Solo idea', 'just one stored hypothesis body', 50)])
  const bad = spawnSync(process.execPath, [CLI, 'creativity', 'list', '--sort', 'value'], {
    encoding: 'utf8', env: { ...process.env, MIO_HOME: ws.mioHome },
  })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /unknown --sort "value"/)
  const good = spawnSync(process.execPath, [CLI, 'creativity', 'list', '--sort', 'novelty', '--json'], {
    encoding: 'utf8', env: { ...process.env, MIO_HOME: ws.mioHome },
  })
  assert.equal(good.status, 0)
  const rows = JSON.parse(good.stdout)
  assert.equal(typeof rows[0].noveltyScore, 'number')
})
