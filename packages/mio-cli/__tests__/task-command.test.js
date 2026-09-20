'use strict'

// Tests for `mio task route` and the shared task store. The route is built from
// verified experience-reuse records whose source memory matches the task, so the
// fixtures seed memory + reuse together.
//
// The most important assertion is the last group: a terminal `mio task route`
// must NOT write to queries.jsonl. The MCP call does (auto-claim depends on it),
// and the CLI opts out via persistQuery: false.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-task-' + label + '-'))
}

function run(cwd, env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env })
}

function workspace(label) {
  const mioHome = tempDir(label)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-task-cwd-'))
  return { mioHome, cwd, env: { ...process.env, MIO_HOME: mioHome }, project: 'proj-r' }
}

function seed(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

// A reuse only counts as `verified` when confirmed + reuse + behaviorChanged +
// outcomeImproved are all truthy.
function verifiedReuse(id, experienceId, sourceAgent, targetAgent, project, extra = {}) {
  return {
    id,
    experienceId,
    sourceAgent,
    targetAgent,
    project,
    confirmed: true,
    reuse: true,
    behaviorChanged: true,
    outcomeImproved: true,
    ...extra,
  }
}

function seedRouteData(ws, project = ws.project) {
  seed(path.join(ws.mioHome, 'memory.jsonl'), [
    { id: 'mem_deploy', kind: 'decision', content: 'deploy the service to production', project, tags: [] },
    { id: 'mem_db', kind: 'note', content: 'database migration steps', project, tags: [] },
    { id: 'mem_other', kind: 'note', content: 'unrelated wallpaper tuning', project, tags: [] },
  ])
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    verifiedReuse('x1', 'mem_deploy', 'codex', 'claude', project),
    verifiedReuse('x2', 'mem_deploy', 'codex', 'opencode', project),
    verifiedReuse('x3', 'mem_db', 'claude', 'codex', project),
    // Not verified: outcomeImproved false -> must never appear as a route.
    verifiedReuse('x4', 'mem_other', 'codex', 'claude', project, { outcomeImproved: false }),
  ])
}

function routeJson(ws, task, extra = []) {
  const result = run(ws.cwd, ws.env, ['task', 'route', task, '--json', '--project', ws.project, ...extra])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('task route returns verified experiences ranked by score', () => {
  const ws = workspace('routes')
  seedRouteData(ws)

  const result = routeJson(ws, 'deploy service')
  assert.equal(result.count >= 1, true, 'at least the deploy memory routes')
  const top = result.routes[0]
  assert.equal(top.experienceId, 'mem_deploy')
  assert.equal(top.reuseCount, 2, 'both deploy reuses collapse into one route')
  assert.equal(top.confirmed, true)
  assert.deepEqual(top.sourceAgents, ['codex'])
  assert.ok(top.targetAgents.includes('claude'))
  assert.ok(top.targetAgents.includes('opencode'))
  assert.equal(typeof top.score, 'number')

  // The non-verified reuse must not produce a route.
  const ids = result.routes.map((r) => r.experienceId)
  assert.ok(!ids.includes('mem_other'), 'unverified experience must not route')
})

test('task route prints a readable plan', () => {
  const ws = workspace('text')
  seedRouteData(ws)

  const result = run(ws.cwd, ws.env, ['task', 'route', 'deploy service', '--project', ws.project])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Task route: "deploy service"/)
  assert.match(result.stdout, /verified routes: /)
  assert.match(result.stdout, /mem_deploy/)
  assert.match(result.stdout, /Routes \(apply the top match first\)/)
})

test('task route respects --limit', () => {
  const ws = workspace('limit')
  seedRouteData(ws)

  const limited = routeJson(ws, 'deploy service database migration', ['--limit', '1'])
  assert.equal(limited.count <= 1, true)
})

test('task route --project scopes the route set', () => {
  const ws = workspace('scope')
  // Seeded in one pass: seed() overwrites, so two calls would clobber the first
  // project. Both projects get an identical-looking deploy memory; only proj-r
  // should route.
  seed(path.join(ws.mioHome, 'memory.jsonl'), [
    { id: 'mem_r_deploy', kind: 'decision', content: 'deploy the service to production', project: 'proj-r', tags: [] },
    { id: 'mem_o_deploy', kind: 'decision', content: 'deploy the service to production', project: 'proj-other', tags: [] },
  ])
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    verifiedReuse('xr1', 'mem_r_deploy', 'codex', 'claude', 'proj-r'),
    verifiedReuse('xo1', 'mem_o_deploy', 'codex', 'claude', 'proj-other'),
  ])

  const scoped = routeJson(ws, 'deploy service')
  assert.ok(scoped.count >= 1, 'proj-r has a deploy route')
  assert.equal(scoped.routes.length, 1)
  assert.equal(scoped.routes[0].experienceId, 'mem_r_deploy')
  for (const route of scoped.routes) {
    assert.equal(route.memory.project, 'proj-r', 'proj-other must not leak into the route set')
  }
})

