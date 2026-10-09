'use strict'

// Tests for `mio creativity status` and `mio creativity list`. Hypotheses are
// seeded directly into a throwaway MIO_HOME so the counts/filters can be
// asserted exactly. The CLI points the engine at <MIO_HOME>/creativity, the
// same directory the MCP server writes to, so the two entry points agree.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cre-' + label + '-'))
}

function run(cwd, env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env })
}

function workspace(label) {
  const mioHome = tempDir(label)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cre-cwd-'))
  const env = { ...process.env, MIO_HOME: mioHome }
  return { mioHome, cwd, env }
}

// Seed the creativity hypotheses store directly. The engine reads
// <MIO_HOME>/creativity/creativity-hypotheses.jsonl.
function seedHypotheses(ws, hypotheses) {
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'creativity-hypotheses.jsonl'),
    hypotheses.map((h) => JSON.stringify(h)).join('\n') + '\n',
    'utf8'
  )
}

function hypothesis(id, status, scores = {}) {
  return {
    id,
    title: 'Hypothesis ' + id,
    idea: 'combine A and B',
    status,
    novelty: scores.novelty ?? 60,
    feasibility: scores.feasibility ?? 50,
    impact: scores.impact ?? 70,
    sourceLabels: ['A', 'B'],
    createdAt: Date.now(),
    strategy: 'explore',
  }
}

function statusJson(ws, extra = []) {
  const result = run(ws.cwd, ws.env, ['creativity', 'status', '--json', ...extra])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function listJson(ws, extra = []) {
  const result = run(ws.cwd, ws.env, ['creativity', 'list', '--json', ...extra])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('creativity status reports zero when the store is empty', () => {
  const ws = workspace('empty')
  const result = statusJson(ws)
  assert.equal(result.hypotheses, 0)
  assert.equal(result.combos, 0)
  assert.equal(result.experiments, 0)
  assert.equal(result.active, 0)
  assert.equal(result.validated, 0)
  assert.equal(result.rejected, 0)
  assert.equal(result.draft, 0)
  assert.deepEqual(result.recentIdeas, [])

  const text = run(ws.cwd, ws.env, ['creativity', 'status'])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /No hypotheses yet/)
})

test('creativity status aggregates counts by status', () => {
  const ws = workspace('counts')
  seedHypotheses(ws, [
    hypothesis('h1', 'active', { novelty: 80, feasibility: 70, impact: 90 }),
    hypothesis('h2', 'active'),
    hypothesis('h3', 'validated'),
    hypothesis('h4', 'rejected'),
    hypothesis('h5', 'draft'),
  ])

  const result = statusJson(ws)
  assert.equal(result.hypotheses, 5)
  assert.equal(result.active, 2)
  assert.equal(result.validated, 1)
  assert.equal(result.rejected, 1)
  assert.equal(result.draft, 1, 'draft is a real state and must be counted')
  assert.equal(result.recentIdeas.length, 2, 'recentIdeas is the last 5 active, capped by available active')

  const top = result.recentIdeas.find((i) => i.id === 'h1')
  assert.ok(top, 'h1 should be among recent ideas')
  assert.equal(top.score, 80 + 70 + 90)

  // status and the list filter must agree on the same store.
  assert.equal(result.draft, listJson(ws, ['--status', 'draft']).length)
})

test('creativity list returns the newest 20 by default and everything with --limit 0', () => {
  const ws = workspace('listall')
  const many = Array.from({ length: 25 }, (_, i) => hypothesis(`h${i + 1}`, 'active'))
  seedHypotheses(ws, many)

  const items = listJson(ws)
  assert.equal(items.length, 20, 'default limit is 20, matching the MCP schema and usage text')
  assert.deepEqual(
    items.map((h) => h.id),
    many.slice(-20).map((h) => h.id),
    'the default slice is the newest, not the oldest'
  )

  const all = listJson(ws, ['--limit', '0'])
  assert.equal(all.length, 25, 'limit 0 is the documented opt-out back to everything')

  const text = run(ws.cwd, ws.env, ['creativity', 'list'])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /Hypotheses: 20 shown/)
  assert.match(text.stdout, /h25/)
  assert.doesNotMatch(text.stdout, /h1\b/, 'the oldest rows are past the default window')

  // A small store is unaffected: nothing is hidden when there are <= 20 rows.
  const small = workspace('listsmall')
  seedHypotheses(small, [hypothesis('h1', 'active'), hypothesis('h2', 'rejected')])
  assert.equal(listJson(small).length, 2)
})

