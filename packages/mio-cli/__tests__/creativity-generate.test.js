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
const { CreativityEngine, CreativityStore, sourcesFromInsights } = require('../server/creativity-engine.js')

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

test('generate reports a pair whose LLM call failed instead of dropping it', async () => {
  const ws = workspace('gen-fail')
  const engine = engineWith(ws, async () => ({ error: 'HTTP 500' }))

  const result = await engine.generate(twoSources())
  assert.deepEqual(result.ideas, [])
  assert.equal(result.pairsAttempted, 1)
  assert.equal(result.errors.length, 1, 'the failure is reported, not swallowed')
  assert.deepEqual(result.errors[0].pair, ['auth', 'cache'])
  assert.match(result.errors[0].error, /HTTP 500/)
  assert.equal(fs.existsSync(hypothesesFile(ws)), false, 'nothing persisted on failure')
})

test('generate reports a thrown LLM call with the error message', async () => {
  const ws = workspace('gen-throw')
  const engine = engineWith(ws, async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:11434')
  })

  const result = await engine.generate(twoSources())
  assert.deepEqual(result.ideas, [])
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].error, /ECONNREFUSED/)
})

test('generate succeeds for one pair and still reports the others failing', async () => {
  const ws = workspace('gen-partial')
  let call = 0
  const idea = {
    title: 'Only one pair made it',
    idea: 'combine A and B',
    expectedBenefit: 'b',
    risk: 'r',
    novelty: 70,
    feasibility: 60,
    impact: 80,
  }
  const engine = engineWith(ws, async () => {
    call += 1
    return call === 1 ? { data: idea } : { error: 'HTTP 503' }
  })

  // Three sources produce three pairs, so one success and two failures are
  // distinguishable from "everything worked" and from "nothing worked".
  const sources = [
    { name: 'auth', content: 'token rotation' },
    { name: 'cache', content: 'write-through cache' },
    { name: 'queue', content: 'backpressure' },
  ]
  const result = await engine.generate(sources)
  assert.equal(result.pairsAttempted, 3)
  assert.equal(result.ideas.length, 1)
  assert.equal(result.errors.length, 2)
  assert.equal(readHypotheses(ws).length, 1)
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

test('ferment promotes on the refined scores, not the stale pre-review ones', async () => {
  // The gate used to read the OLD totals, so a review that raised an idea
  // over the bar (or dropped one under it) changed nothing about the verdict.
  const ws = workspace('ferment-newscore')
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  // Old total: 60+50+50 = 160 (would fail the >200 gate on stale scores)
  fs.writeFileSync(
    path.join(dir, 'creativity-hypotheses.jsonl'),
    JSON.stringify({
      id: 'h1',
      title: 'Weak draft',
      idea: 'original idea',
      status: 'active',
      novelty: 60,
      feasibility: 50,
      impact: 50,
      sourceLabels: ['auth', 'cache'],
      createdAt: Date.now(),
    }) + '\n',
    'utf8'
  )

  const engine = engineWith(ws, llmReturning({
    novelty: 80,
    feasibility: 75,
    impact: 85, // new total 240 > 200
    logic: 70,
    verdict: 'promote',
    reason: 'review strengthened it',
  }))

  await engine.ferment(5)
  const stored = readHypotheses(ws)
  assert.equal(stored[0].status, 'validated', 'refined scores decide the gate')
  assert.equal(stored[0].novelty, 80)
})

test('ferment promote requires logic >= 60 when the review rescored it', async () => {
  const ws = workspace('ferment-logic')
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'creativity-hypotheses.jsonl'),
    JSON.stringify({
      id: 'h1',
      title: 'Pretty but incoherent',
      idea: 'handwavy chain',
      status: 'active',
      novelty: 90,
      feasibility: 90,
      impact: 90,
      sourceLabels: ['a', 'b'],
      createdAt: Date.now(),
    }) + '\n',
    'utf8'
  )

  const engine = engineWith(ws, llmReturning({
    novelty: 90,
    feasibility: 90,
    impact: 90,
    logic: 30, // tight scores but a broken causal chain
    verdict: 'promote',
    reason: 'sounds good',
  }))

  await engine.ferment(5)
  const stored = readHypotheses(ws)
  assert.equal(stored[0].status, 'active', 'a failing logic gate must not validate')
  assert.equal(stored[0].logic, 30, 'the review still records its rescore')
})

