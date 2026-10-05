'use strict'

// MCP-layer tests for the mio.creativity.* tools. The engine itself is covered
// by packages/mio-cli/__tests__/creativity-*.test.js; what only exists on this
// side of the boundary is the tool surface -- argument shapes, the documented
// default limit, and fromInsights seeding -- so that is what is pinned here.
// Env must be set before require.

const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-cre-mcp-'))
process.env.MIO_DATA_DIR = dataDir

const { callTool, rl, TOOLS } = require('../index.js')
const { isInsightAvailable } = require('../../insight-store.js')

function hypothesis(id, status) {
  return {
    id,
    title: 'Hypothesis ' + id,
    idea: 'combine A and B',
    status,
    novelty: 60,
    feasibility: 50,
    impact: 70,
    sourceLabels: ['A', 'B'],
    createdAt: Date.now(),
    strategy: 'explore',
  }
}

function seedHypotheses(hypotheses) {
  const dir = path.join(dataDir, 'creativity')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'creativity-hypotheses.jsonl'),
    hypotheses.map((h) => JSON.stringify(h)).join('\n') + '\n',
    'utf8'
  )
}

function seedInsights(insights) {
  const dir = path.join(dataDir, 'insights')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'insights.json'),
    JSON.stringify({ version: 1, insights, reportedIds: [] }),
    'utf8'
  )
}

test('mio.creativity.status counts draft alongside the other states', async () => {
  seedHypotheses([
    hypothesis('a', 'active'),
    hypothesis('b', 'draft'),
    hypothesis('c', 'validated'),
    hypothesis('d', 'rejected'),
  ])

  const result = await callTool('mio.creativity.status')
  assert.equal(result.hypotheses, 4)
  assert.equal(result.active, 1)
  assert.equal(result.validated, 1)
  assert.equal(result.rejected, 1)
  assert.equal(result.draft, 1, 'draft is fermentable, so status must report it')
  assert.equal(result.recentIdeas.length, 1)
})

test('mio.creativity.list returns the newest 20 by default and everything with limit 0', async () => {
  seedHypotheses(Array.from({ length: 25 }, (_, i) => hypothesis(`h${i + 1}`, 'active')))

  const all = await callTool('mio.creativity.list', { limit: 0 })
  assert.equal(all.length, 25)

  const byDefault = await callTool('mio.creativity.list')
  assert.equal(byDefault.length, 20, 'the schema documents Default 20')
  assert.equal(byDefault[0].id, 'h6', 'the default window is the newest rows')
  assert.equal(byDefault[byDefault.length - 1].id, 'h25')
})

test('mio.creativity.list filters by status', async () => {
  seedHypotheses([hypothesis('a', 'draft'), hypothesis('b', 'active')])

  const drafts = await callTool('mio.creativity.list', { status: 'draft', limit: 0 })
  assert.deepEqual(drafts.map((h) => h.id), ['a'])
  assert.equal(drafts[0].status, 'draft')
  assert.equal(typeof drafts[0].score, 'number')
})

test('mio.creativity.generate without sources names the missing field', async () => {
  await assert.rejects(() => callTool('mio.creativity.generate'), /requires sources/)
  await assert.rejects(() => callTool('mio.creativity.generate', {}), /requires sources/)
})

test('the generate schema exposes fromInsights and no longer requires sources', () => {
  const generate = TOOLS.find((t) => t.name === 'mio.creativity.generate')
  assert.ok(generate, 'the tool is registered')
  assert.ok(generate.inputSchema.properties.fromInsights, 'fromInsights is documented')
  const required = generate.inputSchema.required || []
  assert.equal(
    required.includes('sources'),
    false,
    'fromInsights alone is a valid call, so sources cannot stay required'
  )

  const list = TOOLS.find((t) => t.name === 'mio.creativity.list')
  assert.match(list.description, /20/, 'the default limit is stated on the tool itself')
})

test('mio.creativity.generate fromInsights explains an empty insight store', async (t) => {
  if (!isInsightAvailable()) return t.skip('@akemi-mio/insight is not installed here')

  seedInsights([])
  await assert.rejects(
    () => callTool('mio.creativity.generate', { fromInsights: true }),
    /no stored insights/
  )
})

test('mio.creativity.generate fromInsights hands the seed to the engine', async (t) => {
  if (!isInsightAvailable()) return t.skip('@akemi-mio/insight is not installed here')

  seedInsights([
    {
      id: 'i1',
      detector: 'friction',
      title: 'auth is drifting',
      description: 'token rotation keeps getting hand-rolled',
      evidence: ['3 similar memories'],
      score: 0.9,
      confidence: 0.8,
      createdAt: Date.now(),
    },
  ])

  // One seed is one concept, and the engine refuses to call an LLM for a single
  // source -- so this proves the insight actually became a concept without
  // touching the network.
  const result = await callTool('mio.creativity.generate', { fromInsights: true })
  assert.deepEqual(result.ideas, [])
  assert.equal(result.reason, 'need at least 2 sources')
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})