test('creativity list filters by status', () => {
  const ws = workspace('filter')
  seedHypotheses(ws, [
    hypothesis('h1', 'active'),
    hypothesis('h2', 'rejected'),
    hypothesis('h3', 'rejected'),
  ])

  const items = listJson(ws, ['--status', 'rejected'])
  assert.equal(items.length, 2)
  assert.ok(items.every((h) => h.status === 'rejected'))

  const none = listJson(ws, ['--status', 'validated'])
  assert.equal(none.length, 0)

  const text = run(ws.cwd, ws.env, ['creativity', 'list', '--status', 'validated'])
  assert.match(text.stdout, /No hypotheses match/)
})

test('creativity list honours --limit', () => {
  const ws = workspace('limit')
  seedHypotheses(ws, [
    hypothesis('h1', 'active'),
    hypothesis('h2', 'active'),
    hypothesis('h3', 'active'),
    hypothesis('h4', 'active'),
  ])

  const items = listJson(ws, ['--limit', '2'])
  assert.equal(items.length, 2)
})

test('creativity subcommand validates its arguments', () => {
  const ws = workspace('usage')
  seedHypotheses(ws, [hypothesis('h1', 'active')])

  const none = run(ws.cwd, ws.env, ['creativity'])
  assert.equal(none.status, 1)
  assert.match(none.stdout, /Usage:/)

  const unknown = run(ws.cwd, ws.env, ['creativity', 'bogus'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown creativity subcommand: bogus/)
  // Usage must go to stderr too, leaving stdout empty for `--json` callers.
  assert.match(unknown.stderr, /Usage:/)
  assert.equal(unknown.stdout, '')

  // generate/ferment are now exposed (they use the shared LLM client), so they
  // fail on argument validation rather than being unknown subcommands.
  const gen = run(ws.cwd, ws.env, ['creativity', 'generate'])
  assert.equal(gen.status, 1)
  assert.match(gen.stderr, /at least two --source/)

  const help = run(ws.cwd, ws.env, ['creativity', 'help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mio creativity status/)
})

test('the CLI and the shared engine agree on the same hypotheses', () => {
  // Both entry points delegate to CreativityEngine; this pins that the CLI
  // points at the same store the engine would read directly.
  const { CreativityEngine } = require('../server/creativity-engine.js')
  const ws = workspace('store')
  seedHypotheses(ws, [
    hypothesis('h1', 'active', { novelty: 90, feasibility: 80, impact: 95 }),
    hypothesis('h2', 'rejected'),
    hypothesis('h3', 'validated'),
  ])

  const engine = new CreativityEngine(path.join(ws.mioHome, 'creativity'), () => {
    throw new Error('no LLM in test')
  })

  const directStatus = engine.status()
  const viaCliStatus = statusJson(ws)
  assert.equal(directStatus.hypotheses, viaCliStatus.hypotheses)
  assert.equal(directStatus.active, viaCliStatus.active)
  assert.equal(directStatus.rejected, viaCliStatus.rejected)
  assert.deepEqual(directStatus.recentIdeas, viaCliStatus.recentIdeas)

  const directList = engine.list({ status: 'rejected' })
  const viaCliList = listJson(ws, ['--status', 'rejected'])
  assert.equal(directList.length, viaCliList.length)
  assert.deepEqual(
    directList.map((h) => h.id),
    viaCliList.map((h) => h.id)
  )
})

// --- read-side adoption join (idea b19bada4, D3) ---------------------------
// adoption is NOT a store status: status()/list() join the two write-side
// evidence axes (creativity.adopt trace events + hypothesis:<id> memory tags)
// at read time. These tests pin the join semantics: raw distinct counts per
// axis, inner join for adopted, metric:false + sources annotation, and the
// text-mode rendering. Each workspace is a fresh MIO_HOME, so counts are exact.

function seedEvidenceFiles(ws, { events = [], records = [] }) {
  if (events.length > 0) {
    fs.writeFileSync(
      path.join(ws.mioHome, 'traces.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8'
    )
  }
  if (records.length > 0) {
    fs.writeFileSync(
      path.join(ws.mioHome, 'memory.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8'
    )
  }
}

test('creativity status joins adopt events and memory tags into non-metric adoption counts', () => {
  const ws = workspace('adoptjoin')
  seedHypotheses(ws, [hypothesis('h1', 'active'), hypothesis('h2', 'validated'), hypothesis('h3', 'draft')])
  seedEvidenceFiles(ws, {
    events: [
      { trace_id: 't1', event_type: 'creativity.adopt', outcome: 'success', payload: { hypothesisId: 'h1' } },
      { trace_id: 't2', event_type: 'creativity.adopt', outcome: 'success', payload: { hypothesisId: 'h1' } },
      { trace_id: 't3', event_type: 'creativity.adopt', outcome: 'success', payload: { hypothesisId: 'ghost-event' } },
      { trace_id: 't4', event_type: 'task_outcome', outcome: 'success', payload: { summary: 'unrelated' } },
    ],
    records: [
      { id: 'm1', content: 'x', tags: ['hypothesis:h2', 'other'] },
      { id: 'm2', content: 'y', tags: ['hypothesis:ghost-tag'] },
      { id: 'm3', content: 'z', tags: [] },
      { id: 'm4', content: 'w' },
    ],
  })

  const result = statusJson(ws)
  assert.equal(result.adoption.claimed, 2, 'distinct event ids, duplicates collapse, non-adopt events ignored')
  assert.equal(result.adoption.evidenced, 2, 'distinct tag ids across records, missing tags field is fine')
  assert.equal(result.adoption.adopted, 2, 'the inner join drops ghost ids that are not stored hypotheses')
  assert.equal(result.adoption.metric, false, 'informational join, not an ADR-017 metric')
  assert.match(result.adoption.note, /no rate or threshold/, 'D3: adoption rate and thresholds stay out of scope')
  assert.deepEqual(result.adoption.sources, {
    events: { file: 'traces.jsonl', durable: true },
    memory: { file: 'memory.jsonl', durable: true },
  })

  const items = listJson(ws, ['--limit', '0'])
  assert.deepEqual(
    Object.fromEntries(items.map((h) => [h.id, h.adopted])),
    { h1: true, h2: true, h3: false },
    'list rows carry adopted: event hit, tag hit, and no-evidence states'
  )
})

test('creativity adoption join is all-zero without evidence files and renders in text mode', () => {
  const ws = workspace('adoptzero')
  seedHypotheses(ws, [hypothesis('h1', 'active')])

  const result = statusJson(ws)
  assert.deepEqual(
    {
      adopted: result.adoption.adopted,
      claimed: result.adoption.claimed,
      evidenced: result.adoption.evidenced,
    },
    { adopted: 0, claimed: 0, evidenced: 0 },
    'missing traces/memory files are normal, not an error'
  )

  const statusText = run(ws.cwd, ws.env, ['creativity', 'status'])
  assert.equal(statusText.status, 0, statusText.stderr)
  assert.match(
    statusText.stdout,
    /adoption: 0 adopted \(events=0 tags=0\) — derived join, not a metric/
  )

  fs.appendFileSync(
    path.join(ws.mioHome, 'traces.jsonl'),
    JSON.stringify({ trace_id: 't1', event_type: 'creativity.adopt', outcome: 'success', payload: { hypothesisId: 'h1' } }) + '\n',
    'utf8'
  )
  const statusText2 = run(ws.cwd, ws.env, ['creativity', 'status'])
  assert.equal(statusText2.status, 0, statusText2.stderr)
  assert.match(statusText2.stdout, /adoption: 1 adopted \(events=1 tags=0\)/)

  const listText = run(ws.cwd, ws.env, ['creativity', 'list'])
  assert.equal(listText.status, 0, listText.stderr)
  assert.match(listText.stdout, /\[active\] \[adopted\]/, 'adopted rows are marked in text mode')
  assert.match(listText.stdout, /h1/)
})