test('ferment merge folds the idea into the named target and marks it merged', async () => {
  const ws = workspace('ferment-merge')
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  const rows = [
    {
      id: 'h1',
      title: 'Duplicate angle',
      idea: 'take one',
      status: 'active',
      novelty: 70,
      feasibility: 70,
      impact: 70,
      sourceLabels: ['a', 'b'],
      createdAt: Date.now(),
    },
    {
      id: 'h2',
      title: 'Canonical idea',
      idea: 'take two',
      status: 'active',
      novelty: 70,
      feasibility: 70,
      impact: 70,
      sourceLabels: ['c', 'd'],
      createdAt: Date.now(),
    },
  ]
  fs.writeFileSync(
    path.join(dir, 'creativity-hypotheses.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  )

  // First review merges h1 into h2; h2's own review is a plain keep so the
  // target's absorbed content is not overwritten by the same canned reply.
  let call = 0
  const engine = engineWith(ws, async () => {
    call += 1
    return call === 1
      ? { data: { verdict: 'merge', mergeWithId: 'h2', idea: 'combined into one', reason: 'two takes of the same idea' } }
      : { data: { verdict: 'keep', reason: 'already canonical' } }
  })

  const result = await engine.ferment(10)
  const mergeResult = result.results.find((r) => r.id === 'h1')
  assert.equal(mergeResult.verdict, 'merge')

  const stored = readHypotheses(ws)
  const reviewed = stored.find((h) => h.id === 'h1')
  const target = stored.find((h) => h.id === 'h2')
  assert.equal(reviewed.status, 'merged', 'the folded-away side is marked merged')
  assert.equal(reviewed.mergedInto, 'h2')
  assert.match(target.idea, /combined into one/, 'the target absorbs the reviewed idea')
  assert.match(target.idea, /take two/, 'and keeps its own content')
})

test('ferment reports an unresolvable merge as keep, never as a merge that did not happen', async () => {
  const ws = workspace('ferment-merge-miss')
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'creativity-hypotheses.jsonl'),
    JSON.stringify({
      id: 'h1',
      title: 'Orphan merge',
      idea: 'original',
      status: 'active',
      novelty: 70,
      feasibility: 70,
      impact: 70,
      sourceLabels: ['a', 'b'],
      createdAt: Date.now(),
    }) + '\n',
    'utf8'
  )

  const engine = engineWith(ws, llmReturning({
    verdict: 'merge',
    mergeWithId: 'no-such-id',
    reason: 'misremembered the id',
  }))

  const result = await engine.ferment(5)
  assert.equal(result.results[0].verdict, 'keep', 'an unresolvable target degrades to keep')
  const stored = readHypotheses(ws)
  assert.equal(stored[0].status, 'active')
})

test('generate scores the logic dimension and defaults it when absent', async () => {
  const ws = workspace('gen-logic')
  const base = {
    title: 'A titled idea',
    idea: 'premise -> mechanism -> outcome',
    expectedBenefit: 'b',
    risk: 'r',
    novelty: 70,
    feasibility: 60,
    impact: 80,
  }

  const engine = engineWith(ws, llmReturning({ ...base, logic: 85 }))
  await engine.generate(twoSources(), 'explore')
  let stored = readHypotheses(ws)
  assert.equal(stored[0].logic, 85)

  // A reviewer/model that does not know the field still gets a neutral value
  // instead of undefined (which would poison score arithmetic downstream).
  const ws2 = workspace('gen-logic-default')
  const engine2 = engineWith(ws2, llmReturning({ ...base }))
  await engine2.generate(twoSources(), 'explore')
  const stored2 = readHypotheses(ws2)
  assert.equal(stored2[0].logic, 50)
})

test('ferment reports nothing to do when the store is empty', async () => {
  const ws = workspace('ferment-empty')
  const engine = engineWith(ws, llmReturning({ verdict: 'keep' }))
  const result = await engine.ferment(5)
  assert.equal(result.fermented, 0)
  assert.equal(result.reason, 'no fermentable hypotheses')
})

test('ferment surfaces a failing review instead of reporting "nothing to do"', async () => {
  const ws = workspace('ferment-fail')
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'creativity-hypotheses.jsonl'),
    JSON.stringify({
      id: 'h1',
      title: 'Needs a review',
      idea: 'original idea',
      status: 'draft',
      novelty: 70,
      feasibility: 70,
      impact: 70,
      sourceLabels: ['auth', 'cache'],
      createdAt: Date.now(),
    }) + '\n',
    'utf8'
  )

  const engine = engineWith(ws, async () => ({ error: 'HTTP 500' }))
  const result = await engine.ferment(5)

  assert.equal(result.fermented, 0)
  assert.equal(result.errors.length, 1, 'an outage must not read as an empty store')
  assert.equal(result.errors[0].id, 'h1')
  assert.match(result.errors[0].error, /HTTP 500/)
  assert.equal(readHypotheses(ws)[0].fermentCount, undefined, 'nothing was persisted')
})

