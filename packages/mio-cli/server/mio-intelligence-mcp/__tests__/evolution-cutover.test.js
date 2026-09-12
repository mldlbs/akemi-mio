'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-mcp-cutover-'))
process.env.MIO_DATA_DIR = dataDir
process.env.MIO_CONTEXT = JSON.stringify({
  agentId: 'codex',
  project: 'test-cutover',
  workspace: '/tmp/test',
  sessionId: 'test-cutover',
})

const { TOOLS, callTool, rl, readJsonl } = require('../index.js')

test.after(() => { rl.close() })

test('mcp records shadow comparisons and reports cutover readiness', async () => {
  assert.ok(TOOLS.some((tool) => tool.name === 'mio.evolution.shadow.record'))
  assert.ok(TOOLS.some((tool) => tool.name === 'mio.evolution.cutover.readiness'))

  await callTool('mio.evolution.shadow.record', {
    label: 'status parity 1',
    project: 'test-cutover',
    legacy: { modules: 7 },
    modular: { modules: 7 },
  })
  await callTool('mio.evolution.shadow.record', {
    label: 'status parity 2',
    project: 'test-cutover',
    legacy: { modules: 7 },
    modular: { modules: 7 },
  })
  await callTool('mio.evolution.dual_write.record', {
    label: 'memory dual write',
    project: 'test-cutover',
    authoritative: 'legacy',
    legacyResult: { id: 'a', ok: true },
    modularResult: { id: 'a', ok: true },
  })

  const readiness = await callTool('mio.evolution.cutover.readiness', {
    project: 'test-cutover',
    minShadowRuns: 2,
  })

  assert.equal(readiness.status, 'pass')
  assert.equal(readiness.shadowRuns, 2)
  assert.equal(readiness.dualWriteRuns, 1)
  assert.equal(readJsonl(path.join(dataDir, 'evolution_shadow.jsonl')).length, 2)
})

test('mcp keeps cutover on hold when samples diverge or are missing', async () => {
  await callTool('mio.evolution.shadow.record', {
    label: 'status mismatch',
    project: 'mismatch-project',
    legacy: { modules: 6 },
    modular: { modules: 7 },
  })

  const readiness = await callTool('mio.evolution.cutover.readiness', {
    project: 'mismatch-project',
    minShadowRuns: 2,
  })

  assert.equal(readiness.status, 'fail')
  assert.ok(readiness.reasons.some((reason) => reason.includes('shadow samples')))
})

test('mcp returns migration and authority switch plans without applying cutover', async () => {
  assert.ok(TOOLS.some((tool) => tool.name === 'mio.evolution.migration.plan'))
  assert.ok(TOOLS.some((tool) => tool.name === 'mio.evolution.authority.plan'))

  const migration = await callTool('mio.evolution.migration.plan', {
    legacyRecords: [{ id: 'mem-1', value: 'old' }],
    modularRecords: [],
  })
  const authority = await callTool('mio.evolution.authority.plan', {
    readiness: { status: 'pass', reasons: [] },
    from: 'legacy',
    to: 'modular',
  })

  assert.equal(migration.ready, true)
  assert.deepEqual(migration.toCreate.map((record) => record.id), ['mem-1'])
  assert.equal(authority.approved, true)
  assert.deepEqual(authority.actions.map((action) => action.type), [
    'set_authority',
    'keep_fallback',
    'monitor_cutover',
  ])
})

test('mcp cutover apply is dry-run only and does not switch authority', async () => {
  assert.ok(TOOLS.some((tool) => tool.name === 'mio.evolution.cutover.apply'))

  await assert.rejects(
    () => callTool('mio.evolution.cutover.apply', {
      dryRun: false,
      plan: { approved: true, from: 'legacy', to: 'modular', actions: [] },
    }),
    /dryRun: true/,
  )

  const result = await callTool('mio.evolution.cutover.apply', {
    dryRun: true,
    project: 'test-cutover',
    plan: {
      approved: true,
      from: 'legacy',
      to: 'modular',
      actions: [{ type: 'set_authority', from: 'legacy', to: 'modular' }],
    },
  })

  assert.equal(result.applied, false)
  assert.equal(result.dryRun, true)
  assert.equal(result.project, 'test-cutover')
  assert.deepEqual(result.actions, [{ type: 'set_authority', from: 'legacy', to: 'modular' }])
})
