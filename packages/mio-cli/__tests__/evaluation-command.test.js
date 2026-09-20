'use strict'

// Tests for `mio agents evaluation` and the shared evaluation store -- the four
// ADR-017 evaluation-period metrics.
//
// Every metric reports its own denominator, so the assertions here care about
// two different things: the arithmetic when samples exist, and that a metric
// with no samples reports `null` rather than a confident 0. The second is the
// one that keeps going wrong in this repo: a 0% that actually means "nothing
// measured" reads as "measured and bad", which is how a metric quietly becomes
// a lie. `null` is the whole point of the sample block.
//
// Data is seeded straight into a throwaway MIO_HOME so each denominator can be
// controlled exactly, and the CLI is run as a child process so the terminal
// path is exercised (not just the store).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
const { createEvaluationStore } = require('../server/evaluation-store.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-eval-' + label + '-'))
}

function run(cwd, env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env })
}

function workspace(label, project) {
  const mioHome = tempDir(label)
  const cwd = tempDir(label + '-cwd')
  const env = { ...process.env, MIO_HOME: mioHome }
  return { mioHome, cwd, env, project: project || path.basename(cwd) }
}

function seed(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

function store(ws) {
  return createEvaluationStore({ dataDir: ws.mioHome, projectName: () => ws.project })
}

// A query entry that returned results. `sources` marks which of those came from
// a verified experience rather than a plain memory.
function query({ agent = 'codex', project, ids, sources, ts = Date.now() }) {
  return {
    agent,
    project,
    query: 'task',
    resultIds: ids,
    resultSources: sources || ids.map(() => 'codex'),
    timestamp: ts,
    expiresAt: ts + 3600000,
  }
}

function reuse({
  experienceId,
  confirmed,
  behaviorChanged,
  outcomeImproved,
  source = 'auto_claim',
  project,
  ts = '2026-09-19T00:00:00.000Z',
}) {
  const record = {
    id: 'r_' + experienceId + '_' + String(behaviorChanged),
    experienceId,
    sourceAgent: 'codex',
    targetAgent: 'opencode',
    reuse: true,
    behaviorChanged,
    outcomeImproved,
    project,
    timestamp: ts,
  }
  if (confirmed !== undefined) record.confirmed = confirmed
  if (source) record.source = source
  return record
}

// ── metric 1: route adoption ────────────────────────────────────────────────

test('route adoption counts a hit only when it came from an experience', () => {
  const ws = workspace('adopt', 'proj-a')
  const s = store(ws)
  // One experience-backed hit (adopted), one memory-only hit (not countable),
  // one query that found nothing.
  seed(path.join(ws.mioHome, 'queries.jsonl'), [
    query({ project: ws.project, ids: ['e1', 'm1'], sources: ['experience', 'codex'] }),
    query({ project: ws.project, ids: ['m2'], sources: ['codex'] }),
    query({ project: ws.project, ids: [], sources: [] }),
  ])
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    reuse({ experienceId: 'e1', confirmed: true, behaviorChanged: true, outcomeImproved: true, project: ws.project }),
  ])

  const result = s.evaluate({ project: ws.project })
  assert.equal(result.routeAdoption.routeHits, 1, 'only the experience-backed hit counts')
  assert.equal(result.routeAdoption.adopted, 1)
  assert.equal(result.routeAdoption.rate, 100)
  assert.equal(result.sample.routeHits, 2, 'sample counts every query with results')
})

test('a route hit nobody reused is not adoption', () => {
  const ws = workspace('adopt-no', 'proj-a')
  const s = store(ws)
  seed(path.join(ws.mioHome, 'queries.jsonl'), [
    query({ project: ws.project, ids: ['e1'], sources: ['experience'] }),
  ])
  // No reuse record at all -> the route was offered but never adopted.
  const result = s.evaluate({ project: ws.project })
  assert.equal(result.routeAdoption.routeHits, 1)
  assert.equal(result.routeAdoption.adopted, 0)
  assert.equal(result.routeAdoption.rate, 0, 'zero adoption here is real: there WAS a hit')
})

test('route adoption is null, not zero, when no route ever hit', () => {
  const ws = workspace('adopt-empty', 'proj-a')
  const s = store(ws)
  seed(path.join(ws.mioHome, 'queries.jsonl'), [
    query({ project: ws.project, ids: ['m1'], sources: ['codex'] }),
  ])
  const result = s.evaluate({ project: ws.project })
  assert.equal(result.routeAdoption.rate, null)
})

