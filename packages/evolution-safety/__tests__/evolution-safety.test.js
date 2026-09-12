const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createCheckpoint,
  createSafetyModule,
  detectRegressions,
  planRollback,
  validateProposal,
} = require('../index.js')

test('validates proposals with deterministic policy checks', () => {
  const decision = validateProposal({
    proposal: {
      id: 'prop-1',
      title: 'unsafe publish',
      riskLevel: 'high',
      steps: ['publish package', 'delete old state'],
    },
    policy: { maxRiskLevel: 'medium', blockedTerms: ['delete', 'publish'] },
  })

  assert.equal(decision.approved, false)
  assert.deepEqual(decision.violations.map((v) => v.code), ['risk.too_high', 'term.blocked'])
})

test('detects metric regressions against injected thresholds', () => {
  const report = detectRegressions({
    baseline: { tests: 100, latencyMs: 1000, score: 80 },
    current: { tests: 98, latencyMs: 1300, score: 71 },
    thresholds: { tests: 0, latencyMs: 200, score: -5 },
  })

  assert.equal(report.regressed, true)
  assert.deepEqual(report.regressions.map((entry) => entry.metric), ['tests', 'latencyMs', 'score'])
})

test('creates checkpoints and rollback plans without mutating the host', () => {
  const checkpoint = createCheckpoint({
    id: 'cp-1',
    project: 'akemi-mio',
    files: ['packages/mio-cli/bin/mio.js'],
    metadata: { branch: 'master' },
  })
  const rollback = planRollback({ checkpoint, reason: 'validation failed' })

  assert.equal(checkpoint.schemaVersion, 1)
  assert.equal(rollback.requiresHostCapability, true)
  assert.deepEqual(rollback.files, ['packages/mio-cli/bin/mio.js'])
  assert.match(rollback.instructions[0], /Restore checkpoint cp-1/)
})

test('safety module persists checkpoints through an injected store and emits decisions', () => {
  const records = []
  const events = []
  const module = createSafetyModule({
    checkpointStore: { append: (record) => records.push(record) },
    eventBus: { emit: (type, payload) => events.push({ type, payload }) },
  })

  const checkpoint = module.checkpoint({ project: 'akemi-mio', files: ['a.js'] })
  const decision = module.validate({ proposal: { riskLevel: 'low', steps: ['change a.js'] } })

  assert.equal(records.length, 1)
  assert.equal(records[0].id, checkpoint.id)
  assert.equal(decision.approved, true)
  assert.equal(events[0].type, 'safety.checkpoint_created')
  assert.equal(events[1].type, 'safety.proposal_validated')
})
