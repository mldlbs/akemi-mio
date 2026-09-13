'use strict'

// Tests for `mio observer <view>`. The observer research pipeline used to be
// reachable only from inside an MCP session; these pin that the terminal entry
// point reads the same files the same way -- including ordering (newest trend
// report first), the per-view limits and the documented default base directory.
// Data is seeded into a throwaway base dir and passed with --base-dir, so no
// assertion depends on the developer's cwd.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
const { createObserverStore } = require('../server/observer-store.js')

function workspace() {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-obs-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-obs-cwd-'))
  return { mioHome, cwd, env: { ...process.env, MIO_HOME: mioHome } }
}

function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ws.cwd, encoding: 'utf8', env: ws.env })
}

function jsonOf(ws, args) {
  const result = run(ws, args)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

// Builds a populated observer base directory from a declarative spec.
function seedObserver(spec = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-obs-base-'))
  const write = (rel, content) => {
    const full = path.join(base, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
  }
  for (const [name, item] of Object.entries(spec.trends || {})) {
    write(`trends/${name}.json`, JSON.stringify(item))
  }
  for (const [name, item] of Object.entries(spec.research || {})) {
    write(`research/${name}.json`, JSON.stringify(item))
  }
  for (const [name, item] of Object.entries(spec.insights || {})) {
    write(`insights/${name}.json`, JSON.stringify(item))
  }
  for (const [name, text] of Object.entries(spec.essays || {})) {
    write(`essays/published/${name}`, text)
  }
  for (const [name, items] of Object.entries(spec.summaries || {})) {
    write(`summaries/${name}.jsonl`, items.map((i) => JSON.stringify(i)).join('\n') + '\n')
  }
  for (const [key, value] of Object.entries(spec.worldModel || {})) {
    write(`world_model/${key}.json`, JSON.stringify(value))
  }
  return base
}

function isoDate(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() - offsetDays)
  return d.toISOString().slice(0, 10)
}

test('observer status reports zero for every stage when nothing was collected', () => {
  const ws = workspace()
  const base = seedObserver()
  const result = jsonOf(ws, ['observer', 'status', '--json', '--base-dir', base])

  for (const stage of ['observations', 'trends', 'topics', 'research', 'insights', 'world_model', 'essays']) {
    assert.equal(result[stage], 0, `${stage} should be empty`)
  }

  const text = run(ws, ['observer', 'status', '--base-dir', base])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /No pipeline data yet/)
})

test('observer status counts files per pipeline stage', () => {
  const ws = workspace()
  const base = seedObserver({
    trends: { '2026-09-10': { title: 'a' }, '2026-09-12': { title: 'b' } },
    research: { r1: { title: 'r' } },
    insights: { i1: { title: 'i' } },
    essays: { 'e1.md': '# e' },
    worldModel: { entities: [{ name: 'MCP' }] },
  })

  const result = jsonOf(ws, ['observer', 'status', '--json', '--base-dir', base])
  assert.equal(result.trends, 2)
  assert.equal(result.research, 1)
  assert.equal(result.insights, 1)
  assert.equal(result.world_model, 1)
  assert.equal(result.essays, 1)
})

test('observer trends returns the newest report first', () => {
  const ws = workspace()
  const base = seedObserver({
    trends: {
      '2026-09-10': { date: '2026-09-10', title: 'older' },
      '2026-09-12': { date: '2026-09-12', title: 'newer' },
    },
  })

  const items = jsonOf(ws, ['observer', 'trends', '--json', '--base-dir', base])
  assert.equal(items.length, 2)
  assert.deepEqual(
    items.map((i) => i.title),
    ['newer', 'older'],
    'reports are ordered by file name descending, so the newest day comes first'
  )
})

test('observer trends --date returns just that day', () => {
  const ws = workspace()
  const base = seedObserver({
    trends: {
      '2026-09-10': { date: '2026-09-10', title: 'older' },
      '2026-09-12': { date: '2026-09-12', title: 'newer' },
    },
  })

  const items = jsonOf(ws, ['observer', 'trends', '--json', '--date', '2026-09-10', '--base-dir', base])
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'older')

  const missing = jsonOf(ws, ['observer', 'trends', '--json', '--date', '1999-01-01', '--base-dir', base])
  assert.deepEqual(missing, [], 'an unknown date is an empty result, not an error')
})

