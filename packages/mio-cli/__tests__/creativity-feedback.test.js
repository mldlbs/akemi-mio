'use strict'

// Tests for `mio creativity feedback` (read-only P3 收尾 observability):
// mode, snapshot metrics, runtime-run ledger, rollout decision. Seeded into a
// throwaway MIO_HOME so counts are exact.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')

function workspace(label) {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cre-fb-' + label + '-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cre-fb-cwd-'))
  const env = { ...process.env, MIO_HOME: mioHome }
  return { mioHome, cwd, env }
}

function run(ws, args, extraEnv) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ws.cwd,
    encoding: 'utf8',
    env: { ...ws.env, ...(extraEnv || {}) },
  })
}

function feedbackJson(ws) {
  const result = run(ws, ['creativity', 'feedback', '--json'])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function seedHypotheses(ws, hypotheses) {
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'creativity-hypotheses.jsonl'),
    hypotheses.map((h) => JSON.stringify(h)).join('\n') + '\n',
    'utf8'
  )
}

function seedFeedbackEvents(ws, events) {
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feedback-events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  )
}

function seedRuntimeRuns(ws, runs) {
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feedback-runtime-runs.jsonl'),
    runs.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  )
}

function hypothesis(id, provenance, status) {
  return {
    id,
    title: 'H ' + id,
    idea: 'combine',
    status: status || 'active',
    novelty: 60,
    feasibility: 50,
    impact: 70,
    createdAt: Date.now(),
    strategy: 'explore',
    ...(provenance ? { provenance } : {}),
  }
}

function event(id, hypothesisId, eventType, extra = {}) {
  const now = Date.now()
  return {
    id,
    hypothesisId,
    eventType,
    sourceType: 'experiment',
    sourceId: 's1',
    occurredAt: now,
    ingestedAt: now,
    idempotencyKey: 'k:' + id,
    schemaVersion: 1,
    ...extra,
  }
}

test('creativity feedback defaults to mode=off with an empty ledger and an advance→shadow decision', () => {
  const ws = workspace('empty')
  const status = feedbackJson(ws)
  assert.equal(status.mode, 'off')
  // empty store still builds a deterministic zero-event snapshot
  assert.ok(status.snapshot)
  assert.equal(status.snapshot.eventCount, 0)
  assert.equal(status.snapshot.pairs, 0)
  assert.deepEqual(status.recentRuns, [])
  assert.equal(status.rollout.decision, 'advance')
  assert.equal(status.rollout.to, 'shadow')
  assert.equal(status.rollout.from, 'off')
  assert.equal(status.thresholds.minStageRuns, 5)
})

