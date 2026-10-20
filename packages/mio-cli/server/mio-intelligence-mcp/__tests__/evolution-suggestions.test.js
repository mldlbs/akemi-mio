'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const os = require('os')
const path = require('path')
const { mkdtempSync } = require('fs')
const { createEvolutionSuggestionStore } = require('../../evolution-suggestions.js')

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'evo-sug-'))
}

function eligibleRoutingSuggestion(overrides = {}) {
  return {
    category: 'routing',
    priority: 'high',
    preferAgent: 'codex',
    baselineAgent: 'opencode',
    successRateDelta: 40,
    minSamplePerAgent: 5,
    evidence: {
      best: { total: 10, success: 10, failure: 0, successRate: 100 },
      worst: { total: 10, success: 5, failure: 5, successRate: 50 },
    },
    description: 'prefer routing to codex',
    ...overrides,
  }
}

test('propose rejects ineligible (non-routing) suggestions', () => {
  const store = createEvolutionSuggestionStore({ dataDir: tmpDir(), projectName: () => 'p' })
  assert.throws(() => store.propose({ category: 'evidence', priority: 'medium' }), (e) => e.code === 'INELIGIBLE')
})

test('propose rejects routing suggestion with insufficient sample', () => {
  const store = createEvolutionSuggestionStore({ dataDir: tmpDir(), projectName: () => 'p' })
  assert.throws(
    () => store.propose(eligibleRoutingSuggestion({ evidence: { best: { total: 2, successRate: 100 }, worst: { total: 2, successRate: 50 } } })),
    (e) => e.code === 'INELIGIBLE',
  )
})

test('apply requires approvedBy (human authority)', async () => {
  const store = createEvolutionSuggestionStore({ dataDir: tmpDir(), projectName: () => 'p' })
  const sug = store.propose(eligibleRoutingSuggestion())
  await assert.rejects(() => store.apply(sug.id, {}), (e) => e.code === 'UNAUTHORIZED')
})

test('apply without cutover backend refuses unless forceAuthority', async () => {
  const dir = tmpDir()
  const store = createEvolutionSuggestionStore({ dataDir: dir, projectName: () => 'p' })
  const sug = store.propose(eligibleRoutingSuggestion())
  await assert.rejects(() => store.apply(sug.id, { approvedBy: 'alice' }), (e) => e.code === 'NOT_READY')
  const applied = await store.apply(sug.id, { approvedBy: 'alice', forceAuthority: true })
  assert.equal(applied.status, 'applied')
})

test('apply writes an active routing preference with expiry', async () => {
  const dir = tmpDir()
  const store = createEvolutionSuggestionStore({ dataDir: dir, projectName: () => 'p' })
  const sug = store.propose(eligibleRoutingSuggestion())
  const applied = await store.apply(sug.id, { approvedBy: 'alice', forceAuthority: true })
  assert.equal(applied.status, 'applied')
  const prefs = store.listPreferences({ project: 'p' })
  assert.equal(prefs.length, 1)
  assert.equal(prefs[0].preferAgent, 'codex')
  assert.equal(prefs[0].status, 'active')
  assert.ok(new Date(prefs[0].expiresAt).getTime() > Date.now())
})

test('apply drives gated rollout when cutover backend is present', async () => {
  const dir = tmpDir()
  const cutover = {
    recordShadowComparison: async () => ({ id: 'sh_1' }),
    recordDualWrite: async () => ({ id: 'dw_1' }),
    cutoverReadiness: () => ({ ready: true, shadowRuns: 1, dualWriteRuns: 1, minShadowRuns: 5, maxMismatchRate: 0 }),
  }
  const store = createEvolutionSuggestionStore({ dataDir: dir, projectName: () => 'p', cutover })
  const sug = store.propose(eligibleRoutingSuggestion())
  const applied = await store.apply(sug.id, {
    approvedBy: 'alice',
    shadow: { legacy: {}, modular: {} },
    dualWrite: { legacyResult: {}, modularResult: {} },
  })
  assert.equal(applied.status, 'applied')
  assert.equal(
    applied.stateHistory.map((s) => s.status).join('>'),
    'proposed>shadowing>dual_writing>ready>authorized>applied',
  )
})

test('apply refuses when cutover readiness gate fails', async () => {
  const dir = tmpDir()
  const cutover = {
    recordShadowComparison: async () => ({ id: 'sh_1' }),
    recordDualWrite: async () => ({ id: 'dw_1' }),
    cutoverReadiness: () => ({ ready: false, reason: 'mismatch too high', mismatchRate: 0.3 }),
  }
  const store = createEvolutionSuggestionStore({ dataDir: dir, projectName: () => 'p', cutover })
  const sug = store.propose(eligibleRoutingSuggestion())
  await assert.rejects(
    () => store.apply(sug.id, { approvedBy: 'alice', shadow: {}, dualWrite: {} }),
    (e) => e.code === 'NOT_READY',
  )
  assert.equal(store.get(sug.id).status, 'ready')
})
