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
  // A combo row is written alongside the hypothesis (history, not a
  // dedup gate — repeat pairs are demoted by the mixer, never skipped).
  assert.equal(fs.existsSync(path.join(ws.mioHome, 'creativity', 'creativity-combos.jsonl')), true)
})

// P3-R5（task 0946ba33）：generate 路径补写 provenance。
test('generate persists provenance with exactly 2 concept origins (passthrough + name: fallback)', async () => {
  const ws = workspace('gen-prov')
  const engine = engineWith(
    ws,
    llmReturning({
      title: 'Provenance pin',
      idea: 'combine two concepts',
      expectedBenefit: 'attributable events',
      risk: 'none',
      novelty: 70,
      feasibility: 60,
      impact: 80,
    }),
  )

  // origin 透传：聚合来源带 memory: provider id
  await engine.generate(
    [
      { name: 'auth', content: 'token rotation', origin: 'memory:mem_a' },
      { name: 'cache', content: 'write-through cache', origin: 'memory:mem_b' },
    ],
    'explore',
  )
  const withOrigin = readHypotheses(ws)[0]
  assert.equal(withOrigin.provenance.sources.length, 2, 'exactly two sources')
  assert.deepEqual(
    withOrigin.provenance.sources.map((s) => s.origin),
    ['memory:mem_a', 'memory:mem_b'],
    'provider origins pass through so isAttributable holds',
  )
  assert.deepEqual(
    withOrigin.provenance.sources.map((s) => s.name),
    ['auth', 'cache'],
    'source names match sourceLabels (pair identity)',
  )
  assert.equal(withOrigin.provenance.strategy, 'explore')
  assert.ok(!Number.isNaN(Date.parse(withOrigin.provenance.generatedAt)), 'generatedAt is ISO 8601')

  // origin 缺失（显式 --source）：回退 name:<name>，与 sourceConceptId 同一身份规则
  const ws2 = workspace('gen-prov-fallback')
  const engine2 = engineWith(
    ws2,
    llmReturning({
      title: 'Fallback origins',
      idea: 'explicit sources',
      expectedBenefit: 'x',
      risk: 'y',
      novelty: 70,
      feasibility: 60,
      impact: 80,
    }),
  )
  await engine2.generate(twoSources(), 'stable')
  const rows = readHypotheses(ws2)
  assert.deepEqual(
    rows[0].provenance.sources.map((s) => s.origin),
    ['name:auth', 'name:cache'],
    'missing origin falls back to name:<name> — the documented concept identity',
  )
})

