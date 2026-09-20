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

// ── the cross-agent breakdown ───────────────────────────────────────────────
//
// The raw pending count is not the actionable number. ADR-017's confirmation
// rule is "仅跨 Agent 且真实改变行为才 confirm；同 Agent / 弱关联 / 自报一律
// 不确认，避免数据污染", so a same-agent auto-claim can never be confirmed.
// Reporting only the total invites "confirm them all", which is the exact
// pollution the ADR forbids -- and it would fake behavior-change rate, the
// metric the confirmation would be cited as improving. The breakdown makes the
// eligible subset visible so a reviewer is not steered into bulk-confirming.

test('status separates cross-agent claims from same-agent ones', () => {
  const ws = workspace('cross')
  // ⚠️ The two counts MUST differ (3 vs 2 here). If they happened to be equal a
  // predicate swap (cross <-> same) would still satisfy the assertion, and the
  // mutation check showed exactly that: an inverted filter passed this test
  // when the fixture held an even 2/2 split. Uneven counts make the test able
  // to fail.
  seedReuse(ws, [
    { ...autoClaim('x1', 'project-alpha'), sourceAgent: 'opencode', targetAgent: 'codex' },
    { ...autoClaim('x2', 'project-alpha'), sourceAgent: 'codex-observer', targetAgent: 'codex' },
    { ...autoClaim('x3', 'project-alpha'), sourceAgent: 'mcp', targetAgent: 'codex' },
    // Same-agent: never eligible, must not inflate the cross-agent figure.
    autoClaim('s1', 'project-alpha'),
    autoClaim('s2', 'project-alpha'),
  ])

  const payload = jsonOf(ws, ['status', '--json'])
  assert.equal(payload.pendingAutoClaims, 5, 'total still counts every pending claim')
  assert.equal(payload.pendingCrossAgent, 3, 'only sourceAgent != targetAgent counts as cross-agent')
})

test('the cross-agent count ignores case differences in agent names', () => {
  const ws = workspace('cross-case')
  seedReuse(ws, [
    { ...autoClaim('c1', 'project-alpha'), sourceAgent: 'OpenCode', targetAgent: 'CODEX' },
    { ...autoClaim('c2', 'project-alpha'), sourceAgent: 'codex', targetAgent: 'CODEX' },
  ])

  const payload = jsonOf(ws, ['status', '--json'])
  assert.equal(payload.pendingCrossAgent, 1, 'agent names compare case-insensitively')
})

test('the status line warns against confirming non-cross-agent claims', () => {
  const ws = workspace('warn')
  // 2 cross / 1 same: total and cross-agent must differ here too, or the line's
  // "(1 cross-agent)" assertion would pass under an inverted predicate.
  seedReuse(ws, [
    { ...autoClaim('x1', 'project-alpha'), sourceAgent: 'opencode', targetAgent: 'codex' },
    { ...autoClaim('x2', 'project-alpha'), sourceAgent: 'mcp', targetAgent: 'codex' },
    autoClaim('s1', 'project-alpha'),
  ])

  const result = run(ws, ['status'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Pending auto-claims: 3 \(2 cross-agent\)/)
  // The guidance must not read as "confirm them all".
  assert.match(result.stdout, /same-agent/)
  assert.match(result.stdout, /ADR-017/)
})

test('cross-agent is 0 when every pending claim is same-agent', () => {
  const ws = workspace('allsame')
  seedReuse(ws, [autoClaim('s1', 'project-alpha'), autoClaim('s2', 'project-beta')])

  const payload = jsonOf(ws, ['status', '--json'])
  assert.equal(payload.pendingAutoClaims, 2)
  assert.equal(payload.pendingCrossAgent, 0, 'a same-agent backlog has no confirmable records at all')
})
