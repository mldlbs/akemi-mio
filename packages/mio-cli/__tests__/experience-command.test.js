'use strict'

// Tests for the `mio experience` subcommand group (list / confirm / reuse).
//
// The motivating bug: the observer auto-claims experience reuse, but an
// unconfirmed auto_claim never satisfies the `verified` filter, so it never
// feeds memory ranking or task routing. A real MIO_HOME had 56 claims with 48
// sitting unconfirmed — confirming was only possible through the MCP server.
// These tests exercise the terminal path, including bulk confirmation.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-expcmd-' + label + '-'))
}

function workspace(label) {
  const mioHome = tempDir(label)
  const env = { ...process.env, MIO_HOME: mioHome }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-expcmd-cwd-'))
  return { mioHome, env, cwd, project: path.basename(cwd) }
}

function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ws.cwd, encoding: 'utf8', env: ws.env })
}

// Mirrors the shape the observer writes for an auto-claimed reuse.
function autoClaim(id, overrides = {}) {
  return {
    id,
    timestamp: '2026-09-10T10:00:00.000Z',
    source: 'auto_claim',
    sourceAgent: 'workbuddy',
    targetAgent: 'opencode',
    experienceId: `mem_${id}`,
    reuse: true,
    behaviorChanged: false,
    outcomeImproved: false,
    project: 'demo',
    traceId: `trace_${id}`,
    ...overrides,
  }
}

function writeReuse(ws, records) {
  const file = path.join(ws.mioHome, 'experience_reuse.jsonl')
  fs.writeFileSync(
    file,
    records.length > 0 ? records.map((record) => JSON.stringify(record)).join('\n') + '\n' : '',
    'utf8'
  )
}

function listJson(ws, extra = []) {
  const result = run(ws, ['experience', 'list', '--json', ...extra])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('experience list shows pending auto-claims and flags them as unverified', () => {
  const ws = workspace('list')
  writeReuse(ws, [autoClaim('c1'), autoClaim('c2')])

  const report = listJson(ws, ['--project', 'demo'])
  assert.equal(report.total, 2)
  assert.equal(report.status, 'all')
  assert.equal(report.records.every((record) => record.confirmed === false), true)

  const text = run(ws, ['experience', 'list', '--project', 'demo'])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /\[pending\]/)
  assert.match(text.stdout, /never count as verified/)
  // The suggested command must only contain confirmable (auto_claim) ids.
  assert.match(text.stdout, /Confirm with: mio experience confirm --ids c1,c2/)
})

test('experience list filters by status', () => {
  const ws = workspace('status')
  writeReuse(ws, [
    autoClaim('c1'),
    autoClaim('c2', { confirmed: true, behaviorChanged: true, outcomeImproved: true }),
  ])

  assert.equal(listJson(ws, ['--project', 'demo', '--status', 'pending']).total, 1)
  assert.equal(listJson(ws, ['--project', 'demo', '--status', 'confirmed']).total, 1)
  // verified requires reuse + behaviorChanged + outcomeImproved, so c1 is not.
  assert.equal(listJson(ws, ['--project', 'demo', '--status', 'verified']).total, 1)
  assert.equal(listJson(ws, ['--project', 'demo', '--status', 'auto_claim']).total, 2)
})