// P3-R5 验收 #2：generate → ferment promote 至 terminal → pair precision@K 有采样。
test('generate → ferment promote → feedbackStatus reports pair precision@K evaluated > 0', async () => {
  const ws = workspace('gen-prec')
  const idea = {
    title: 'Precise attribution chain',
    idea: 'premise -> mechanism -> outcome',
    expectedBenefit: 'samples',
    risk: 'low',
    novelty: 90,
    feasibility: 80,
    impact: 50, // 90+80+50 = 220 > 200
    logic: 70, // >= 60 → promote gate passes
  }
  const engine = engineWith(ws, async (prompt) => {
    if (String(prompt).includes('Review and refine')) {
      return { data: { ...idea, verdict: 'promote', reason: 'mature' } }
    }
    return { data: idea }
  })

  const gen = await engine.generate(twoSources(), 'explore')
  assert.equal(gen.ideas.length >= 1, true)
  const fer = await engine.ferment()
  assert.equal((fer.errors || []).length, 0, JSON.stringify(fer.errors))
  const stored = readHypotheses(ws)
  assert.equal(stored[0].status, 'validated', 'ferment promote lands on terminal validated')

  const status = engine.feedbackStatus()
  assert.ok(status.generation, 'generation metrics present')
  assert.equal(status.generation.terminalHypotheses >= 1, true)
  assert.ok(status.generation.pairPrecisionAtK !== null, 'precision@K is sampled, not n/a')
  assert.ok(status.generation.evaluatedPairs >= 1, 'at least one top pair evaluated')
  assert.ok(status.snapshot.attributionCoverage > 0, 'ferment event attributes to the concept pair')
  // R5 对称：本链路之外的无 provenance 假设不受影响（见 feedback 测试的
  // hypothesis_only 钉）——这里只断言 generate 自己的假设进入了 pair 空间。
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

// ── R2 收敛：单一 ConceptMixer —— 降权不跳过 / 入口层策略回退 / 空池信号 ──

test('explored pairs are demoted by the mixer, never skipped', async () => {
  // R2 收敛（spec §九）：配对唯一实现是 @akemi-mio/creativity/ConceptMixer，
  // 已探索对罚 15 分参与排序。重复生成仍然到达 LLM——旧语义下同池第四次
  // 调用返回 "all pairs already explored" 且零 LLM 调用，已不复存在。
  const ws = workspace('gen-penalty')
  let calls = 0
  const engine = engineWith(ws, async () => {
    calls += 1
    return {
      data: { title: `Idea ${calls}`, idea: 'chain', expectedBenefit: 'b', risk: 'r', novelty: 70, feasibility: 60, impact: 80 },
    }
  })

  for (const strategy of ['explore', 'signal', 'stable']) {
    const result = await engine.generate(twoSources(), strategy)
    assert.equal(result.ideas.length, 1, `${strategy} still generates from a repeat pair`)
    assert.equal(result.strategy, strategy, 'the requested strategy is reported back')
  }
  assert.equal(calls, 3, 'penalty demotes the pair but never skips the LLM')

  // 换序 = 排序后的同一对（身份对顺序不敏感），同样降权不跳过。
  const reversed = await engine.generate([twoSources()[1], twoSources()[0]], 'explore')
  assert.equal(reversed.ideas.length, 1)
  assert.equal(calls, 4, 'source order does not mint a new pair — and still reaches the LLM')
})

test('pair identity ignores the strategy field: seeded rows demote every strategy', async () => {
  // 旧实现按 (pair, strategy) 分桶硬跳过：带/不带 strategy 字段的记录用不同
  // key 阻断重试。收敛后身份就是排序原始 sourceLabel 对——策略完全不参与，
  // 任何旧记录（含无 strategy 字段的 legacy 行）对任何策略都只是降权。
  const ws = workspace('gen-legacy')
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'creativity-hypotheses.jsonl'),
    [
      JSON.stringify({
        id: 'h-legacy',
        title: 'Seeded before strategies existed',
        idea: 'original',
        status: 'active',
        novelty: 70,
        feasibility: 70,
        impact: 70,
        sourceLabels: ['auth', 'cache'],
        createdAt: Date.now(),
        // no strategy field on purpose
      }),
      JSON.stringify({
        id: 'h-strat',
        title: 'Seeded with one strategy',
        idea: 'original',
        status: 'active',
        novelty: 70,
        feasibility: 70,
        impact: 70,
        sourceLabels: ['auth', 'cache'],
        strategy: 'stable',
        createdAt: Date.now(),
      }),
    ].join('\n') + '\n',
    'utf8'
  )

  let calls = 0
  const engine = engineWith(ws, async () => {
    calls += 1
    return { data: { title: 'x', idea: 'c', expectedBenefit: 'b', risk: 'r', novelty: 70, feasibility: 60, impact: 80 } }
  })

  for (const strategy of ['explore', 'signal', 'stable']) {
    const result = await engine.generate(twoSources(), strategy)
    assert.equal(result.ideas.length, 1, `seeded rows demote but do not block ${strategy}`)
  }
  assert.equal(calls, 3, 'no seeded record skips the LLM for any strategy')
})

