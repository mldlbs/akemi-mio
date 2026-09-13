'use strict'

// Tests for `mio agents list` / `mio agents report` and the shared agent store.
// Data is seeded directly into a throwaway MIO_HOME so the cross-references
// (traces + memory + experience reuse) can be asserted exactly. The CLI reads
// the global MIO_HOME, so the workspace helper only needs to control that dir.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-agent-' + label + '-'))
}

function run(cwd, env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env })
}

function workspace(label) {
  const mioHome = tempDir(label)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-agent-cwd-'))
  const env = { ...process.env, MIO_HOME: mioHome }
  return { mioHome, cwd, env, project: path.basename(cwd) }
}

function seed(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

function seedAgentData(ws, project = 'proj-a') {
  const home = ws.mioHome
  seed(path.join(home, 'agents.jsonl'), [
    {
      id: 'agent_codex',
      agentId: 'codex',
      hostType: 'mcp',
      capabilities: ['code'],
      registeredAt: '2026-08-21T00:00:00.000Z',
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      sessionCount: 3,
      project,
      taskCount: 5,
      successCount: 4,
      failureCount: 1,
    },
    {
      id: 'agent_health',
      agentId: 'health-check',
      hostType: 'mcp',
      capabilities: [],
      registeredAt: '2026-08-29T00:00:00.000Z',
      lastSeenAt: '2026-08-29T00:00:00.000Z',
      sessionCount: 1,
      project,
    },
  ])
  // Traces: codex has 2 task_outcome events (1 success, 1 failure) plus a
  // non-task event; health-check has none.
  seed(path.join(home, 'traces.jsonl'), [
    { agent: 'codex', event_type: 'task_outcome', outcome: 'success', project },
    { agent: 'codex', event_type: 'task_outcome', outcome: 'failure', project },
    { agent: 'codex', event_type: 'tool_call', outcome: null, project },
  ])
  seed(path.join(home, 'memory.jsonl'), [
    { id: 'mem_1', source: 'codex', content: 'decision about X', project },
    { id: 'mem_2', source: 'codex', content: 'note about Y', project },
  ])
  seed(path.join(home, 'experience_reuse.jsonl'), [
    { id: 'x1', sourceAgent: 'codex', targetAgent: 'claude', experienceId: 'mem_1', confirmed: true, reuse: true, behaviorChanged: true, outcomeImproved: true, project },
    { id: 'x2', sourceAgent: 'other', targetAgent: 'codex', experienceId: 'mem_2', confirmed: false, reuse: true, behaviorChanged: false, outcomeImproved: true, project },
  ])
}

function listJson(ws, extra = []) {
  const result = run(ws.cwd, ws.env, ['agents', 'list', '--json', ...extra])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function reportJson(ws, extra = []) {
  const result = run(ws.cwd, ws.env, ['agents', 'report', '--json', ...extra])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('agents list shows observed agents from agents.jsonl', () => {
  const ws = workspace('list')
  seedAgentData(ws, ws.project)

  const result = listJson(ws)
  assert.equal(result.count, 2)
  const ids = result.agents.map((a) => a.agentId).sort()
  assert.deepEqual(ids, ['codex', 'health-check'])
  assert.ok(result.agents.every((a) => typeof a.taskCount === 'number'))

  const text = run(ws.cwd, ws.env, ['agents', 'list'])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /Observed agents: 2 shown/)
  assert.match(text.stdout, /codex/)
})

test('agents report aggregates traces, memory and reuse', () => {
  const ws = workspace('report')
  seedAgentData(ws, ws.project)

  const result = reportJson(ws)
  assert.equal(result.count, 2)
  const codex = result.reports.find((r) => r.agentId === 'codex')
  assert.ok(codex, 'codex should be reported')
  // agent.taskCount (5) is authoritative when present, so total=5 not 2 traces.
  assert.equal(codex.taskOutcomes.total, 5)
  assert.equal(codex.taskOutcomes.success, 4)
  assert.equal(codex.taskOutcomes.failure, 1)
  assert.equal(codex.taskOutcomes.successRate, 80)
  assert.equal(codex.memories, 2)
  assert.equal(codex.experienceReuses.total, 2)
  assert.equal(codex.experienceReuses.verified, 1)

  const health = result.reports.find((r) => r.agentId === 'health-check')
  assert.equal(health.taskOutcomes.total, 0)
  assert.equal(health.memories, 0)

  const text = run(ws.cwd, ws.env, ['agents', 'report'])
  assert.match(text.stdout, /codex \(mcp\)/)
  assert.match(text.stdout, /100% success|80% success/)
  assert.match(text.stdout, /experience reuses: 2 \(verified 1\)/)
})

test('agents report --agent filters to one agent', () => {
  const ws = workspace('filter')
  seedAgentData(ws, ws.project)

  const result = reportJson(ws, ['--agent', 'health-check'])
  assert.equal(result.count, 1)
  assert.equal(result.reports[0].agentId, 'health-check')
})

test('agents report --project scopes the set', () => {
  const ws = workspace('proj')
  seedAgentData(ws, 'proj-a')
  // Add an agent in a different project.
  const file = path.join(ws.mioHome, 'agents.jsonl')
  const extra = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  extra.push({
    id: 'agent_other',
    agentId: 'codex',
    hostType: 'mcp',
    capabilities: [],
    registeredAt: '2026-08-29T00:00:00.000Z',
    lastSeenAt: '2026-08-29T00:00:00.000Z',
    sessionCount: 1,
    project: 'proj-b',
  })
  fs.writeFileSync(file, extra.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const scoped = reportJson(ws, ['--project', 'proj-a'])
  assert.equal(scoped.count, 2)
  const all = reportJson(ws, ['--project', 'proj-b'])
  assert.equal(all.count, 1)
  assert.equal(all.reports[0].agentId, 'codex')
})

test('agents subcommand validates its arguments', () => {
  const ws = workspace('usage')
  seedAgentData(ws, ws.project)

  const none = run(ws.cwd, ws.env, ['agents', 'bogus'])
  assert.equal(none.status, 1)
  assert.match(none.stderr, /Unknown agents subcommand: bogus/)

  const noData = workspace('empty')
  const empty = run(noData.cwd, noData.env, ['agents', 'list'])
  assert.equal(empty.status, 0, empty.stderr)
  assert.match(empty.stdout, /No observed agents match/)
})

test('the CLI and the shared store agree on the same agents', () => {
  // Both entry points delegate to server/agent-store.js; this pins that the
  // CLI points at the same store the direct call would read.
  const { createAgentStore } = require('../server/agent-store.js')
  const ws = workspace('store')
  seedAgentData(ws, ws.project)

  const store = createAgentStore({ dataDir: ws.mioHome, projectName: () => ws.project })

  const directReport = store.reportAgent({ project: ws.project })
  const viaCliReport = reportJson(ws)
  assert.equal(directReport.count, viaCliReport.count)
  assert.deepEqual(
    directReport.reports.map((r) => r.agentId).sort(),
    viaCliReport.reports.map((r) => r.agentId).sort()
  )
  const directCodex = directReport.reports.find((r) => r.agentId === 'codex')
  const cliCodex = viaCliReport.reports.find((r) => r.agentId === 'codex')
  assert.deepEqual(directCodex.taskOutcomes, cliCodex.taskOutcomes)
  assert.deepEqual(directCodex.experienceReuses, cliCodex.experienceReuses)

  const directList = store.listAgents({ project: ws.project })
  const viaCliList = listJson(ws)
  assert.equal(directList.count, viaCliList.count)
})