test('the store re-reads a hypothesis file another process changed', () => {
  // The MCP server is long-running while `mio creativity generate` writes from
  // a separate process. Latching the parsed array forever is exactly the stale
  // cache bug insight-store.js fixed in 0ba7fa8.
  const ws = workspace('stale')
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'creativity-hypotheses.jsonl')
  const row = (id) =>
    JSON.stringify({
      id,
      title: 'Hypothesis ' + id,
      idea: 'combine A and B',
      status: 'active',
      novelty: 60,
      feasibility: 50,
      impact: 70,
      sourceLabels: ['A', 'B'],
      createdAt: Date.now(),
    })

  fs.writeFileSync(file, row('h1') + '\n', 'utf8')
  const store = new CreativityStore(dir)
  assert.equal(store.getHypotheses().length, 1)

  fs.appendFileSync(file, row('h2') + '\n', 'utf8')
  assert.equal(store.getHypotheses().length, 2, 'external write invalidates the cache')

  fs.writeFileSync(file, row('h3') + '\n', 'utf8')
  assert.equal(store.getHypotheses().length, 1, 'an external rewrite is picked up too')
})

// ── fromInsights: seeding concept sources from stored insights ──

test('sourcesFromInsights maps stored insights to concept sources, best first', () => {
  const insights = [
    { id: 'i1', title: 'Low value', description: 'meh', score: 0.2, evidence: [] },
    {
      id: 'i2',
      title: 'High value',
      description: 'the cache is thrashing',
      score: 0.9,
      evidence: ['slow queries'],
    },
  ]

  const sources = sourcesFromInsights(insights)
  assert.equal(sources.length, 2)
  assert.equal(sources[0].name, 'High value', 'highest score seeds the first concept')
  assert.equal(sources[0].type, 'insight')
  assert.match(sources[0].content, /thrashing/)
  assert.match(sources[0].content, /slow queries/, 'evidence travels with the description')

  assert.deepEqual(sourcesFromInsights(undefined), [])
  assert.deepEqual(sourcesFromInsights([]), [])
  assert.equal(
    sourcesFromInsights(insights, 1).length,
    1,
    'the cap keeps one busy insight run from exploding into LLM calls'
  )
})

test('generate consumes sources built from insights', async () => {
  const ws = workspace('gen-insight')
  const idea = {
    title: 'Seeded from an insight',
    idea: 'combine two observations',
    expectedBenefit: 'b',
    risk: 'r',
    novelty: 65,
    feasibility: 55,
    impact: 75,
  }
  const engine = engineWith(ws, llmReturning(idea))

  const result = await engine.generate(sourcesFromInsights([
    { id: 'i1', title: 'auth', description: 'token rotation', score: 0.8 },
    { id: 'i2', title: 'cache', description: 'write-through', score: 0.7 },
  ]))
  assert.equal(result.ideas.length, 1)
  assert.deepEqual(result.ideas[0].sourceLabels, ['auth', 'cache'])
  assert.equal(result.errors.length, 0)
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
  assert.match(help.stdout, /--from-insights/, 'the seed flag is discoverable from help')
  assert.match(help.stdout, /--limit 0/, 'the default-20 / limit-0 contract is discoverable')
})

test('CLI generate --from-insights refuses to run without usable seeds', () => {
  const ws = workspace('cli-seed')
  const out = run(ws, ['creativity', 'generate', '--from-insights'])
  assert.equal(out.status, 1)
  // Either @akemi-mio/insight is missing or the store is empty; both must name
  // the flag rather than falling through to the generic "needs two sources".
  assert.match(out.stderr, /from-insights/)
  assert.equal(fs.existsSync(hypothesesFile(ws)), false, 'nothing is written when seeding fails')
})

test('CLI generate --from-insights still needs two concepts in total', (t) => {
  const { isInsightAvailable } = require('../server/insight-store.js')
  if (!isInsightAvailable()) return t.skip('@akemi-mio/insight is not installed here')

  const ws = workspace('cli-seed-one')
  const dir = path.join(ws.mioHome, 'insights')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'insights.json'),
    JSON.stringify({
      version: 1,
      insights: [
        {
          id: 'i1',
          detector: 'friction',
          title: 'auth',
          description: 'token rotation',
          evidence: [],
          score: 0.9,
          confidence: 0.8,
          createdAt: Date.now(),
        },
      ],
      reportedIds: [],
    }),
    'utf8'
  )

  const out = run(ws, ['creativity', 'generate', '--from-insights'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /at least 2 concept sources/)
  assert.equal(fs.existsSync(hypothesesFile(ws)), false)
})
