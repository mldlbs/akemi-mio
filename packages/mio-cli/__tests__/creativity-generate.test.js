'use strict'

// Tests for `mio creativity generate` / `ferment` -- the LLM-backed write side
// of the creativity engine.
//
// There is no LLM key on a dev machine, so the engine is driven with a stubbed
// chatJson here. That proves the real code path (prompt -> parse -> novelty
// check -> persist) rather than just the argument plumbing. The CLI-level tests
// at the bottom only cover argument validation, because running `generate`
// through a spawned process would hit the network.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(repoRoot, 'packages', 'mio-cli', 'bin', 'mio.js')
const { CreativityEngine } = require('../server/creativity-engine.js')

function workspace(label) {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-gen-' + label + '-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-gen-cwd-'))
  return { mioHome, cwd, env: { ...process.env, MIO_HOME: mioHome } }
}

function hypothesesFile(ws) {
  return path.join(ws.mioHome, 'creativity', 'creativity-hypotheses.jsonl')
}

function readHypotheses(ws) {
  const file = hypothesesFile(ws)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function engineWith(ws, stub) {
  return new CreativityEngine(path.join(ws.mioHome, 'creativity'), stub)
}

// Answers like the hosted endpoint: { data: {...} } on success.
function llmReturning(payload) {
  return async () => ({ data: payload })
}

function twoSources() {
  return [
    { name: 'auth', content: 'token rotation' },
    { name: 'cache', content: 'write-through cache' },
  ]
}

test('generate persists hypotheses produced by the LLM', async () => {
  const ws = workspace('gen')
  const idea = {
    title: 'Rotate tokens through the cache layer',
    idea: 'Combine rotation with write-through invalidation',
    expectedBenefit: 'no stale credentials',
    risk: 'cache coherency',
    novelty: 70,
    feasibility: 60,
    impact: 80,
  }
  const engine = engineWith(ws, llmReturning(idea))

  const result = await engine.generate(twoSources(), 'explore')
  assert.equal(result.ideas.length >= 1, true, 'at least one hypothesis generated')
  assert.equal(result.strategy, 'explore')

  const stored = readHypotheses(ws)
  assert.equal(stored.length, result.ideas.length)
  assert.equal(stored[0].title, idea.title)
  assert.equal(stored[0].status, 'active')
  assert.equal(stored[0].sourceLabels.length, 2, 'records which concepts were combined')
  // A combo row is written alongside so the pair is not re-explored.
  assert.equal(fs.existsSync(path.join(ws.mioHome, 'creativity', 'creativity-combos.jsonl')), true)
})

test('generate needs at least two sources and never calls the LLM otherwise', async () => {
  const ws = workspace('gen-one')
  let calls = 0
  const engine = engineWith(ws, async () => {
    calls += 1
    return { data: { title: 'x' } }
  })

  const result = await engine.generate([{ name: 'auth', content: 'token rotation' }])
  assert.deepEqual(result.ideas, [])
  assert.equal(result.reason, 'need at least 2 sources')
  assert.equal(calls, 0, 'no LLM call is made for an impossible request')
  assert.equal(fs.existsSync(hypothesesFile(ws)), false)
})

test('generate rejects a missing sources array with a usable message', async () => {
  // The MCP entry calls generate(args.sources, args.strategy), so an omitted
  // argument used to reach .map() and surface as "Cannot read properties of
  // undefined", which names neither the tool nor the missing field.
  const ws = workspace('gen-noarray')
  const engine = engineWith(ws, async () => ({ data: { title: 'x' } }))

  await assert.rejects(
    () => engine.generate(undefined),
    /requires sources/,
  )
  await assert.rejects(
    () => engine.generate('not-an-array'),
    /requires sources/,
  )
})

test('generate skips a pair when the LLM call fails', async () => {
  const ws = workspace('gen-fail')
  const engine = engineWith(ws, async () => ({ error: 'HTTP 500' }))

  const result = await engine.generate(twoSources())
  assert.deepEqual(result.ideas, [])
  assert.equal(fs.existsSync(hypothesesFile(ws)), false, 'nothing persisted on failure')
})

test('ferment updates an active hypothesis and records the verdict', async () => {
  const ws = workspace('ferment')
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  const seed = {
    id: 'h1',
    title: 'Original title',
    idea: 'original idea',
    status: 'active',
    novelty: 70,
    feasibility: 70,
    impact: 70,
    sourceLabels: ['auth', 'cache'],
    createdAt: Date.now(),
  }
  fs.writeFileSync(path.join(dir, 'creativity-hypotheses.jsonl'), JSON.stringify(seed) + '\n', 'utf8')

  const engine = engineWith(ws, llmReturning({
    title: 'Refined title',
    idea: 'refined idea',
    expectedBenefit: 'b',
    risk: 'r',
    novelty: 80,
    feasibility: 75,
    impact: 85,
    verdict: 'promote',
    reason: 'scores improved',
  }))

  const result = await engine.ferment(5)
  assert.equal(result.fermented, 1)
  assert.equal(result.results[0].verdict, 'promote')

  const stored = readHypotheses(ws)
  assert.equal(stored.length, 1)
  // promote + total score 240 > 200 -> validated
  assert.equal(stored[0].status, 'validated')
  assert.equal(stored[0].title, 'Refined title')
  assert.equal(stored[0].fermentCount, 1)
  assert.equal(typeof stored[0].fermentedAt, 'number')
})

test('ferment reports nothing to do when the store is empty', async () => {
  const ws = workspace('ferment-empty')
  const engine = engineWith(ws, llmReturning({ verdict: 'keep' }))
  const result = await engine.ferment(5)
  assert.equal(result.fermented, 0)
  assert.equal(result.reason, 'no fermentable hypotheses')
})

// ── CLI level: argument validation only (a real run would need the network) ──

function run(ws, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ws.cwd, encoding: 'utf8', env: ws.env })
}

test('CLI generate rejects fewer than two sources before calling an LLM', () => {
  const ws = workspace('cli-gen')

  const none = run(ws, ['creativity', 'generate'])
  assert.equal(none.status, 1)
  assert.match(none.stderr, /at least two --source/)

  const one = run(ws, ['creativity', 'generate', '--source', 'auth|token rotation'])
  assert.equal(one.status, 1)
  assert.match(one.stderr, /at least two --source/)

  // Nothing was written and no LLM was involved.
  assert.equal(fs.existsSync(hypothesesFile(ws)), false)
})

test('CLI documents generate and ferment', () => {
  const ws = workspace('cli-usage')
  const help = run(ws, ['creativity', 'help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /mio creativity generate/)
  assert.match(help.stdout, /mio creativity ferment/)
  assert.match(help.stdout, /LLM_API_URL/)
})
