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
