'use strict'

// Tests for `mio phase0 report` and its delegation to the shared phase0 module.
// Data is seeded directly into a throwaway MIO_HOME; loadPhase0 reads
// memory.jsonl + traces.jsonl + experience_reuse.jsonl, which all exist for real
// (860/920/56 rows in production), so the report has meaningful evidence volume.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-ph0-' + label + '-'))
}

function run(cwd, env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env })
}

function workspace(label) {
  const mioHome = tempDir(label)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-ph0-cwd-'))
  const env = { ...process.env, MIO_HOME: mioHome }
  return { mioHome, cwd, env, project: 'proj-x' }
}

function seed(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

function seedPhase0(ws, project = ws.project) {
  seed(path.join(ws.mioHome, 'memory.jsonl'), [
    { id: 'mem_1', kind: 'decision', content: 'decision one', project },
    { id: 'mem_2', kind: 'note', content: 'note two', project },
    { id: 'mem_3', kind: 'context', content: 'context three', project },
  ])
  seed(path.join(ws.mioHome, 'traces.jsonl'), [
    { event_type: 'task_outcome', outcome: 'success', project, agent: 'codex' },
    { event_type: 'task_outcome', outcome: 'failure', project, agent: 'codex' },
    { event_type: 'task_outcome', outcome: 'success', project, agent: 'claude' },
    { event_type: 'tool_call', outcome: null, project, agent: 'codex' },
  ])
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    { id: 'x1', experienceId: 'mem_1', sourceAgent: 'codex', targetAgent: 'claude', project, confirmed: true, reuse: true, behaviorChanged: true, outcomeImproved: true },
    { id: 'x2', experienceId: 'mem_2', sourceAgent: 'claude', targetAgent: 'codex', project, confirmed: false, reuse: true, behaviorChanged: false, outcomeImproved: false },
  ])
}

function reportJson(ws, extra = []) {
  const result = run(ws.cwd, ws.env, ['phase0', 'report', '--json', '--project', ws.project, ...extra])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('phase0 report aggregates the seeded evidence volume', () => {
  const ws = workspace('volume')
  seedPhase0(ws)

  const result = reportJson(ws)
  assert.equal(typeof result.status, 'string')
  const m = result.metrics
  assert.equal(m.memoryRecords, 3)
  assert.equal(m.traceEvents, 4)
  assert.equal(m.taskOutcomes, 3)
  assert.equal(m.experienceReuseRecords, 2)

  const text = run(ws.cwd, ws.env, ['phase0', 'report', '--project', ws.project])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /Phase 0 Validation Report/)
  assert.match(text.stdout, /Evidence Volume/)
  assert.match(text.stdout, /Memory records: 3/)
  assert.match(text.stdout, /Task outcomes: 3/)
})

test('phase0 report --project scopes to one project', () => {
  const ws = workspace('scope')
  seedPhase0(ws)
  // Add a record in a different project; it must not be counted under proj-x.
  const memFile = path.join(ws.mioHome, 'memory.jsonl')
  const extra = JSON.parse('[' + fs.readFileSync(memFile, 'utf8').trim().split('\n').join(',') + ']')
  extra.push({ id: 'mem_other', kind: 'note', content: 'other', project: 'proj-y' })
  fs.writeFileSync(memFile, extra.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const scoped = reportJson(ws)
  assert.equal(scoped.metrics.memoryRecords, 3, 'proj-y memory excluded')

  const other = run(ws.cwd, ws.env, ['phase0', 'report', '--json', '--project', 'proj-y'])
  assert.equal(other.status, 0, other.stderr)
  const otherJson = JSON.parse(other.stdout)
  assert.equal(otherJson.metrics.memoryRecords, 1, 'only the proj-y record')
})

test('phase0 report handles empty evidence gracefully', () => {
  const ws = workspace('empty')
  // No files seeded -> all-zero volume, still a valid report.
  const result = run(ws.cwd, ws.env, ['phase0', 'report', '--json', '--project', ws.project])
  assert.equal(result.status, 0, result.stderr)
  const json = JSON.parse(result.stdout)
  assert.equal(json.metrics.memoryRecords, 0)
  assert.equal(json.metrics.traceEvents, 0)
  assert.equal(typeof json.status, 'string')
})

test('phase0 subcommand validates its arguments', () => {
  const ws = workspace('usage')
  seedPhase0(ws)

  const none = run(ws.cwd, ws.env, ['phase0'])
  assert.equal(none.status, 1)
  assert.match(none.stdout, /Usage:/)

  const unknown = run(ws.cwd, ws.env, ['phase0', 'bogus'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown phase0 subcommand: bogus/)
  // Naming the bad subcommand is not enough: with no usage block there is
  // nothing left to find the right one in. It goes to stderr, so stdout stays
  // empty and a `--json` caller never receives usage text where it expects JSON.
  assert.match(unknown.stderr, /Usage:/)
  assert.match(unknown.stderr, /mio phase0 report/)
  assert.equal(unknown.stdout, '')

  const help = run(ws.cwd, ws.env, ['phase0', 'help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mio phase0 report/)
})

test('the CLI and the shared phase0 module agree', () => {
  // The CLI delegates to loadPhase0 directly, so a direct call and the CLI must
  // produce the identical report shape and metrics.
  const { loadPhase0 } = require('../server/mio-intelligence-mcp/phase0.js')
  const ws = workspace('store')
  seedPhase0(ws)

  const direct = loadPhase0(ws.mioHome, ws.project)
  const viaCli = reportJson(ws)
  assert.equal(viaCli.status, direct.status)
  assert.deepEqual(viaCli.metrics, direct.metrics)
  assert.deepEqual(viaCli.criteria, direct.criteria)
})
