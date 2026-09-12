const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createPipelineRunner,
  createReplayPlan,
  createSchedulePlan,
  createSchedulerModule,
  createDualWriteRunner,
  assessCutoverReadiness,
  createAuthoritySwitchDryRun,
  createAuthoritySwitchPlan,
  createStateMigrationPlan,
  runShadowComparison,
} = require('../index.js')

test('creates a schedule plan with cooldown and budget filtering', () => {
  const plan = createSchedulePlan({
    now: 1000,
    budget: { maxCost: 5 },
    tasks: [
      { id: 'ready', priority: 10, estimatedCost: 3, lastRunAt: 100, cooldownMs: 100 },
      { id: 'cooling', priority: 100, estimatedCost: 1, lastRunAt: 950, cooldownMs: 100 },
      { id: 'expensive', priority: 9, estimatedCost: 4 },
      { id: 'cheap', priority: 8, estimatedCost: 2 },
    ],
  })

  assert.deepEqual(plan.selected.map((task) => task.id), ['ready', 'cheap'])
  assert.deepEqual(plan.skipped.map((entry) => entry.reason), ['cooldown', 'budget'])
  assert.equal(plan.remainingBudget, 0)
})

test('creates a replay plan from events after a cursor', () => {
  const replay = createReplayPlan({
    afterCursor: 'evt-1',
    events: [
      { id: 'evt-1', type: 'task.completed' },
      { id: 'evt-2', type: 'proposal.created' },
      { id: 'evt-3', type: 'task.failed' },
    ],
  })

  assert.deepEqual(replay.events.map((event) => event.id), ['evt-2', 'evt-3'])
  assert.equal(replay.nextCursor, 'evt-3')
})

test('pipeline runner orchestrates collectors and executor without owning host mutations', async () => {
  const calls = []
  const events = []
  const runner = createPipelineRunner({
    eventBus: { emit: (type, payload) => events.push({ type, payload }) },
    collectors: [
      { collect: () => [{ id: 'task-a', priority: 2, estimatedCost: 1 }] },
      { collect: () => [{ id: 'task-b', priority: 1, estimatedCost: 1 }] },
    ],
    executor: {
      execute(task) {
        calls.push(task.id)
        return Promise.resolve({ ok: true, taskId: task.id })
      },
    },
  })

  const result = await runner.runOnce({ budget: { maxCost: 1 } })

  assert.deepEqual(calls, ['task-a'])
  assert.equal(result.executed.length, 1)
  assert.equal(result.skipped.length, 1)
  assert.equal(events[0].type, 'scheduler.pipeline_started')
  assert.equal(events.at(-1).type, 'scheduler.pipeline_finished')
})

test('scheduler module exposes schedule, replay, and pipeline factories', () => {
  const module = createSchedulerModule()

  assert.equal(module.name, '@akemi-mio/evolution-scheduler')
  assert.equal(typeof module.createSchedulePlan, 'function')
  assert.equal(typeof module.createReplayPlan, 'function')
  assert.equal(typeof module.createPipelineRunner, 'function')
  assert.equal(typeof module.runShadowComparison, 'function')
  assert.equal(typeof module.createDualWriteRunner, 'function')
})

test('shadow comparison runs legacy and modular paths and reports deterministic diffs', async () => {
  const events = []
  const result = await runShadowComparison({
    input: { task: 'compare runtime paths' },
    eventBus: { emit: (type, payload) => events.push({ type, payload }) },
    legacy: { run: (input) => ({ decision: 'keep', score: 70, task: input.task }) },
    modular: { run: (input) => ({ decision: 'keep', score: 72, task: input.task }) },
  })

  assert.equal(result.mode, 'shadow')
  assert.equal(result.matched, false)
  assert.deepEqual(result.diffs, [{ path: 'score', legacy: 70, modular: 72 }])
  assert.equal(events[0].type, 'scheduler.shadow_compared')
})

