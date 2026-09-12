const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildReflectionSummary,
  createLearningModule,
  evaluateAnalysis,
} = require('../index.js')

test('evaluates analysis with deterministic dimensions and recommendations', () => {
  const result = evaluateAnalysis({
    strategyName: 'review',
    promptMode: 'minimal',
    analysisMode: 'diagnostic',
    analysisSummary: 'A short answer that repeats runtime module boundaries.',
    planCreated: true,
    planSteps: ['Update packages/evolution-learning/index.js', 'Run packages/evolution-learning/__tests__/evolution-learning.test.js'],
    recentHistory: ['A short answer that repeats runtime module boundaries in the same way.'],
  })

  assert.equal(result.schemaVersion, 1)
  assert.equal(result.strategyName, 'review')
  assert.equal(result.dimensions.planQuality, 95)
  assert.equal(result.dimensions.strategyCompliance, 95)
  assert.ok(result.score > 0)
  assert.ok(result.feedback.includes('analysis overlaps recent history; explore a new angle'))
})

test('builds reflection summaries from tool outcomes without requiring an llm', () => {
  const summary = buildReflectionSummary({
    toolResults: [
      { name: 'read-plan', success: true, latencyMs: 20 },
      { name: 'run-tests', success: false, error: 'expected module to exist', latencyMs: 5100 },
    ],
  })

  assert.match(summary, /2 tool calls: 1 succeeded, 1 failed/)
  assert.match(summary, /run-tests: expected module to exist/)
  assert.match(summary, /run-tests was slow/)
})

test('learning module records evaluation evidence and linked experience through injected memory', () => {
  const writes = { evidence: [], experiences: [] }
  const memory = {
    recordEvidence(record) {
      const stored = { id: `ev-${writes.evidence.length + 1}`, ...record }
      writes.evidence.push(stored)
      return stored
    },
    recordExperience(record) {
      const stored = { id: `xp-${writes.experiences.length + 1}`, ...record }
      writes.experiences.push(stored)
      return stored
    },
  }
  const events = []
  const eventBus = { emit: (type, payload) => events.push({ type, payload }) }
  const module = createLearningModule({ memory, eventBus, clock: () => 123 })

  const learned = module.learnFromEvaluation({
    project: 'akemi-mio',
    agent: 'codex',
    task: 'runtime modularization',
    evaluation: evaluateAnalysis({
      strategyName: 'balanced',
      promptMode: 'full',
      analysisMode: 'implementation',
      analysisSummary: 'The runtime learning package should stay portable and use injected memory adapters.',
      planCreated: true,
      planSteps: ['Create packages/evolution-learning/index.js'],
      recentHistory: [],
    }),
  })

  assert.equal(writes.evidence.length, 1)
  assert.equal(writes.evidence[0].kind, 'evaluation')
  assert.equal(writes.evidence[0].project, 'akemi-mio')
  assert.equal(writes.experiences.length, 1)
  assert.deepEqual(writes.experiences[0].evidenceIds, ['ev-1'])
  assert.equal(learned.evidence.id, 'ev-1')
  assert.equal(learned.experience.id, 'xp-1')
  assert.equal(events[0].type, 'learning.evaluation_recorded')
})

test('learning module can use an injected llm for reflection when requested', async () => {
  const calls = []
  const module = createLearningModule({
    llm: {
      complete(prompt) {
        calls.push(prompt)
        return Promise.resolve('llm reflection')
      },
    },
  })

  const result = await module.reflect({
    task: 'summarize failing checks',
    useLlm: true,
    toolResults: [{ name: 'check', success: false, error: 'boom' }],
  })

  assert.equal(result.source, 'llm')
  assert.equal(result.summary, 'llm reflection')
  assert.equal(calls.length, 1)
  assert.match(calls[0], /summarize failing checks/)
})