test('entry-layer strategy fallback keeps homogeneous pools pairing', async () => {
  // mixer 的 explore 只配跨类型、signal 要求 provocation/insight/failure 来源：
  // 同质池（两个 knowledge）直接配出 0 对。入口层回退（先例 idea-generate.js
  // "cross-type explore only when two types exist"）保证两者仍配对；回退只喂
  // mixer——返回的 strategy、prompt 框架与温度仍按请求值。
  const ws = workspace('gen-fallback')
  let calls = 0
  const engine = engineWith(ws, async () => {
    calls += 1
    return { data: { title: `Idea ${calls}`, idea: 'chain', expectedBenefit: 'b', risk: 'r', novelty: 70, feasibility: 60, impact: 80 } }
  })

  const exp = await engine.generate(twoSources(), 'explore')
  assert.equal(exp.ideas.length, 1, 'explore falls back to same-type pairing on a homogeneous pool')
  assert.equal(exp.strategy, 'explore')

  const sig = await engine.generate(twoSources(), 'signal')
  assert.equal(sig.ideas.length, 1, 'signal falls back too — this pool has no signal-typed source')
  assert.equal(sig.strategy, 'signal')
  assert.equal(calls, 2)
})

test('stable on an all-distinct-type pool reports no candidate pairs', async () => {
  // stable 不回退：三类互异的来源配不出同类型对 → 空池信号（新文案），调用方
  // 据此切换策略（文档化 "409 -> retry" 契约的承接者），且不触 LLM。
  const ws = workspace('gen-stable-empty')
  let calls = 0
  const engine = engineWith(ws, async () => {
    calls += 1
    return { data: { title: 'x', idea: 'c', expectedBenefit: 'b', risk: 'r', novelty: 70, feasibility: 60, impact: 80 } }
  })
  const sources = [
    { name: 'auth', content: 'token rotation', type: 'knowledge' },
    { name: 'cache', content: 'write-through', type: 'behavior' },
    { name: 'drift', content: 'latency crept up', type: 'insight' },
  ]

  const result = await engine.generate(sources, 'stable')
  assert.deepEqual(result.ideas, [])
  assert.equal(result.strategy, 'stable')
  assert.equal(result.pairsAvailable, 0)
  assert.match(result.reason, /no candidate pairs for strategy "stable"/)
  assert.match(result.reason, /3 sources, 3 candidate pairs/)
  assert.equal(calls, 0, 'an infeasible strategy never reaches the LLM')

  // 同一池子切回 explore 即可行：三对全跨类型，重试是真实验。
  const ok = await engine.generate(sources, 'explore')
  assert.equal(ok.pairsAttempted, 3)
  assert.equal(calls, 3, 'the retry with another strategy does reach the LLM (one call per pair)')
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
    logic: 70,
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

test('ferment promote/reject append feedback events; keep and merge do not', async () => {
  // 正向反馈闭环 P0：终局状态（validated/rejected）才产证据事件；
  // keep/merge 不是终局质量结论。sourceId 按 ferment 轮次确定 → 同轮重放幂等。
  const ws = workspace('ferment-fbe')
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'creativity-hypotheses.jsonl'),
    [
      JSON.stringify({ id: 'h-promote', title: 'P', idea: 'i', status: 'active', novelty: 80, feasibility: 80, impact: 80, sourceLabels: ['a', 'b'], createdAt: Date.now() }),
      JSON.stringify({ id: 'h-reject', title: 'R', idea: 'i', status: 'active', novelty: 50, feasibility: 50, impact: 50, sourceLabels: ['a', 'b'], createdAt: Date.now() }),
      JSON.stringify({ id: 'h-keep', title: 'K', idea: 'i', status: 'active', novelty: 60, feasibility: 60, impact: 60, sourceLabels: ['a', 'b'], createdAt: Date.now() }),
    ].join('\n') + '\n',
    'utf8'
  )

  // 按 hypothesisId 返回不同 verdict 的 stub
  const engine = engineWith(ws, async (prompt) => {
    if (prompt.includes('h-promote') || prompt.includes('title: P') || prompt.includes('Title: P')) {
      return { data: { title: 'P', idea: 'i', expectedBenefit: 'b', risk: 'r', novelty: 90, feasibility: 90, impact: 90, logic: 80, verdict: 'promote', reason: 'ok' } }
    }
    if (prompt.includes('Title: R')) {
      return { data: { title: 'R', idea: 'i', expectedBenefit: 'b', risk: 'r', novelty: 30, feasibility: 30, impact: 30, logic: 20, verdict: 'reject', reason: 'broken chain' } }
    }
    return { data: { title: 'K', idea: 'i', expectedBenefit: 'b', risk: 'r', novelty: 60, feasibility: 60, impact: 60, logic: 60, verdict: 'keep', reason: 'fine' } }
  })

  // 上面的 stub 按 Title 匹配——ferment prompt 用 Title: 行
  const result = await engine.ferment(10)
  assert.equal(result.fermented, 3)

  const feedbackPath = path.join(dir, 'feedback-events.jsonl')
  assert.ok(fs.existsSync(feedbackPath), 'feedback-events.jsonl created')
  const events = fs.readFileSync(feedbackPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byHyp = Object.fromEntries(events.map((e) => [e.hypothesisId, e]))
  assert.equal(byHyp['h-promote'] && byHyp['h-promote'].eventType, 'validated')
  assert.equal(byHyp['h-promote'].sourceType, 'experiment')
  assert.equal(byHyp['h-reject'] && byHyp['h-reject'].eventType, 'rejected')
  assert.equal(byHyp['h-keep'], undefined, 'keep produces no feedback event')
  assert.equal(events.length, 2, 'only terminal verdicts produce events')

  // sourceId 按轮次确定 → 同一轮重放（同 key）在 JSONL 幂等层 dedup
  const again = engine.feedbackEvents.append({
    hypothesisId: 'h-promote',
    eventType: 'validated',
    sourceType: 'experiment',
    sourceId: byHyp['h-promote'].sourceId,
  })
  assert.equal(again.appended, false)
  assert.equal(again.deduped, true)
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

test('ferment promote cannot waive the logic gate by omitting the field', async () => {
  // The old gate skipped whenever the review left logic out, so a reviewer
  // that simply forgot the field promoted anything. Now it falls back to
  // the stored score (50 when the record predates the dimension).
  const ws = workspace('ferment-logic-omitted')
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'creativity-hypotheses.jsonl'),
    JSON.stringify({
      id: 'h1',
      title: 'Untouched idea',
      idea: 'original idea',
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
    // no logic field at all
    verdict: 'promote',
    reason: 'looks mature',
  }))

  await engine.ferment(5)
  const stored = readHypotheses(ws)
  assert.equal(stored[0].status, 'active', 'missing logic falls back to 50 and fails the gate')
  assert.equal(stored[0].logic, 50, 'the neutral fallback is recorded on the hypothesis')
})

test('generate clamps hostile LLM scores and truncates overlong titles', async () => {
  // Math.max(0, 'high') is NaN: it used to be persisted as-is and then
  // poisoned (novelty + feasibility + impact) > 200 with NaN > 200 === false.
  const ws = workspace('gen-clamp')
  const engine = engineWith(ws, llmReturning({
    title: 'T'.repeat(80),
    idea: 'a long enough idea body',
    expectedBenefit: 'b',
    risk: 'r',
    novelty: 'high',
    feasibility: 120,
    impact: -5,
    logic: 'abc',
  }))

  const result = await engine.generate(twoSources())
  assert.equal(result.ideas.length, 1)
  const stored = readHypotheses(ws)
  assert.equal(stored[0].title.length, 60, 'title is bounded to 60 chars')
  // FR: novelty now comes from @akemi-mio/creativity/NoveltyScorer (the inline
  // +5 clean bonus is gone) — NaN still coerces to the 50 fallback, as-is.
  assert.equal(stored[0].novelty, 50, 'NaN coerces to the 50 fallback (package scorer has no +5 bonus)')
  assert.equal(stored[0].feasibility, 100, 'out-of-range high clamps to 100')
  assert.equal(stored[0].impact, 0, 'negative clamps to 0')
  assert.equal(stored[0].logic, 50, 'non-numeric logic falls back to 50 instead of NaN')
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

// ── 正向反馈闭环 P2：CLI 生成端消费预装配的结构化快照块 ──

test('generate renders the structured feedback block without raw event text', () => {
  const ws = workspace('cli-fbe-block')
  const engine = engineWith(ws, async () => ({ data: [] }))
  const block = {
    version: 'snap1',
    verified: [
      {
        pairKey: 'memory:a|memory:b',
        conceptA: 'memory:a',
        conceptB: 'memory:b',
        dimension: 'quality',
        evidenceCount: 2,
        posteriorBand: 'high',
        confidenceBand: 'medium',
        scope: '多批次独立验证',
        limits: '尚未验证跨场景泛化',
      },
    ],
    failures: [],
  }
  const withBlock = engine._buildGenerationPrompt({ name: 'A', content: 'a' }, { name: 'B', content: 'b' }, 'explore', [], [], block)
  assert.match(withBlock, /历史反馈/)
  assert.match(withBlock, /快照 v/)
  assert.doesNotMatch(withBlock, /idempotencyKey/)
  assert.doesNotMatch(withBlock, /sourceId/)

  const withoutBlock = engine._buildGenerationPrompt({ name: 'A', content: 'a' }, { name: 'B', content: 'b' }, 'explore', [], [])
  assert.doesNotMatch(withoutBlock, /历史反馈/)
})

// ── 正向反馈闭环 P3：受控启用模式门控 ──

test('feedback runtime gating: off unchanged, shadow observes without applying, full applies', async () => {
  const ws = workspace('p3-mode')
  const dir = path.join(ws.mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  const seed = () =>
    fs.writeFileSync(
      path.join(dir, 'creativity-hypotheses.jsonl'),
      JSON.stringify({
        id: 'h1',
        title: 't',
        idea: 'i',
        status: 'active',
        novelty: 60,
        feasibility: 60,
        impact: 60,
        sourceLabels: ['A', 'B'],
        provenance: { sources: [{ name: 'A', origin: 'memory:a' }, { name: 'B', origin: 'memory:b' }] },
        createdAt: Date.now(),
      }) + '\n',
      'utf8',
    )
  seed()

  const captured = []
  const engine = engineWith(ws, async (prompt) => {
    captured.push(prompt)
    return {
      data: {
        title: 'T',
        idea: 'i'.repeat(40),
        expectedBenefit: 'b',
        risk: 'r',
        novelty: 60,
        feasibility: 60,
        impact: 60,
        logic: 60,
        sourceLabels: ['A', 'B'],
        relevance: 'x'.repeat(20),
      },
    }
  })
  engine.feedbackEvents.append({ hypothesisId: 'h1', eventType: 'validated', sourceType: 'experiment', sourceId: 's1' })

  // 快照来自 h1 的 provenance（memory:a|memory:b）；这里用 C/D 作为待生成来源，
  // 与快照的 pair key 互不相干——调整表只在同 key 时生效（R2 收敛后 explored
  // 只降权不阻断，换源主要是让各阶段输入保持干净）。
  const sources = [
    { name: 'C', content: 'c', type: 'knowledge', weight: 0.8, origin: 'memory:c' },
    { name: 'D', content: 'd', type: 'behavior', weight: 0.7, origin: 'memory:d' },
  ]

  // off：原行为，无反馈段
  captured.length = 0
  let result = await engine.generate(sources, 'explore')
  assert.equal(result.feedback.mode, 'off')
  assert.equal(captured.join('\n').includes('历史反馈'), false)

  // shadow：观测到快照但不应用（每轮重新播种，保持各阶段起点干净）
  seed()
  captured.length = 0
  engine.setFeedbackRuntime({ mode: 'shadow', lambdaClampPct: 0.1, explorationBudget: 0.2, halfLifeDays: 30, canaryFraction: 0.1 })
  result = await engine.generate(sources, 'explore')
  assert.equal(result.feedback.mode, 'shadow')
  assert.ok(result.feedback.pairs > 0, 'shadow observes the snapshot')
  assert.equal(result.feedback.applied, false)
  assert.equal(captured.join('\n').includes('历史反馈'), false)

  // full：应用结构化提示块
  seed()
  captured.length = 0
  engine.setFeedbackRuntime({ mode: 'full', lambdaClampPct: 0.1, explorationBudget: 0.2, halfLifeDays: 30, canaryFraction: 0.1 })
  result = await engine.generate(sources, 'explore')
  assert.equal(result.feedback.mode, 'full')
  assert.equal(result.feedback.applied, true)
  assert.equal(captured.join('\n').includes('历史反馈'), true)
})
