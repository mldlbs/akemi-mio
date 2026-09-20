'use strict'

// Tests for the pending-auto-claim line in `mio status`.
//
// Why this line exists: ADR-017 treats an unconfirmed auto-claim as "invisible
// dead weight" -- it never feeds memory ranking or task routing, and the
// behaviour-change metric stays pinned at 0% until it is confirmed. The count
// was reachable only through `mio digest` (and only at >= 10) or
// `mio experience list --status pending`, neither of which anyone runs as a
// habit. Real data showed the backlog had grown to 20 records with zero
// confirmations ever performed, so the signal belongs on the command people do
// run routinely.
//
// Two things are asserted and both matter:
//   1. the count appears on status, and
//   2. it is GLOBAL -- the backlog spans projects, so a project-scoped count
//      would under-report it. `listReuse` defaults its filter to `projectName()`
//      (the cwd's git repo), so passing that default through would silently
//      show only the current project's share. The seed below uses a project
//      name that can never match the cwd, which is what makes the second
//      assertion able to fail if the scoping regresses.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-status-' + label + '-'))
}

function workspace(label) {
  const mioHome = tempDir(label)
  // A cwd whose basename is deliberately unlike the seeded project name, so a
  // project-scoped count would come out 0 and the test would catch it.
  const cwd = tempDir(label + '-cwd')
  const env = { ...process.env, MIO_HOME: mioHome }
  return { mioHome, cwd, env }
}

function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ws.cwd,
    encoding: 'utf8',
    env: ws.env,
  })
}

function jsonOf(ws, args) {
  const result = run(ws, args)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

// An unconfirmed auto-claim, shaped like the ones task-store.js produces.
function autoClaim(id, project) {
  return {
    id,
    timestamp: new Date().toISOString(),
    sourceAgent: 'codex',
    targetAgent: 'codex',
    experienceId: 'mem_' + id,
    project,
    reuse: true,
    behaviorChanged: false,
    outcomeImproved: true,
    source: 'auto_claim',
    traceId: 'codex:' + id,
  }
}

function seedReuse(ws, records) {
  fs.mkdirSync(ws.mioHome, { recursive: true })
  fs.writeFileSync(
    path.join(ws.mioHome, 'experience_reuse.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  )
}

test('status reports pending auto-claims globally, not scoped to the cwd project', () => {
  const ws = workspace('global')
  // Two projects, neither matching the cwd basename.
  seedReuse(ws, [
    autoClaim('a1', 'project-alpha'),
    autoClaim('a2', 'project-alpha'),
    autoClaim('b1', 'project-beta'),
  ])

  const payload = jsonOf(ws, ['status', '--json'])
  assert.equal(
    payload.pendingAutoClaims,
    3,
    'pending count must span all projects, not just the cwd project'
  )
})

test('status prints the pending count with the confirm commands', () => {
  const ws = workspace('text')
  seedReuse(ws, [autoClaim('a1', 'project-alpha'), autoClaim('a2', 'project-alpha')])

  const result = run(ws, ['status'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Pending auto-claims: 2/)
  // The line is only useful if it says what to do next.
  assert.match(result.stdout, /experience confirm/)
})

test('status stays quiet when there is nothing pending', () => {
  const ws = workspace('clean')
  // A confirmed record and an explicitly reported one: neither is pending, so
  // the line must be absent rather than showing "0".
  seedReuse(ws, [
    { ...autoClaim('c1', 'project-alpha'), confirmed: true, behaviorChanged: true },
    { ...autoClaim('d1', 'project-alpha'), source: 'agent_report' },
  ])

  const payload = jsonOf(ws, ['status', '--json'])
  assert.equal(payload.pendingAutoClaims, 0)

  const result = run(ws, ['status'])
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /Pending auto-claims/)
})

test('status reports 0 pending when no reuse file exists yet', () => {
  const ws = workspace('empty')
  // No seeding at all -- a fresh MIO_HOME. The line must not crash the command.
  const payload = jsonOf(ws, ['status', '--json'])
  assert.equal(payload.pendingAutoClaims, 0)
})