// ── metric 2: behaviour change ──────────────────────────────────────────────

test('behaviour change counts only confirmed records', () => {
  const ws = workspace('behav', 'proj-a')
  const s = store(ws)
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    reuse({ experienceId: 'e1', confirmed: true, behaviorChanged: true, outcomeImproved: true, project: ws.project }),
    reuse({ experienceId: 'e2', confirmed: true, behaviorChanged: true, outcomeImproved: false, project: ws.project }),
    reuse({ experienceId: 'e3', behaviorChanged: true, outcomeImproved: true, project: ws.project }),
    reuse({ experienceId: 'e4', confirmed: true, behaviorChanged: false, outcomeImproved: true, project: ws.project }),
  ])
  const result = s.evaluate({ project: ws.project })
  assert.equal(result.behaviorChange.confirmed, 2, 'unconfirmed e3 must not count')
  assert.equal(result.behaviorChange.total, 4)
  assert.equal(result.behaviorChange.rate, 50)
  // e1 and e2 are both confirmed + behaviorChanged, so both are verified:
  // `verified` adds outcomeImproved on top, it does not replace behaviorChanged.
  assert.equal(result.behaviorChange.verified, 2)
})

// The string-'true' form is what a JSON round-trip of a naive writer produces,
// and experience-store.js already tolerates it in REUSE_STATUS_FILTERS. The
// metric must agree with the store rather than invent a stricter boolean check.
test('behaviour change accepts the string-true form the store accepts', () => {
  const ws = workspace('behav-str', 'proj-a')
  const s = store(ws)
  const record = reuse({ experienceId: 'e1', confirmed: true, behaviorChanged: true, outcomeImproved: true, project: ws.project })
  record.behaviorChanged = 'true'
  record.outcomeImproved = 'true'
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [record])
  const result = s.evaluate({ project: ws.project })
  assert.equal(result.behaviorChange.confirmed, 1)
  assert.equal(result.behaviorChange.verified, 1)
})

// ── metric 3: recall quality ────────────────────────────────────────────────

test('recall quality separates empty queries from useless ones', () => {
  const ws = workspace('recall', 'proj-a')
  const s = store(ws)
  seed(path.join(ws.mioHome, 'queries.jsonl'), [
    // returned a result that was later reused -> yielded
    query({ project: ws.project, ids: ['e1'], sources: ['experience'] }),
    // returned results, nothing reused -> useless exploration
    query({ project: ws.project, ids: ['m1'], sources: ['codex'] }),
    // returned nothing at all -> empty
    query({ project: ws.project, ids: [], sources: [] }),
    query({ project: ws.project, ids: [], sources: [] }),
  ])
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    reuse({ experienceId: 'e1', confirmed: true, behaviorChanged: true, outcomeImproved: true, project: ws.project }),
  ])
  const result = s.evaluate({ project: ws.project })
  assert.equal(result.recallQuality.queriesWithResults, 2)
  assert.equal(result.recallQuality.queriesLinkedToReuse, 1)
  assert.equal(result.recallQuality.yield, 50)
  assert.equal(result.recallQuality.emptyQueries, 2)
  assert.equal(result.recallQuality.emptyQueryRate, 50)
})

// ── metric 4: data hygiene ──────────────────────────────────────────────────

test('data hygiene measures the unconfirmed auto-claim share', () => {
  const ws = workspace('hygiene', 'proj-a')
  const s = store(ws)
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    // unconfirmed auto-claim -> noise
    reuse({ experienceId: 'e1', behaviorChanged: false, outcomeImproved: true, project: ws.project }),
    reuse({ experienceId: 'e2', behaviorChanged: false, outcomeImproved: true, project: ws.project }),
    // confirmed and agent-reported -> not noise
    reuse({ experienceId: 'e3', confirmed: true, behaviorChanged: true, outcomeImproved: true, source: 'agent_report', project: ws.project }),
    reuse({ experienceId: 'e4', confirmed: true, behaviorChanged: true, outcomeImproved: true, source: 'agent_report', project: ws.project }),
  ])
  const result = s.evaluate({ project: ws.project })
  assert.equal(result.dataHygiene.pendingAutoClaims, 2)
  assert.equal(result.dataHygiene.total, 4)
  assert.equal(result.dataHygiene.pendingRatio, 50)
})

test('a confirmed auto-claim is no longer pending noise', () => {
  const ws = workspace('hygiene-ok', 'proj-a')
  const s = store(ws)
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    reuse({ experienceId: 'e1', confirmed: true, behaviorChanged: true, outcomeImproved: true, project: ws.project }),
  ])
  const result = s.evaluate({ project: ws.project })
  assert.equal(result.dataHygiene.pendingAutoClaims, 0)
  assert.equal(result.dataHygiene.pendingRatio, 0)
})

