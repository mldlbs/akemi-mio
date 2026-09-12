const test = require('node:test')
const assert = require('node:assert/strict')

const contracts = require('../index.js')

test('creates and normalizes runtime events with a stable schema', () => {
  const event = contracts.createRuntimeEvent({
    type: contracts.EVENT_TYPES.TASK_COMPLETED,
    project: 'akemi-mio',
    agent: 'codex',
    payload: { summary: 'done' },
  })

  assert.equal(event.schemaVersion, contracts.SCHEMA_VERSION)
  assert.equal(event.type, contracts.EVENT_TYPES.TASK_COMPLETED)
  assert.equal(event.project, 'akemi-mio')
  assert.equal(event.agent, 'codex')
  assert.equal(event.payload.summary, 'done')
  assert.match(event.id, /^evt_[a-z0-9-]+$/)
  assert.equal(contracts.normalizeRuntimeEvent({ ...event, extra: true }).extra, undefined)
})

test('rejects malformed runtime events and creates evidence records', () => {
  assert.throws(() => contracts.createRuntimeEvent({ type: '' }), /type/i)
  assert.throws(() => contracts.createRuntimeEvent({ type: 'unknown' }), /type/i)

  const evidence = contracts.createEvidence({
    source: 'test',
    content: 'A useful observation',
    project: 'akemi-mio',
    agent: 'codex',
    tags: ['quality'],
  })
  assert.equal(evidence.kind, contracts.EVIDENCE_KINDS.OBSERVATION)
  assert.deepEqual(evidence.tags, ['quality'])
  assert.match(evidence.id, /^evd_[a-z0-9-]+$/)
})