test('dual-write runner writes authoritative and shadow paths and keeps authoritative result', async () => {
  const writes = []
  const runner = createDualWriteRunner({
    authoritative: 'legacy',
    legacyWriter: { write: (record) => { writes.push(['legacy', record.id]); return { ok: true, version: 1 } } },
    modularWriter: { write: (record) => { writes.push(['modular', record.id]); return { ok: true, version: 1 } } },
  })

  const result = await runner.write({ id: 'state-1', value: 'ready' })

  assert.deepEqual(writes, [['legacy', 'state-1'], ['modular', 'state-1']])
  assert.equal(result.authoritative, 'legacy')
  assert.deepEqual(result.result, { ok: true, version: 1 })
  assert.equal(result.shadow.matched, true)
})

test('cutover readiness requires enough successful shadow and dual-write samples', () => {
  const hold = assessCutoverReadiness({
    minShadowRuns: 3,
    shadowRuns: [{ matched: true }, { matched: true }],
    dualWriteRuns: [{ shadow: { matched: true } }],
  })
  const pass = assessCutoverReadiness({
    minShadowRuns: 3,
    shadowRuns: [{ matched: true }, { matched: true }, { matched: true }],
    dualWriteRuns: [{ shadow: { matched: true } }, { shadow: { matched: true } }],
  })
  const fail = assessCutoverReadiness({
    minShadowRuns: 3,
    maxMismatchRate: 0.2,
    shadowRuns: [{ matched: true }, { matched: false }, { matched: false }],
    dualWriteRuns: [{ shadow: { matched: true } }],
  })

  assert.equal(hold.status, 'hold')
  assert.equal(pass.status, 'pass')
  assert.equal(fail.status, 'fail')
})

test('state migration plan compares legacy and modular records without writing state', () => {
  const plan = createStateMigrationPlan({
    legacyRecords: [
      { id: 'same', value: 1 },
      { id: 'missing', value: 2 },
      { id: 'conflict', value: 3 },
    ],
    modularRecords: [
      { id: 'same', value: 1 },
      { id: 'extra', value: 9 },
      { id: 'conflict', value: 4 },
    ],
    identity: (record) => record.id,
  })

  assert.equal(plan.ready, false)
  assert.deepEqual(plan.unchanged.map((entry) => entry.id), ['same'])
  assert.deepEqual(plan.toCreate.map((entry) => entry.id), ['missing'])
  assert.deepEqual(plan.extra.map((entry) => entry.id), ['extra'])
  assert.deepEqual(plan.conflicts.map((entry) => entry.id), ['conflict'])
})

test('authority switch plan requires cutover readiness pass and keeps rollback actions explicit', () => {
  const blocked = createAuthoritySwitchPlan({
    readiness: { status: 'hold', reasons: ['shadow samples 1/5'] },
    from: 'legacy',
    to: 'modular',
  })
  const approved = createAuthoritySwitchPlan({
    readiness: { status: 'pass', reasons: [] },
    from: 'legacy',
    to: 'modular',
  })

  assert.equal(blocked.approved, false)
  assert.deepEqual(blocked.blockers, ['shadow samples 1/5'])
  assert.equal(approved.approved, true)
  assert.deepEqual(approved.actions.map((action) => action.type), [
    'set_authority',
    'keep_fallback',
    'monitor_cutover',
  ])
})

test('authority switch dry run refuses real cutover and returns planned actions only', () => {
  assert.throws(
    () => createAuthoritySwitchDryRun({ dryRun: false, plan: { approved: true } }),
    /dryRun: true/,
  )

  const result = createAuthoritySwitchDryRun({
    dryRun: true,
    project: 'test-cutover',
    plan: {
      approved: true,
      from: 'legacy',
      to: 'modular',
      actions: [
        { type: 'set_authority', from: 'legacy', to: 'modular' },
        { type: 'keep_fallback', target: 'legacy' },
      ],
    },
  })

  assert.equal(result.applied, false)
  assert.equal(result.dryRun, true)
  assert.equal(result.project, 'test-cutover')
  assert.deepEqual(result.actions.map((action) => action.type), ['set_authority', 'keep_fallback'])
})