// ── project scoping and --since ─────────────────────────────────────────────

test('project filter excludes another project\'s records', () => {
  const ws = workspace('scope', 'proj-a')
  // projectName() returns null here, so `evaluate({})` has no project to fall
  // back to and must count everything. That is how "all projects" is expressed
  // at this layer; the CLI passes an explicit --project when it wants a slice.
  const s = createEvaluationStore({ dataDir: ws.mioHome, projectName: () => null })
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    reuse({ experienceId: 'e1', confirmed: true, behaviorChanged: true, outcomeImproved: true, project: 'proj-a' }),
    reuse({ experienceId: 'e2', confirmed: true, behaviorChanged: true, outcomeImproved: true, project: 'proj-b' }),
    reuse({ experienceId: 'e3', confirmed: true, behaviorChanged: true, outcomeImproved: true, project: 'proj-b' }),
  ])
  const scoped = s.evaluate({ project: 'proj-a' })
  assert.equal(scoped.behaviorChange.total, 1)
  const all = s.evaluate({})
  assert.equal(all.behaviorChange.total, 3)
})

test('--since drops records older than the window', () => {
  const ws = workspace('since', 'proj-a')
  const s = store(ws)
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    reuse({ experienceId: 'old', confirmed: true, behaviorChanged: true, outcomeImproved: true, project: ws.project, ts: '2026-08-01T00:00:00.000Z' }),
    reuse({ experienceId: 'new', confirmed: true, behaviorChanged: true, outcomeImproved: true, project: ws.project, ts: '2026-09-19T00:00:00.000Z' }),
  ])
  const result = s.evaluate({ project: ws.project, since: '2026-09-01T00:00:00.000Z' })
  assert.equal(result.behaviorChange.total, 1)
  assert.equal(result.since, '2026-09-01T00:00:00.000Z')
})

// ── the CLI surface ────────────────────────────────────────────────────────

test('mio agents evaluation prints all four metrics', () => {
  const ws = workspace('cli', 'proj-a')
  seed(path.join(ws.mioHome, 'queries.jsonl'), [
    query({ project: ws.project, ids: ['e1'], sources: ['experience'] }),
    query({ project: ws.project, ids: [], sources: [] }),
  ])
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    reuse({ experienceId: 'e1', confirmed: true, behaviorChanged: true, outcomeImproved: true, project: ws.project }),
    reuse({ experienceId: 'e2', behaviorChanged: false, outcomeImproved: true, project: ws.project }),
  ])
  // --project is required here: the CLI defaults to the cwd's basename, which
  // is deliberately not the project the fixture seeded.
  const r = run(ws.cwd, ws.env, ['agents', 'evaluation', '--project', ws.project])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /1\. route adoption rate/)
  assert.match(r.stdout, /2\. behaviour change rate/)
  assert.match(r.stdout, /3\. recall quality/)
  assert.match(r.stdout, /4\. data hygiene/)
  assert.match(r.stdout, /adoption: 100% \(1\/1/)
  assert.match(r.stdout, /pending: 50% \(1\/2/)
})

// A metric with no samples must not print "0%": that reads as a measured
// failure. This is the assertion that catches the undefined%/0% regression.
test('mio agents evaluation says "no data" instead of a fake 0%', () => {
  const ws = workspace('cli-empty', 'proj-a')
  const r = run(ws.cwd, ws.env, ['agents', 'evaluation'])
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /undefined/, 'must never print undefined%')
  assert.match(r.stdout, /adoption: no data/)
  assert.match(r.stdout, /changed: no data/)
  assert.match(r.stdout, /yield: no data/)
  assert.match(r.stdout, /pending: no data/)
})

test('mio --json agents evaluation emits null rates when there is no sample', () => {
  const ws = workspace('cli-json', 'proj-a')
  const r = run(ws.cwd, ws.env, ['--json', 'agents', 'evaluation'])
  assert.equal(r.status, 0, r.stderr)
  const parsed = JSON.parse(r.stdout)
  assert.equal(parsed.routeAdoption.rate, null)
  assert.equal(parsed.behaviorChange.rate, null)
  assert.equal(parsed.recallQuality.yield, null)
  assert.equal(parsed.dataHygiene.pendingRatio, null)
  assert.equal(parsed.sample.reuses, 0)
})
