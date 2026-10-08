'use strict'

// `mio.idea.generate` core (spec Capability 1): goal-driven, grounded on Mio
// memory, local sources auto-assembled, novelty-gated against stored
// hypotheses, every candidate persisted with provenance — all offline here
// (the LLM stub refuses, so templates carry the run).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runIdeaGenerate, groundingFrom } = require('../server/idea-generate.js')
const { CreativityStore } = require('../server/creativity-engine.js')

const LLM_DOWN = async () => {
  throw new Error('ECONNREFUSED 127.0.0.1:9')
}

function workspace() {
  const mioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-idea-'))
  const dir = path.join(mioHome, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  return { mioHome, dir, store: new CreativityStore(dir), file: path.join(dir, 'creativity-hypotheses.jsonl') }
}

function readRows(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
}

test('returns the spec response shape and persists drafts with provenance', async () => {
  const ws = workspace()
  const res = await runIdeaGenerate({
    goal: '降低 MCP 调用延迟',
    context: '观察到近三天 p95 上升',
    constraints: ['不引入新依赖'],
    chatJson: LLM_DOWN,
    store: ws.store,
  })
  assert.ok(res.ideas.length >= 1)
  assert.equal(typeof res.generatedAt, 'string')
  assert.equal(res.groundedWith, 0)
  assert.equal(res.persistedIds.length, res.ideas.length)

  const idea = res.ideas[0]
  assert.ok(idea.title.length > 0)
  assert.equal(typeof idea.novelty, 'number')
  assert.equal(idea.hypothesis.id, res.persistedIds[0])
  assert.equal(idea.hypothesis.status, 'draft')
  assert.ok(idea.experiment.steps.length > 0)
  // every source is knowledge here → stable fallback pairing, never a silent
  // explore run that mixes zero cross-type combos
  assert.equal(idea.provenance.strategy, 'stable')
  assert.equal(idea.provenance.technique, idea.hypothesis.technique)
  const labels = new Set(idea.hypothesis.sourceLabels)
  for (const s of idea.provenance.sources) assert.ok(labels.has(s.name))

  const rows = readRows(ws.file)
  assert.equal(rows.length, res.persistedIds.length)
  assert.equal(rows[0].provenance.generatedAt, res.generatedAt)
  // spec: drafts live in CreativityStore, never in Mio memory
  assert.equal(fs.existsSync(path.join(ws.mioHome, 'memory.jsonl')), false)
})

test('grounding memory flows into sources, ids, groundedWith and strategy', async () => {
  const ws = workspace()
  const grounding = groundingFrom({
    count: 2,
    results: [
      { id: 'mem_a', timestamp: '2026-10-06T01:00:00.000Z', kind: 'decision', content: '决定把 MCP 调用延迟优先优化', project: 'p', scope: 'project' },
      { id: 'mem_b', timestamp: '2026-10-06T02:00:00.000Z', kind: 'note', content: '延迟优化周报：本周无回归' },
    ],
  })
  assert.deepEqual(grounding.relatedMemoryIds, ['mem_a', 'mem_b'])
  assert.equal(grounding.groundedWith, 2)

  const res = await runIdeaGenerate({
    goal: '降低 MCP 调用延迟',
    chatJson: LLM_DOWN,
    store: ws.store,
    groundingSources: grounding.sources,
    relatedMemoryIds: grounding.relatedMemoryIds,
  })
  assert.equal(res.groundedWith, 2)
  assert.ok(res.ideas.length >= 1)
  assert.deepEqual(res.ideas[0].provenance.relatedMemoryIds, ['mem_a', 'mem_b'])
  // knowledge goal + feedback memory → cross-type pairs exist → explore
  assert.equal(res.ideas[0].provenance.strategy, 'explore')
  assert.ok(res.ideas[0].provenance.sources.some((s) => s.origin === 'memory:mem_a'))
})

test('numIdeas clamps to 1..3 whatever the caller asks for', async () => {
  const ws = workspace()
  const auto = [
    { name: 'extra-a', content: '第一份本地补充材料，内容足够长以通过门禁', type: 'knowledge', weight: 0.8 },
    { name: 'extra-b', content: '第二份本地补充材料，内容同样足够长以通过门禁', type: 'knowledge', weight: 0.8 },
  ]
  const many = await runIdeaGenerate({
    goal: '扩大命令覆盖',
    context: 'README 命令块与 help 保持一致',
    numIdeas: 99,
    chatJson: LLM_DOWN,
    store: ws.store,
    autoSources: auto,
  })
  assert.ok(many.ideas.length >= 1)
  assert.ok(many.ideas.length <= 3, 'clamped even when the caller asks for 99')

  const one = await runIdeaGenerate({
    goal: '扩大命令覆盖',
    context: 'README 命令块与 help 保持一致',
    numIdeas: 1,
    chatJson: LLM_DOWN,
    store: ws.store,
    autoSources: auto,
  })
  assert.equal(one.ideas.length, 1)
})

test('near-duplicates of a rejected hypothesis are rejected with a reason', async () => {
  const ws = workspace()
  const fixed = {
    title: '固定标题用于重复检测',
    idea: '这段想法文本足够长，用来验证与已拒绝假设之间的近似重复门禁确实生效。',
    expectedBenefit: 'b',
    risk: 'r',
    novelty: 70,
    feasibility: 60,
    impact: 70,
    relevance: 'goal 与 context 通过约束注入机制协同',
    sourceLabels: [],
  }
  const stub = async () => ({ data: [fixed] })

  const first = await runIdeaGenerate({ goal: 'x', context: 'y', chatJson: stub, store: ws.store })
  assert.equal(first.ideas[0].hypothesis.status, 'draft')

  const rows = readRows(ws.file)
  rows[0].status = 'rejected'
  fs.writeFileSync(ws.file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const store2 = new CreativityStore(ws.dir)
  const second = await runIdeaGenerate({ goal: 'x', context: 'y', chatJson: stub, store: store2 })
  const hit = second.ideas.find((i) => i.title === fixed.title)
  assert.equal(hit.hypothesis.status, 'rejected')
  assert.match(hit.hypothesis.rejectionReason, /已拒绝假设/)
  assert.ok(second.persistedIds.includes(hit.hypothesis.id), 'rejects are persisted too — they feed later dedup')
})

test('answers with a reason instead of throwing when there is only one source', async () => {
  const ws = workspace()
  const res = await runIdeaGenerate({ goal: 'lonely', chatJson: LLM_DOWN, store: ws.store })
  assert.equal(res.ideas, undefined)
  assert.match(res.reason, /at least 2/)
  assert.equal(fs.existsSync(ws.file), false)
})
