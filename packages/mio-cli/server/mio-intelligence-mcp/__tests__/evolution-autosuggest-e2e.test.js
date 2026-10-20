'use strict'

// PR4 (ADR-017 Phase 2 autosuggest): end-to-end closed loop.
// evolution.report proposes a routing suggestion -> the suggestion store gates it
// through human authority -> the applied preference is written to
// routing_preferences.jsonl -> task.route consumes it and boosts the route whose
// agent matches preferAgent. Exercises the full cross-store pipeline with one
// shared dataDir.

const os = require('os')
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { test } = require('node:test')

const { createEvolutionReport } = require('../../evolution-report.js')
const { createEvolutionSuggestionStore } = require('../../evolution-suggestions.js')
const { createMemoryStore } = require('../../memory-store.js')
const { createQueryLog } = require('../../query-log.js')
const { createTaskStore } = require('../../task-store.js')
const { REUSE_STATUS_FILTERS } = require('../../experience-store.js')

const PROJECT = 'e2e-test'

function seed(dataDir) {
  const now = Date.now()
  // codex: 9/10 success (~90%); opencode: 1/10 success (~10%) => delta 80, both
  // meet the >=5 sample floor so the report emits a high-priority routing suggestion.
  const traces = []
  for (let i = 0; i < 10; i++) {
    traces.push({
      id: 't-c-' + i,
      trace_id: 'tr-c-' + i,
      event_type: 'task_outcome',
      outcome: i < 9 ? 'success' : 'failure',
      agent: 'codex',
      project: PROJECT,
      timestamp: new Date(now - i * 1000).toISOString(),
    })
  }
  for (let i = 0; i < 10; i++) {
    traces.push({
      id: 't-o-' + i,
      trace_id: 'tr-o-' + i,
      event_type: 'task_outcome',
      outcome: i === 0 ? 'success' : 'failure',
      agent: 'opencode',
      project: PROJECT,
      timestamp: new Date(now - i * 1000).toISOString(),
    })
  }
  fs.writeFileSync(
    path.join(dataDir, 'traces.jsonl'),
    traces.map((t) => JSON.stringify(t)).join('\n') + '\n',
  )

  const memories = [
    {
      id: 'm1',
      timestamp: new Date(now).toISOString(),
      kind: 'fix',
      content: 'deploy service to production and restart the worker',
      tags: ['deploy', 'prod'],
      project: PROJECT,
      scope: 'project',
    },
  ]
  fs.writeFileSync(
    path.join(dataDir, 'memory.jsonl'),
    memories.map((m) => JSON.stringify(m)).join('\n') + '\n',
  )

  // Verified cross-agent reuse that involves the preferred agent (codex) so the
  // resulting route is eligible for the preference boost.
  const reuses = [
    {
      id: 'x1',
      experienceId: 'm1',
      sourceAgent: 'codex',
      targetAgent: 'opencode',
      reuse: true,
      behaviorChanged: true,
      outcomeImproved: true,
      confirmed: true,
      project: PROJECT,
      source: 'manual',
    },
  ]
  fs.writeFileSync(
    path.join(dataDir, 'experience_reuse.jsonl'),
    reuses.map((r) => JSON.stringify(r)).join('\n') + '\n',
  )
}

test('evolution suggestion -> gated apply -> task.route boost (closed loop)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-autosuggest-'))
  seed(dataDir)
  const projectName = () => PROJECT

  // 1. Report emits a structured routing suggestion.
  const report = createEvolutionReport({ dataDir, projectName }).report({ project: PROJECT })
  const routing = report.suggestions.find((s) => s.category === 'routing')
  assert.ok(routing, 'report should emit a routing suggestion')
  assert.strictEqual(routing.preferAgent, 'codex')
  assert.ok(routing.evidence.best.total >= routing.minSamplePerAgent)

  // 2. Propose it (only high-priority routing suggestions with enough sample qualify).
  const suggestionStore = createEvolutionSuggestionStore({ dataDir, projectName })
  const proposed = suggestionStore.propose(routing)
  assert.strictEqual(proposed.status, 'proposed')
  assert.strictEqual(proposed.preferAgent, 'codex')

  // 3a. No cutover backend and no forceAuthority => the gate refuses (never auto-applies).
  await assert.rejects(
    () => suggestionStore.apply(proposed.id, { approvedBy: 'tester' }),
    (err) => err.code === 'NOT_READY',
  )

  // 3b. With explicit human authority (forceAuthority skips the staged cutover gate),
  // the suggestion is applied and a preference is written.
  const applied = await suggestionStore.apply(proposed.id, {
    approvedBy: 'tester',
    forceAuthority: true,
  })
  assert.strictEqual(applied.status, 'applied')
  const prefId = applied.preferenceId
  assert.ok(prefId && prefId.startsWith('pref_'), 'applied record exposes preferenceId')

  const prefs = fs
    .readFileSync(path.join(dataDir, 'routing_preferences.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  assert.strictEqual(prefs.length, 1)
  assert.strictEqual(prefs[0].preferAgent, 'codex')
  assert.strictEqual(prefs[0].status, 'active')

  // 4. task.route consumes the preference and boosts the codex-involving route.
  const queryLog = createQueryLog({ dataDir })
  const memoryStore = createMemoryStore({
    dataDir,
    projectName,
    agentId: () => 'cli',
    queryLog,
    verifiedFilter: REUSE_STATUS_FILTERS.verified,
  })
  const taskStore = createTaskStore({
    dataDir,
    projectName,
    memoryStore,
    queryLog,
    agentId: () => 'cli',
  })
  const res = taskStore.routeTask({ task: 'deploy service production', project: PROJECT, persistQuery: false })
  assert.ok(res.count >= 1, 'route should be returned')
  const route = res.routes.find((r) => r.routingPreferenceIds.includes(prefId))
  assert.ok(route, 'a route should carry the applied preference id')
  assert.ok(route.routingHint && route.routingHint.includes('codex'), 'routingHint should name codex')
  assert.strictEqual(res.summary.routingPreferences, 1)
})
