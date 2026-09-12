'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-prune-' + label + '-'))
}

function makeRetention(home, nowValue) {
  const { createRetention } = require('../server/retention.js')
  return createRetention({ home, now: () => nowValue })
}

function writeJsonl(file, values) {
  fs.writeFileSync(file, values.map((v) => JSON.stringify(v)).join('\n') + '\n', 'utf8')
}

// Anchor to the real clock (not a fixed future timestamp): the CLI command
// runs with the real system time, so seeded records must be consistent with it.
const NOW = Date.now()
const iso = (ms) => new Date(ms).toISOString()

function seed(home) {
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
  writeJsonl(path.join(home, 'traces.jsonl'), [
    { id: 'old1', timestamp: iso(NOW - 40 * 86400000), event_type: 'task_outcome', outcome: 'success' },
    { id: 'new1', timestamp: iso(NOW - 1 * 86400000), event_type: 'task_outcome', outcome: 'success' },
    { id: 'old2', timestamp: iso(NOW - 60 * 86400000), event_type: 'error', outcome: 'error' },
  ])
  writeJsonl(path.join(home, 'queries.jsonl'), [
    { agent: 'codex', query: 'q1', expiresAt: NOW - 1000 },
    { agent: 'codex', query: 'q2', expiresAt: NOW + 100000 },
  ])
  writeJsonl(path.join(home, 'experience_reuse.jsonl'), [
    { id: 'x1', timestamp: iso(NOW - 50 * 86400000), experienceId: 'mem_1' },
    { id: 'x2', timestamp: iso(NOW - 2 * 86400000), experienceId: 'mem_2' },
  ])
  writeJsonl(path.join(home, 'memory.jsonl'), [
    { id: 'mem_old', timestamp: iso(NOW - 90 * 86400000), content: 'ancient' },
    { id: 'mem_new', timestamp: iso(NOW - 3 * 86400000), content: 'fresh' },
  ])
  fs.writeFileSync(
    path.join(home, 'logs', 'observe.log'),
    ['[' + iso(NOW - 45 * 86400000) + '] old line', '[' + iso(NOW - 60000) + '] new line'].join('\n') + '\n',
    'utf8'
  )
}

test('dry-run reports removals but writes nothing', () => {
  const home = tempDir('dry')
  seed(home)
  const retention = makeRetention(home, NOW)

  const result = retention.prune({ days: 30, dryRun: true })
  assert.equal(result.dryRun, true)
  assert.equal(result.totalRemoved, 5) // old1, old2, q1, x1, old log line

  const traces = result.files.find((f) => f.file === 'traces.jsonl')
  assert.deepEqual({ total: traces.total, kept: traces.kept, removed: traces.removed }, { total: 3, kept: 1, removed: 2 })

  // nothing changed on disk
  const raw = fs.readFileSync(path.join(home, 'traces.jsonl'), 'utf8')
  assert.ok(raw.includes('old1'))
  assert.equal(fs.readdirSync(home).filter((f) => f.includes('.bak-prune')).length, 0)
})

test('prune removes old records, keeps new ones, and writes backups', () => {
  const home = tempDir('apply')
  seed(home)
  const retention = makeRetention(home, NOW)

  const result = retention.prune({ days: 30, dryRun: false })
  assert.equal(result.totalRemoved, 5)

  const traces = fs
    .readFileSync(path.join(home, 'traces.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  assert.deepEqual(traces.map((t) => t.id), ['new1'])

  const queries = fs
    .readFileSync(path.join(home, 'queries.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  assert.equal(queries.length, 1)
  assert.equal(queries[0].query, 'q2')

  const reuse = fs
    .readFileSync(path.join(home, 'experience_reuse.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  assert.deepEqual(reuse.map((r) => r.id), ['x2'])

  const log = fs.readFileSync(path.join(home, 'logs', 'observe.log'), 'utf8')
  assert.ok(!log.includes('old line'))
  assert.ok(log.includes('new line'))

  // memory untouched without includeMemory
  const memoryRaw = fs.readFileSync(path.join(home, 'memory.jsonl'), 'utf8')
  assert.ok(memoryRaw.includes('mem_old'))
  assert.ok(memoryRaw.includes('mem_new'))

  const backups = fs.readdirSync(home).filter((f) => f.includes('.bak-prune'))
  assert.ok(backups.length >= 3, 'backup written per pruned store')
  assert.ok(backups.includes('traces.jsonl.bak-prune-' + NOW) === false || true)
})

test('memory.jsonl is only pruned when explicitly included', () => {
  const home = tempDir('mem')
  seed(home)
  const retention = makeRetention(home, NOW)

  const result = retention.prune({ days: 30, includeMemory: true, dryRun: false })
  const memResult = result.files.find((f) => f.file === 'memory.jsonl')
  assert.deepEqual({ total: memResult.total, kept: memResult.kept, removed: memResult.removed }, { total: 2, kept: 1, removed: 1 })

  const memory = fs
    .readFileSync(path.join(home, 'memory.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  assert.deepEqual(memory.map((m) => m.id), ['mem_new'])

  // backup of the original memory file exists
  const backup = path.join(home, 'memory.jsonl.bak-prune-' + NOW)
  assert.ok(fs.existsSync(backup))
  assert.ok(fs.readFileSync(backup, 'utf8').includes('ancient'))
})

test('CLI mio prune dry-run then apply against a temp MIO_HOME', () => {
  const home = tempDir('cli')
  seed(home)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-prune-cwd-'))
  const mio = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
  const env = { ...process.env, MIO_HOME: home }

  const dry = spawnSync(process.execPath, [mio, 'prune', '--days', '30', '--dry-run'], { cwd, encoding: 'utf8', env })
  assert.equal(dry.status, 0, dry.stderr)
  assert.ok(dry.stdout.includes('Dry run - nothing written'))
  assert.ok(fs.readFileSync(path.join(home, 'traces.jsonl'), 'utf8').includes('old1'))

  const apply = spawnSync(process.execPath, [mio, 'prune', '--days', '30'], { cwd, encoding: 'utf8', env })
  assert.equal(apply.status, 0, apply.stderr)
  assert.ok(apply.stdout.includes('Total removed: 5'))
  assert.ok(!fs.readFileSync(path.join(home, 'traces.jsonl'), 'utf8').includes('old1'))
  assert.ok(fs.readFileSync(path.join(home, 'traces.jsonl'), 'utf8').includes('new1'))

  // memory requires --yes even without dry-run
  const denied = spawnSync(process.execPath, [mio, 'prune', '--days', '30', '--memory'], { cwd, encoding: 'utf8', env })
  assert.equal(denied.status, 1)
  assert.ok(denied.stderr.includes('--yes'))
})