test('experience confirm bulk-upgrades pending claims to verified', () => {
  const ws = workspace('bulk')
  writeReuse(ws, [autoClaim('c1'), autoClaim('c2'), autoClaim('c3')])

  const result = run(ws, [
    'experience', 'confirm', '--ids', 'c1,c2', '--project', 'demo', '--outcome-improved',
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Confirmed 2 reuse record/)
  assert.match(result.stdout, /confirmed: c1, c2/)

  // behaviorChanged is forced true by confirm; outcomeImproved came from the flag.
  const verified = listJson(ws, ['--project', 'demo', '--status', 'verified'])
  assert.equal(verified.total, 2)
  for (const record of verified.records) {
    assert.equal(record.behaviorChanged, true)
    assert.equal(record.outcomeImproved, true)
    assert.equal(record.confirmed, true)
    assert.equal(record.confirmedBy, 'cli')
  }
  assert.equal(listJson(ws, ['--project', 'demo', '--status', 'pending']).total, 1)
})

test('experience confirm reports rejected and unknown ids without aborting the batch', () => {
  const ws = workspace('partial')
  writeReuse(ws, [
    autoClaim('c1'),
    {
      ...autoClaim('manual1'),
      source: 'agent_report',
      behaviorChanged: true,
      outcomeImproved: true,
    },
  ])

  const result = run(ws, ['experience', 'confirm', '--ids', 'c1,manual1,nope', '--project', 'demo'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /confirmed: c1/)
  assert.match(result.stdout, /skipped \(not auto_claim\): manual1/)
  assert.match(result.stdout, /not found: nope/)
})

test('experience confirm is idempotent unless --force is given', () => {
  const ws = workspace('idem')
  writeReuse(ws, [autoClaim('c1')])

  assert.equal(run(ws, ['experience', 'confirm', '--ids', 'c1', '--project', 'demo']).status, 0)

  const again = run(ws, ['experience', 'confirm', '--ids', 'c1', '--project', 'demo'])
  assert.equal(again.status, 1)
  assert.match(again.stdout, /already confirmed: c1/)
  assert.match(again.stdout, /use --force to redo/)

  const forced = run(ws, ['experience', 'confirm', '--ids', 'c1', '--project', 'demo', '--force'])
  assert.equal(forced.status, 0, forced.stderr)
  assert.match(forced.stdout, /Confirmed 1 reuse record/)
})

test('experience confirm can reject a claim with --no-improved', () => {
  const ws = workspace('reject')
  writeReuse(ws, [autoClaim('c1')])

  const result = run(ws, [
    'experience', 'confirm', '--ids', 'c1', '--project', 'demo', '--no-improved',
  ])
  assert.equal(result.status, 0, result.stderr)
  const record = listJson(ws, ['--project', 'demo']).records[0]
  assert.equal(record.confirmed, true)
  assert.equal(record.outcomeImproved, false, 'explicit rejection is preserved')
  // Not verified: outcomeImproved is required by the verified filter.
  assert.equal(listJson(ws, ['--project', 'demo', '--status', 'verified']).total, 0)
})

test('experience confirm exits non-zero when nothing was confirmed', () => {
  const ws = workspace('nothing')
  writeReuse(ws, [autoClaim('c1')])

  const missing = run(ws, ['experience', 'confirm', '--ids', 'nope', '--project', 'demo'])
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /not found: nope/)
  assert.match(missing.stderr, /Nothing confirmed/)

  const noIds = run(ws, ['experience', 'confirm'])
  assert.equal(noIds.status, 1)
  assert.match(noIds.stderr, /requires --ids/)
})

test('experience reuse records a manual agent_report', () => {
  const ws = workspace('reuse')
  const result = run(ws, [
    'experience', 'reuse',
    '--source-agent', 'workbuddy',
    '--target-agent', 'codex',
    '--experience-id', 'mem_42',
    '--reuse', '--behavior-changed', '--outcome-improved',
    '--project', 'demo',
    '--notes', 'hand-verified',
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Recorded reuse xfer_/)
  assert.match(result.stdout, /workbuddy -> codex \(mem_42\)/)

  const report = listJson(ws, ['--project', 'demo'])
  assert.equal(report.total, 1)
  const record = report.records[0]
  assert.equal(record.source, 'agent_report')
  assert.equal(record.sourceAgent, 'workbuddy')
  assert.equal(record.targetAgent, 'codex')
  assert.equal(record.experienceId, 'mem_42')
  assert.equal(record.reuse, true)
  assert.equal(record.behaviorChanged, true)
  assert.equal(record.outcomeImproved, true)
  assert.equal(record.notes, 'hand-verified')
  assert.equal(listJson(ws, ['--project', 'demo', '--status', 'agent_report']).total, 1)
})

test('experience reuse requires all three identifying arguments', () => {
  const ws = workspace('reuse-args')

  const missingExperience = run(ws, [
    'experience', 'reuse', '--source-agent', 'a', '--target-agent', 'b', '--project', 'demo',
  ])
  assert.equal(missingExperience.status, 1)
  assert.match(missingExperience.stderr, /requires experienceId/)

  const missingTarget = run(ws, [
    'experience', 'reuse', '--source-agent', 'a', '--experience-id', 'm1', '--project', 'demo',
  ])
  assert.equal(missingTarget.status, 1)
  assert.match(missingTarget.stderr, /requires targetAgent/)
})

test('experience respects project isolation', () => {
  const ws = workspace('isolation')
  writeReuse(ws, [autoClaim('c1', { project: 'proj-a' }), autoClaim('c2', { project: 'proj-b' })])

  assert.equal(listJson(ws, ['--project', 'proj-a']).total, 1)
  assert.equal(listJson(ws, ['--project', 'proj-b']).total, 1)

  // Listing is project-scoped, but confirm is not: ids are globally unique
  // (xfer_<timestamp>_<hex>) so --project only selects the phase0 summary,
  // never which record gets confirmed. This matches the MCP tool's behavior.
  const cross = run(ws, ['experience', 'confirm', '--ids', 'c1', '--project', 'proj-b'])
  assert.equal(cross.status, 0, cross.stderr)
  assert.equal(listJson(ws, ['--project', 'proj-a', '--status', 'pending']).total, 0)
  assert.equal(listJson(ws, ['--project', 'proj-a', '--status', 'confirmed']).total, 1)
  assert.equal(listJson(ws, ['--project', 'proj-b', '--status', 'pending']).total, 1)
})

test('experience subcommand validates its arguments', () => {
  const ws = workspace('usage')

  const none = run(ws, ['experience'])
  assert.equal(none.status, 1)
  assert.match(none.stdout, /Usage:/)

  const unknown = run(ws, ['experience', 'bogus'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown experience subcommand: bogus/)
  // Usage must go to stderr too, leaving stdout empty for `--json` callers.
  assert.match(unknown.stderr, /Usage:/)
  assert.equal(unknown.stdout, '')

  const help = run(ws, ['experience', 'help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mio experience list/)
})