test('observer research and insights honour --limit', () => {
  const ws = workspace()
  const base = seedObserver({
    research: { r1: { title: 'r1' }, r2: { title: 'r2' }, r3: { title: 'r3' } },
    insights: { i1: { title: 'i1' }, i2: { title: 'i2' } },
  })

  const research = jsonOf(ws, ['observer', 'research', '--json', '--limit', '2', '--base-dir', base])
  assert.equal(research.length, 2)

  const insights = jsonOf(ws, ['observer', 'insights', '--json', '--limit', '1', '--base-dir', base])
  assert.equal(insights.length, 1)
})

test('observer essays reads published markdown', () => {
  const ws = workspace()
  const base = seedObserver({ essays: { 'e1.md': '# Hello essay\n\nbody text' } })

  const items = jsonOf(ws, ['observer', 'essays', '--json', '--base-dir', base])
  assert.equal(items.length, 1)
  assert.equal(items[0].file, 'e1.md')
  assert.equal(items[0].type, 'published')
  assert.match(items[0].content, /# Hello essay/)

  const text = run(ws, ['observer', 'essays', '--base-dir', base])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /e1\.md/)
  assert.match(text.stdout, /# Hello essay/)
})

test('observer dag aggregates daily summaries', () => {
  const ws = workspace()
  const base = seedObserver({
    summaries: {
      [isoDate(0)]: [{ text: 'today one' }, { text: 'today two' }],
      [isoDate(1)]: [{ text: 'yesterday' }],
    },
  })

  const result = jsonOf(ws, ['observer', 'dag', '--json', '--days', '7', '--base-dir', base])
  assert.equal(result.summaryCount, 3)
  assert.equal(result.summaries.length, 2)
  assert.equal(result.summaries[0].date, isoDate(0), 'most recent day first')
  assert.equal(result.summaries[0].summaries.length, 2)

  const text = run(ws, ['observer', 'dag', '--days', '7', '--base-dir', base])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /3 summary\(ies\)/)
})

test('observer world-model returns all four sections, defaulting missing ones', () => {
  const ws = workspace()
  const base = seedObserver({
    worldModel: { entities: [{ name: 'MCP' }], events: [{ name: 'evt' }] },
  })

  const model = jsonOf(ws, ['observer', 'world-model', '--json', '--base-dir', base])
  assert.equal(model.entities.length, 1)
  assert.equal(model.events.length, 1)
  assert.deepEqual(model.trends, [], 'missing sections default to an empty list')
  assert.deepEqual(model.narratives, [])
})

test('observer defaults to <cwd>/.local/observer', () => {
  // Pins the documented default: with no --base-dir the CLI must read the
  // project-local directory the MCP server also uses.
  const ws = workspace()
  const local = path.join(ws.cwd, '.local', 'observer')
  fs.mkdirSync(path.join(local, 'trends'), { recursive: true })
  fs.writeFileSync(
    path.join(local, 'trends', '2026-09-12.json'),
    JSON.stringify({ title: 'from cwd default' }),
    'utf8'
  )

  const items = jsonOf(ws, ['observer', 'trends', '--json'])
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'from cwd default')
})

test('observer validates its subcommands', () => {
  const ws = workspace()

  const none = run(ws, ['observer'])
  assert.equal(none.status, 1)
  assert.match(none.stdout, /Usage:/)

  const unknown = run(ws, ['observer', 'bogus'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown observer subcommand: bogus/)

  // collect/ferment are deliberately not exposed: collect hits the network and
  // ferment drives the engine, both of which belong to the daemon.
  const collect = run(ws, ['observer', 'collect'])
  assert.equal(collect.status, 1)
  assert.match(collect.stderr, /Unknown observer subcommand: collect/)

  const help = run(ws, ['observer', 'help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mio observer status/)
})

test('bad --limit is rejected rather than silently ignored', () => {
  const ws = workspace()
  const base = seedObserver({ research: { r1: { title: 'r1' } } })

  const result = run(ws, ['observer', 'research', '--limit', 'abc', '--base-dir', base])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--limit must be a number/)
})

test('the CLI and the shared observer store agree', () => {
  // Both entry points delegate to server/observer-store.js; this pins that the
  // CLI is not re-implementing the reads.
  const ws = workspace()
  const base = seedObserver({
    trends: { '2026-09-10': { title: 'a' }, '2026-09-12': { title: 'b' } },
    research: { r1: { title: 'r1' } },
  })

  const store = createObserverStore({ baseDir: base })
  const viaCliTrends = jsonOf(ws, ['observer', 'trends', '--json', '--base-dir', base])
  assert.deepEqual(viaCliTrends, store.trends({}))

  const viaCliStatus = jsonOf(ws, ['observer', 'status', '--json', '--base-dir', base])
  assert.deepEqual(viaCliStatus, store.status({}))
})