test('task route reports nothing to route for an unrelated task', () => {
  const ws = workspace('empty')
  seedRouteData(ws)

  const result = routeJson(ws, 'zzz nothing matches this at all')
  assert.equal(result.count, 0)
  assert.deepEqual(result.routes, [])
  assert.match(result.summary.suggestion, /No matching experience or memory found|No verified experience/)
})

test('task subcommand validates its arguments', () => {
  const ws = workspace('usage')
  seedRouteData(ws)

  const none = run(ws.cwd, ws.env, ['task'])
  assert.equal(none.status, 1)
  assert.match(none.stdout, /Usage:/)

  const unknown = run(ws.cwd, ws.env, ['task', 'bogus'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown task subcommand: bogus/)

  const noTask = run(ws.cwd, ws.env, ['task', 'route'])
  assert.equal(noTask.status, 1)
  assert.match(noTask.stderr, /requires a task/)

  const help = run(ws.cwd, ws.env, ['task', 'help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mio task route/)
})

test('the CLI does not write to the query log (persistQuery false)', () => {
  // The MCP call feeds queries.jsonl so a later task_outcome can auto-claim
  // route-driven reuse. A terminal inspection must not do that.
  const ws = workspace('noWrite')
  seedRouteData(ws)
  const queryPath = path.join(ws.mioHome, 'queries.jsonl')

  run(ws.cwd, ws.env, ['task', 'route', 'deploy service', '--project', ws.project])
  assert.equal(fs.existsSync(queryPath), false, 'CLI must not create/persist queries.jsonl')

  // The same store, asked to persist, does write -- proving the difference is
  // the flag and not a broken code path.
  const { createTaskStore } = require('../server/task-store.js')
  const { createMemoryStore } = require('../server/memory-store.js')
  const store = createTaskStore({
    dataDir: ws.mioHome,
    projectName: () => ws.project,
    memoryStore: createMemoryStore({ dataDir: ws.mioHome, projectName: () => ws.project }),
    agentId: () => 'test',
  })
  store.routeTask({ task: 'deploy service', project: ws.project, persistQuery: true })
  assert.equal(fs.existsSync(queryPath), true, 'persistQuery true does write (MCP behaviour)')
})

test('the CLI and the shared store agree', () => {
  const { createTaskStore } = require('../server/task-store.js')
  const { createMemoryStore } = require('../server/memory-store.js')
  const ws = workspace('store')
  seedRouteData(ws)

  const store = createTaskStore({
    dataDir: ws.mioHome,
    projectName: () => ws.project,
    memoryStore: createMemoryStore({ dataDir: ws.mioHome, projectName: () => ws.project }),
    agentId: () => 'test',
  })

  const direct = store.routeTask({ task: 'deploy service', project: ws.project, persistQuery: false })
  const viaCli = routeJson(ws, 'deploy service')

  assert.equal(direct.count, viaCli.count)
  assert.equal(direct.task, viaCli.task)
  assert.deepEqual(
    direct.routes.map((r) => r.experienceId),
    viaCli.routes.map((r) => r.experienceId)
  )
  assert.deepEqual(direct.summary, viaCli.summary)

  assert.throws(() => store.routeTask({}), /requires a non-empty task/)
})

// ─────────────────────────────────────────────────────────────────────────────
// record-outcome: the write side. Same contract as `mio agents register` /
// `mio memory archive`: previews by default (exit 1, nothing written), applies
// only with --yes, --json gated identically.
// ─────────────────────────────────────────────────────────────────────────────

function tracesFile(ws) {
  return path.join(ws.mioHome, 'traces.jsonl')
}

function readTraces(ws) {
  if (!fs.existsSync(tracesFile(ws))) return []
  return fs
    .readFileSync(tracesFile(ws), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function readLastAgent(ws) {
  const file = path.join(ws.mioHome, 'agents.jsonl')
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

test('record-outcome rejects a missing or invalid outcome before writing', () => {
  const ws = workspace('ro-bad')

  const missing = run(ws.cwd, ws.env, ['task', 'record-outcome'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /requires --outcome/)

  const invalid = run(ws.cwd, ws.env, ['task', 'record-outcome', '--outcome', 'maybe'])
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /requires --outcome/)

  assert.equal(fs.existsSync(tracesFile(ws)), false, 'nothing written')
})

test('record-outcome previews without writing', () => {
  const ws = workspace('ro-preview')

  const result = run(ws.cwd, ws.env, [
    'task', 'record-outcome', '--outcome', 'success', '--project', 'demo', '--task', 'deploy it',
  ])
  assert.equal(result.status, 1, 'preview exits non-zero')
  assert.match(result.stdout, /Record outcome preview: success/)
  assert.match(result.stdout, /task: deploy it/)
  assert.match(result.stdout, /agent not registered/)
  assert.match(result.stdout, /mio agents register --agent-id cli --yes/)
  assert.equal(fs.existsSync(tracesFile(ws)), false, 'preview must not write traces.jsonl')
})

test('record-outcome preview shows the agent update when registered', () => {
  const ws = workspace('ro-existing')
  seed(path.join(ws.mioHome, 'agents.jsonl'), [
    { id: 'agent_1', agentId: 'cli', hostType: 'mcp', project: 'demo', taskCount: 4, successCount: 3 },
  ])

  const result = run(ws.cwd, ws.env, ['task', 'record-outcome', '--outcome', 'success', '--project', 'demo'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /will update agent \(taskCount 4 -> 5, successCount 3 -> 4\)/)
  assert.equal(readLastAgent(ws).taskCount, 4, 'untouched')
})

test('record-outcome --yes writes a task_outcome trace', () => {
  const ws = workspace('ro-apply')

  const result = run(ws.cwd, ws.env, [
    'task', 'record-outcome', '--outcome', 'success', '--project', 'demo',
    '--task', 'deploy it', '--summary', 'all green', '--yes',
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Recorded success for cli/)

  const traces = readTraces(ws)
  assert.equal(traces.length, 1)
  assert.equal(traces[0].event_type, 'task_outcome')
  assert.equal(traces[0].outcome, 'success')
  assert.equal(traces[0].project, 'demo')
  assert.equal(traces[0].agent, 'cli')
  assert.equal(traces[0].payload.task, 'deploy it')
  assert.equal(traces[0].payload.summary, 'all green')
})

test('record-outcome --yes updates the agent registry when registered', () => {
  const ws = workspace('ro-agent')
  seed(path.join(ws.mioHome, 'agents.jsonl'), [
    { id: 'agent_1', agentId: 'cli', hostType: 'mcp', project: 'demo', taskCount: 1, successCount: 1, failureCount: 0 },
  ])

  run(ws.cwd, ws.env, ['task', 'record-outcome', '--outcome', 'success', '--project', 'demo', '--yes'])
  let agent = readLastAgent(ws)
  assert.equal(agent.taskCount, 2)
  assert.equal(agent.successCount, 2)
  assert.equal(agent.failureCount, 0)

  run(ws.cwd, ws.env, ['task', 'record-outcome', '--outcome', 'failure', '--project', 'demo', '--yes'])
  agent = readLastAgent(ws)
  assert.equal(agent.taskCount, 3)
  assert.equal(agent.successCount, 2)
  assert.equal(agent.failureCount, 1)
})

test('record-outcome --json is gated the same way', () => {
  const ws = workspace('ro-json')

  const preview = run(ws.cwd, ws.env, [
    'task', 'record-outcome', '--outcome', 'success', '--project', 'demo', '--json',
  ])
  assert.equal(preview.status, 1)
  const previewJson = JSON.parse(preview.stdout)
  assert.equal(previewJson.preview, true)
  assert.equal(previewJson.applied, false)
  assert.equal(previewJson.agentWillUpdate, false)
  assert.match(previewJson.hint, /--yes/)
  assert.equal(fs.existsSync(tracesFile(ws)), false)

  const applied = run(ws.cwd, ws.env, [
    'task', 'record-outcome', '--outcome', 'aborted', '--project', 'demo', '--json', '--yes',
  ])
  assert.equal(applied.status, 0, applied.stderr)
  const appliedJson = JSON.parse(applied.stdout)
  assert.equal(appliedJson.recorded, true)
  assert.equal(appliedJson.event.outcome, 'aborted')
  assert.equal(readTraces(ws).length, 1)
})

// ── `--task` must be parsed as a flag whose VALUE is the task ───────────────

// Regression guard. `--task` was missing from the set of recognised options, so
// its name was treated as part of the task text: the query then contained the
// literal token `task`, which matches nearly every memory record and silently
// widened recall (measured on the real dataset: the same task scored 3 records
// positionally but 10 via `--task`). The documented form is positional, so
// nobody using `--task` would have known the query was being corrupted.

test('task route --task parses the value, not the flag name', () => {
  const ws = workspace('task-flag')
  seedRouteData(ws)

  const viaFlag = routeJson(ws, 'deploy the service to production', ['--task']) // wrong order on purpose below
  // The helper above passes positionally; assert the explicit form separately.
  const explicit = run(ws.cwd, ws.env, [
    'task', 'route', '--task', 'deploy the service to production',
    '--json', '--project', ws.project,
  ])
  assert.equal(explicit.status, 0, explicit.stderr)
  const parsed = JSON.parse(explicit.stdout)
  assert.equal(parsed.task, 'deploy the service to production', 'flag name must not leak into the task')
  assert.doesNotMatch(parsed.task, /--task/)
  assert.equal(parsed.count, viaFlag.count, 'explicit and positional forms must route identically')
})

test('task route --task matches the positional form exactly', () => {
  const ws = workspace('task-flag-eq')
  seedRouteData(ws)

  const positional = routeJson(ws, 'deploy the service to production')
  const viaFlag = run(ws.cwd, ws.env, [
    'task', 'route', '--task', 'deploy the service to production',
    '--json', '--project', ws.project,
  ])
  assert.equal(viaFlag.status, 0, viaFlag.stderr)
  const flagged = JSON.parse(viaFlag.stdout)
  assert.equal(flagged.task, positional.task)
  assert.equal(flagged.count, positional.count)
})

// ── routing gate diagnostic ────────────────────────────────────────────────

// Routing only considers *verified* reuse, so an all-unconfirmed dataset yields
// 0 routes for every task however well it matches. That is indistinguishable
// from "nothing matched" unless the report says which it is -- and the two need
// opposite responses (investigate recall vs run `experience confirm`).

test('gatedBy explains that relevant experience exists but is unconfirmed', () => {
  const ws = workspace('gate-unconfirmed')
  seed(path.join(ws.mioHome, 'memory.jsonl'), [
    { id: 'mem_deploy', kind: 'decision', content: 'deploy the service to production', project: ws.project, tags: [] },
  ])
  // Relevant to the task, improved, but never confirmed -> not verified.
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    verifiedReuse('x1', 'mem_deploy', 'codex', 'claude', ws.project, { source: 'auto_claim', confirmed: false, behaviorChanged: false }),
  ])

  const parsed = routeJson(ws, 'deploy the service to production')
  assert.equal(parsed.count, 0)
  assert.equal(parsed.gatedBy.reason, 'unconfirmed')
  assert.equal(parsed.gatedBy.relevantUnconfirmed, 1)
  assert.equal(parsed.gatedBy.verifiedTotal, 0)
  // The suggestion must point at the fix, not at a recall investigation.
  assert.match(parsed.summary.suggestion, /unconfirmed/)
  assert.match(parsed.summary.suggestion, /experience confirm/)
})

test('gatedBy reports no-match when nothing overlaps', () => {
  const ws = workspace('gate-nomatch')
  seed(path.join(ws.mioHome, 'memory.jsonl'), [
    { id: 'mem_deploy', kind: 'decision', content: 'deploy the service to production', project: ws.project, tags: [] },
  ])
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    verifiedReuse('x1', 'mem_deploy', 'codex', 'claude', ws.project, { source: 'auto_claim', confirmed: false, behaviorChanged: false }),
  ])

  const parsed = routeJson(ws, 'zzz quantum banana nonsense')
  assert.equal(parsed.count, 0)
  assert.equal(parsed.gatedBy.reason, 'no-match')
  assert.equal(parsed.gatedBy.relevantUnconfirmed, 0)
})

test('gatedBy is absent once routing succeeds', () => {
  const ws = workspace('gate-none')
  seedRouteData(ws)
  const parsed = routeJson(ws, 'deploy the service to production')
  assert.ok(parsed.count > 0, 'fixture must produce a route')
  assert.equal(parsed.gatedBy, null, 'no gate to report when routes exist')
})

test('the CLI prints the gate reason only when it applies', () => {
  const ws = workspace('gate-text')
  seed(path.join(ws.mioHome, 'memory.jsonl'), [
    { id: 'mem_deploy', kind: 'decision', content: 'deploy the service to production', project: ws.project, tags: [] },
  ])
  seed(path.join(ws.mioHome, 'experience_reuse.jsonl'), [
    verifiedReuse('x1', 'mem_deploy', 'codex', 'claude', ws.project, { source: 'auto_claim', confirmed: false, behaviorChanged: false }),
  ])

  const gated = run(ws.cwd, ws.env, ['task', 'route', 'deploy the service to production', '--project', ws.project])
  assert.equal(gated.status, 0, gated.stderr)
  assert.match(gated.stdout, /routing gated: 1 relevant experience\(s\) are unconfirmed/)

  const clean = run(ws.cwd, ws.env, ['task', 'route', 'zzz quantum banana nonsense', '--project', ws.project])
  assert.equal(clean.status, 0, clean.stderr)
  assert.doesNotMatch(clean.stdout, /routing gated/)
})
