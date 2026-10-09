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
// The generate top-up and idea.generate both reach the engine's chatJson:
// pin the endpoint to a refused address so no test can ever touch a real LLM.
process.env.LLM_API_URL = 'http://127.0.0.1:9/v1/chat/completions'

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

  // One insight seed alone is still one concept — but the local auto sources
  // top it up (the active hypothesis below), so the engine clears the
  // two-source gate, attempts its pair(s), and fails each one against the
  // refused LLM endpoint. That combination proves the seed became a concept
  // without ever touching the network.
  seedHypotheses([hypothesis('b', 'active')])
  const result = await callTool('mio.creativity.generate', { fromInsights: true })
  assert.equal(result.reason, undefined, 'top-up pushed the seed past the two-source gate')
  assert.ok(result.pairsAttempted >= 1)
  assert.deepEqual(result.ideas, [], 'the engine has no template path — refused LLM means no ideas')
  assert.equal(result.errors.length, result.pairsAttempted, 'every attempted pair reports its failure')
})

test('mio.creativity.generate tops a single explicit source up from local data', async () => {
  seedHypotheses([hypothesis('b', 'active')])
  const result = await callTool('mio.creativity.generate', {
    sources: [{ name: 'auth', content: 'token rotation keeps getting hand-rolled' }],
  })
  assert.equal(result.reason, undefined, 'one explicit source + a stored hypothesis clears the gate')
  assert.ok(result.pairsAttempted >= 1)
  assert.deepEqual(result.ideas, [], 'LLM refused in tests; only the gate behaviour is under test')
  assert.equal(result.errors.length, result.pairsAttempted)
})

test('mio.idea.generate registers the goal schema', () => {
  const tool = TOOLS.find((t) => t.name === 'mio.idea.generate')
  assert.ok(tool, 'the tool is registered')
  assert.deepEqual(tool.inputSchema.required, ['goal'])
  assert.ok(tool.inputSchema.properties.goal)
  assert.ok(tool.inputSchema.properties.numIdeas)
})

test('mio.idea.generate without goal names the missing field', async () => {
  await assert.rejects(() => callTool('mio.idea.generate'), /requires goal/)
  await assert.rejects(() => callTool('mio.idea.generate', { context: 'x' }), /requires goal/)
})

test('mio.idea.generate grounds on memory and persists drafts with provenance', async () => {
  seedHypotheses([])
  fs.writeFileSync(
    path.join(dataDir, 'memory.jsonl'),
    JSON.stringify({
      id: 'g1',
      timestamp: '2026-10-06T01:00:00.000Z',
      kind: 'decision',
      content: '延迟优化的决定：优先降低 MCP 调用延迟',
      scope: 'global',
    }) + '\n',
    'utf8'
  )

  const result = await callTool('mio.idea.generate', { goal: '降低 MCP 调用延迟' })
  assert.ok(result.ideas.length >= 1)
  assert.ok(result.groundedWith >= 1, 'the global decision matched the goal query')
  assert.deepEqual(result.ideas[0].provenance.relatedMemoryIds, ['g1'])
  assert.equal(result.ideas[0].hypothesis.status, 'draft')
  assert.equal(typeof result.persistedIds[0], 'string')
})

test('mio.creativity.adopt requires a hypothesisId', async () => {
  await assert.rejects(
    () => callTool('mio.creativity.adopt'),
    /requires hypothesisId/
  )
  await assert.rejects(
    () => callTool('mio.creativity.adopt', {}),
    /requires hypothesisId/
  )
  await assert.rejects(
    () => callTool('mio.creativity.adopt', { note: 'no id' }),
    /requires hypothesisId/
  )
})

test('mio.creativity.adopt rejects a hypothesis id that is not stored', async () => {
  seedHypotheses([hypothesis('h-1', 'validated')])
  await assert.rejects(
    () => callTool('mio.creativity.adopt', { hypothesisId: 'ghost-id' }),
    /no stored hypothesis with id "ghost-id"/
  )
})