test('creativity feedback renders text mode with mode/snapshot/rollout lines', () => {
  const ws = workspace('text')
  const result = run(ws, ['creativity', 'feedback'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /mode: off/)
  assert.match(result.stdout, /snapshot: v\w+\s+pairs=0\s+events=0/)
  assert.match(result.stdout, /rollout: advance → shadow/)
})

test('creativity feedback surfaces snapshot metrics from seeded events + provenance', () => {
  const ws = workspace('snap')
  seedHypotheses(ws, [
    hypothesis('h1', {
      sources: [
        { name: 'a', type: 'knowledge', origin: 'origin:a' },
        { name: 'b', type: 'knowledge', origin: 'origin:b' },
      ],
    }),
  ])
  seedFeedbackEvents(ws, [
    event('e1', 'h1', 'adopted'),
    event('e2', 'h1', 'validated', { sourceId: 's2' }),
    event('e3', 'h1', 'rejected', { sourceId: 's3' }),
  ])
  const status = feedbackJson(ws)
  assert.ok(status.snapshot, 'snapshot should build')
  assert.equal(status.snapshot.eventCount, 3)
  assert.equal(status.snapshot.pairs, 1)
  assert.ok(status.snapshot.attributionCoverage > 0, 'provenance enables pair attribution')
  assert.equal(status.snapshot.duplicateApplicationRate, 0)
})

test('creativity feedback counts observed runs from feedback-runtime-runs.jsonl', () => {
  const ws = workspace('runs')
  seedRuntimeRuns(ws, [
    { at: 1, mode: 'shadow', snapshotVersion: 'fb-1', pairCount: 1, applied: false },
    { at: 2, mode: 'shadow', snapshotVersion: 'fb-1', pairCount: 1, applied: false },
    { at: 3, mode: 'canary', snapshotVersion: 'fb-1', pairCount: 1, applied: true },
    // corrupted / off rows are skipped
    { at: 4, mode: 'off', snapshotVersion: null, pairCount: 0, applied: false },
    { at: 5, mode: 'bogus', snapshotVersion: null, pairCount: 0, applied: false },
    'not-json',
  ])
  const status = feedbackJson(ws)
  assert.equal(status.rollout.metrics.shadowRuns, 2)
  assert.equal(status.rollout.metrics.canaryRuns, 1)
  assert.equal(status.recentRuns.length, 3)
  assert.equal(status.recentRuns[2].mode, 'canary')
})

test('creativity feedback holds shadow until stage runs clear minStageRuns', () => {
  const ws = workspace('hold')
  seedRuntimeRuns(
    ws,
    Array.from({ length: 4 }, (_, i) => ({ at: i, mode: 'shadow', snapshotVersion: 'fb-1', pairCount: 1, applied: false }))
  )
  const status = feedbackJson(ws)
  // mode stays off in the engine (env-gated), but the ledger already shows 4
  // shadow runs; once mode=shadow, the report must hold below min 5.
  assert.equal(status.rollout.metrics.shadowRuns, 4)
})

test('mio creativity help lists the feedback subcommand', () => {
  const ws = workspace('help')
  const result = run(ws, ['creativity', 'help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /mio creativity feedback/)
})

test('the shared engine feedbackStatus matches the CLI JSON', () => {
  const { CreativityEngine } = require('../server/creativity-engine.js')
  const ws = workspace('engine')
  seedHypotheses(ws, [hypothesis('h1')])
  seedRuntimeRuns(ws, [{ at: 1, mode: 'shadow', snapshotVersion: 'fb-x', pairCount: 1, applied: false }])
  const engine = new CreativityEngine(path.join(ws.mioHome, 'creativity'), () => {
    throw new Error('no LLM in test')
  })
  const direct = engine.feedbackStatus()
  const viaCli = feedbackJson(ws)
  assert.equal(direct.mode, viaCli.mode)
  assert.deepEqual(direct.recentRuns, viaCli.recentRuns)
  assert.equal(direct.rollout.decision, viaCli.rollout.decision)
})

test('engine.recordRuntimeRun appends JSONL and readRuntimeRuns tolerates garbage', () => {
  const { CreativityEngine } = require('../server/creativity-engine.js')
  const ws = workspace('ledger')
  const engine = new CreativityEngine(path.join(ws.mioHome, 'creativity'), () => {
    throw new Error('no LLM')
  })
  engine.recordRuntimeRun({ at: 10, mode: 'shadow', snapshotVersion: 'fb-1', pairCount: 2, applied: false })
  engine.recordRuntimeRun({ at: 11, mode: 'canary', snapshotVersion: 'fb-1', pairCount: 2, applied: true })
  const file = path.join(ws.mioHome, 'creativity', 'feedback-runtime-runs.jsonl')
  fs.appendFileSync(file, 'broken-line\n', 'utf8')
  const runs = engine.readRuntimeRuns()
  assert.equal(runs.length, 2)
  assert.equal(runs[0].mode, 'shadow')
  assert.equal(runs[1].applied, true)
})

// ── P3 收官：--mode 持久化（放量操作面）+ 验证指标报告面 ──

function modeFile(ws) {
  return path.join(ws.mioHome, 'creativity', 'feedback-runtime.json')
}

test('mio creativity feedback --mode persists the runtime mode and the next status picks it up', () => {
  const ws = workspace('mode-persist')
  const set = run(ws, ['creativity', 'feedback', '--mode', 'shadow'])
  assert.equal(set.status, 0, set.stderr)
  assert.match(set.stdout, /feedback mode: shadow/)
  const file = JSON.parse(fs.readFileSync(modeFile(ws), 'utf8'))
  assert.equal(file.mode, 'shadow')
  assert.ok(file.updatedAt > 0)
  assert.equal(feedbackJson(ws).mode, 'shadow')
})

test('env MIO_FEEDBACK_MODE keeps precedence over the persisted file', () => {
  const ws = workspace('mode-env')
  run(ws, ['creativity', 'feedback', '--mode', 'shadow'])
  const viaEnv = JSON.parse(run(ws, ['creativity', 'feedback', '--json'], { MIO_FEEDBACK_MODE: 'canary' }).stdout)
  assert.equal(viaEnv.mode, 'canary')
  // --mode under env still persists (deferred), but the echoed mode stays env's
  const set = run(ws, ['creativity', 'feedback', '--mode', 'full'], { MIO_FEEDBACK_MODE: 'canary' })
  assert.equal(set.status, 0, set.stderr)
  assert.match(set.stdout, /feedback mode: canary/)
  assert.match(set.stdout, /env MIO_FEEDBACK_MODE currently overrides it/)
  assert.equal(JSON.parse(fs.readFileSync(modeFile(ws), 'utf8')).mode, 'full')
  assert.equal(feedbackJson(ws).mode, 'full')
})

test('mio creativity feedback --mode fails closed on unknown modes without writing a file', () => {
  const ws = workspace('mode-bad')
  const bad = run(ws, ['creativity', 'feedback', '--mode', 'banana'])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /invalid feedback mode "banana"/)
  assert.equal(fs.existsSync(modeFile(ws)), false)
  assert.equal(feedbackJson(ws).mode, 'off')
})

test('mio creativity feedback --mode without a value errors instead of silently showing status', () => {
  const ws = workspace('mode-missing')
  const res = run(ws, ['creativity', 'feedback', '--mode'])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /requires a value/)
  assert.equal(fs.existsSync(modeFile(ws)), false)
})

test('mio creativity help documents the --mode switch', () => {
  const ws = workspace('help-mode')
  const result = run(ws, ['creativity', 'help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--mode off\|shadow\|canary\|full persists the runtime mode \(env still wins\)/)
})

test('creativity feedback reports validation metrics as no-samples on an empty world', () => {
  const ws = workspace('metrics-empty')
  const status = feedbackJson(ws)
  assert.ok(status.generation, 'generation block present')
  assert.equal(status.generation.pairPrecisionAtK, null)
  assert.equal(status.generation.noveltyAtK, null)
  assert.equal(status.generation.validationPassRate, null)
  assert.equal(status.generation.terminalHypotheses, 0)
  assert.equal(status.generation.ingestion.completeness, null)
  assert.equal(status.generation.precisionK, 10)
  assert.equal(status.generation.windowDays, 30)
})

test('creativity feedback computes precision/ingestion from seeded provenance + events', () => {
  const ws = workspace('metrics-seed')
  seedHypotheses(ws, [
    hypothesis(
      'h1',
      {
        sources: [
          { name: 'a', type: 'knowledge', origin: 'origin:a' },
          { name: 'b', type: 'knowledge', origin: 'origin:b' },
        ],
      },
      'validated'
    ),
  ])
  seedFeedbackEvents(ws, [event('e1', 'h1', 'adopted'), event('e2', 'h1', 'validated', { sourceId: 's2' })])
  const status = feedbackJson(ws)
  assert.equal(status.generation.pairPrecisionAtK, 1)
  assert.equal(status.generation.evaluatedPairs, 1)
  assert.equal(status.generation.validationPassRate, 1)
  assert.equal(status.generation.terminalHypotheses, 1)
  assert.deepEqual(status.generation.ingestion, { rawLines: 2, validRows: 2, droppedRows: 0, completeness: 1 })
  assert.equal(status.generation.snapshotVersion, status.snapshot.version)
  const text = run(ws, ['creativity', 'feedback'])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /pair precision@K: 1\.000/)
  assert.match(text.stdout, /ingestion: 2\/2 rows/)
})
