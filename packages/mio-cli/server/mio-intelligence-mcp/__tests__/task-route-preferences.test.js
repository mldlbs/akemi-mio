'use strict'

// PR3 (ADR-017 Phase 2 autosuggest): task.route consumes an active Evolution
// routing preference (routing_preferences.jsonl, written by
// mio.evolution.suggestion.apply) by nudging the weight of any route whose
// source/target agent matches the preference's preferAgent. The preference only
// re-ranks — it never invents a route for an agent no experience uses.

const os = require('os')
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { test } = require('node:test')
const { createMemoryStore } = require('../../memory-store.js')
const { createQueryLog } = require('../../query-log.js')
const { createTaskStore } = require('../../task-store.js')
const { REUSE_STATUS_FILTERS } = require('../../experience-store.js')

const PROJECT = 'pr3-test'

const MEMORY =
  JSON.stringify({
    id: 'm1',
    timestamp: new Date().toISOString(),
    kind: 'fix',
    content: 'deploy service to production and restart the worker',
    tags: ['deploy', 'prod'],
    project: PROJECT,
    scope: 'project',
  }) + '\n'

const REUSE =
  JSON.stringify({
    id: 'x1',
    experienceId: 'm1',
    sourceAgent: 'opencode',
    targetAgent: 'codex',
    reuse: true,
    behaviorChanged: true,
    outcomeImproved: true,
    confirmed: true,
    project: PROJECT,
    source: 'manual',
  }) + '\n'

function pref(overrides = {}) {
  return (
    JSON.stringify({
      id: 'pref_1',
      project: PROJECT,
      preferAgent: 'codex',
      baselineAgent: 'opencode',
      successRateDelta: 18,
      suggestionId: 'sug_1',
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      ...overrides,
    }) + '\n'
  )
}

function buildStore({ prefs } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-route-'))
  fs.writeFileSync(path.join(dataDir, 'memory.jsonl'), MEMORY)
  fs.writeFileSync(path.join(dataDir, 'experience_reuse.jsonl'), REUSE)
  if (prefs) fs.writeFileSync(path.join(dataDir, 'routing_preferences.jsonl'), prefs)
  const projectName = () => PROJECT
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
  return taskStore
}

const TASK = 'deploy service production'

test('active preference boosts the matching route and sets routingHint', () => {
  const taskStore = buildStore({ prefs: pref() })
  const res = taskStore.routeTask({ task: TASK, project: PROJECT, persistQuery: false })
  assert.strictEqual(res.count, 1)
  const route = res.routes[0]
  assert.ok(route.routingHint && route.routingHint.includes('codex'), 'routingHint should name codex')
  assert.deepStrictEqual(route.routingPreferenceIds, ['pref_1'])
  assert.strictEqual(res.summary.routingPreferences, 1)
})

test('no preference file is a back-compat no-op (routingHint null)', () => {
  const taskStore = buildStore({ prefs: null })
  const res = taskStore.routeTask({ task: TASK, project: PROJECT, persistQuery: false })
  assert.strictEqual(res.count, 1)
  assert.strictEqual(res.routes[0].routingHint, null)
  assert.deepStrictEqual(res.routes[0].routingPreferenceIds, [])
  assert.strictEqual(res.summary.routingPreferences, 0)
})

test('expired preference is ignored (treated as inactive)', () => {
  const taskStore = buildStore({
    prefs: pref({ expiresAt: new Date(Date.now() - 86400000).toISOString() }),
  })
  const res = taskStore.routeTask({ task: TASK, project: PROJECT, persistQuery: false })
  assert.strictEqual(res.count, 1)
  assert.strictEqual(res.routes[0].routingHint, null)
  assert.strictEqual(res.summary.routingPreferences, 0)
})

test('preference for an uninvolved agent has no effect', () => {
  const taskStore = buildStore({ prefs: pref({ preferAgent: 'claude', id: 'pref_claude' }) })
  const res = taskStore.routeTask({ task: TASK, project: PROJECT, persistQuery: false })
  assert.strictEqual(res.count, 1)
  assert.strictEqual(res.routes[0].routingHint, null)
  assert.strictEqual(res.summary.routingPreferences, 0)
})