test('mio.creativity.adopt enforces the memory record and its hypothesis tag', async () => {
  seedHypotheses([hypothesis('h-1', 'validated')])

  await assert.rejects(
    () => callTool('mio.creativity.adopt', { hypothesisId: 'h-1', memoryId: 'ghost-memory' }),
    /no memory record with id "ghost-memory"/
  )

  fs.writeFileSync(
    path.join(dataDir, 'memory.jsonl'),
    JSON.stringify({ id: 'm-untagged', tags: ['decision'] }) + '\n',
    'utf8'
  )
  await assert.rejects(
    () => callTool('mio.creativity.adopt', { hypothesisId: 'h-1', memoryId: 'm-untagged' }),
    /missing tag "hypothesis:h-1"/
  )

  // Every rejection above must happen before ingest: no event may exist yet.
  const traceFile = path.join(dataDir, 'traces.jsonl')
  const traces = fs.existsSync(traceFile)
    ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean)
    : []
  assert.equal(
    traces.filter((line) => line.includes('creativity.adopt')).length,
    0,
    'a rejected adoption writes no creativity.adopt event'
  )
})

test('mio.creativity.adopt records exactly one creativity.adopt event and leaves memory untouched', async () => {
  seedHypotheses([hypothesis('h-adopt', 'validated')])
  const memFile = path.join(dataDir, 'memory.jsonl')
  fs.writeFileSync(
    memFile,
    JSON.stringify({ id: 'm-ok', tags: ['hypothesis:h-adopt'] }) + '\n',
    'utf8'
  )
  const memBefore = fs.readFileSync(memFile, 'utf8')
  const traceFile = path.join(dataDir, 'traces.jsonl')
  const tracesBefore = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8') : ''

  const result = await callTool('mio.creativity.adopt', {
    hypothesisId: 'h-adopt',
    memoryId: 'm-ok',
    taskId: 'task-1',
    note: 'shipped in the daily digest',
  })
  assert.equal(result.recorded, true)
  assert.equal(result.hypothesisId, 'h-adopt')

  const appended = fs.readFileSync(traceFile, 'utf8').slice(tracesBefore.length)
  const newLines = appended.split('\n').filter(Boolean)
  assert.equal(newLines.length, 1, 'exactly one event line appended')
  const event = JSON.parse(newLines[0])
  assert.equal(event.event_type, 'creativity.adopt')
  assert.equal(event.outcome, 'success')
  assert.equal(event.trace_id.startsWith('creativity-adopt:h-adopt:'), true)
  assert.equal(event.payload.hypothesisId, 'h-adopt')
  assert.equal(event.payload.memoryId, 'm-ok')
  assert.equal(event.payload.taskId, 'task-1')

  assert.equal(
    fs.readFileSync(memFile, 'utf8'),
    memBefore,
    'adoption writes the trace only, never memory.jsonl'
  )

  // The hypothesis store is read for existence, never mutated by adoption.
  const stored = fs
    .readFileSync(path.join(dataDir, 'creativity', 'creativity-hypotheses.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(stored.length, 1)
  assert.equal(stored[0].status, 'validated', 'adoption does not flip the review status')
})

test('generate and ferment never write Mio memory while adoption is in play', async () => {
  seedHypotheses([hypothesis('b', 'active')])
  const memFile = path.join(dataDir, 'memory.jsonl')
  const keeper = JSON.stringify({ id: 'keep', content: 'x', tags: [] }) + '\n'
  fs.writeFileSync(memFile, keeper, 'utf8')

  await callTool('mio.creativity.generate', {
    sources: [
      { name: 'auth', content: 'token rotation keeps getting hand-rolled' },
      { name: 'cache', content: 'write-through cache is inconsistent' },
    ],
  })
  await callTool('mio.creativity.ferment', { limit: 3 })

  assert.equal(
    fs.readFileSync(memFile, 'utf8'),
    keeper,
    'the generate/ferment write path extends no bytes to memory.jsonl'
  )
})

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  rl.close()
})
