'use strict'

const path = require('node:path')

function requireWorkspacePackage(name, fallbackPath) {
  try {
    return require(name)
  } catch (error) {
    if (!error || error.code !== 'MODULE_NOT_FOUND') throw error
    return require(fallbackPath)
  }
}

const { EventBus, createLogger } = requireWorkspacePackage(
  '@akemi-mio/runtime-foundation',
  path.resolve(__dirname, '..', 'runtime-foundation'),
)

const SCHEMA_VERSION = 1
const MODULE_NAME = '@akemi-mio/evolution-scheduler'
const MODULE_VERSION = '0.1.0'

function taskCost(task) {
  return Number.isFinite(task.estimatedCost) ? Math.max(0, task.estimatedCost) : 1
}

function isCoolingDown(task, now) {
  if (!Number.isFinite(task.lastRunAt) || !Number.isFinite(task.cooldownMs)) return false
  return now - task.lastRunAt < task.cooldownMs
}

function createSchedulePlan(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const maxCost = input.budget && Number.isFinite(input.budget.maxCost) ? Math.max(0, input.budget.maxCost) : Infinity
  let remainingBudget = maxCost
  const selected = []
  const skipped = []
  const tasks = [...(Array.isArray(input.tasks) ? input.tasks : [])].sort((left, right) => {
    const priorityDelta = (Number(right.priority) || 0) - (Number(left.priority) || 0)
    if (priorityDelta !== 0) return priorityDelta
    return String(left.id || '').localeCompare(String(right.id || ''))
  })

  for (const task of tasks) {
    if (isCoolingDown(task, now)) {
      skipped.push({ task, reason: 'cooldown' })
      continue
    }
    const cost = taskCost(task)
    if (cost > remainingBudget) {
      skipped.push({ task, reason: 'budget' })
      continue
    }
    selected.push(task)
    remainingBudget -= cost
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    selected,
    skipped,
    remainingBudget: Number.isFinite(remainingBudget) ? remainingBudget : null,
  }
}

function createReplayPlan(input = {}) {
  const events = Array.isArray(input.events) ? input.events : []
  const afterCursor = input.afterCursor || null
  const startIndex = afterCursor ? events.findIndex((event) => event && event.id === afterCursor) + 1 : 0
  const replayEvents = events.slice(Math.max(0, startIndex))
  const last = replayEvents[replayEvents.length - 1]
  return {
    schemaVersion: SCHEMA_VERSION,
    afterCursor,
    events: replayEvents,
    nextCursor: last ? last.id || null : afterCursor,
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stableValue(value[key])
      return acc
    }, {})
  }
  return value
}

function valuesEqual(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
}

function diffValues(legacy, modular, prefix = '') {
  if (valuesEqual(legacy, modular)) return []
  if (!legacy || !modular || typeof legacy !== 'object' || typeof modular !== 'object') {
    return [{ path: prefix || '$', legacy, modular }]
  }
  if (Array.isArray(legacy) || Array.isArray(modular)) {
    return [{ path: prefix || '$', legacy, modular }]
  }
  const keys = [...new Set([...Object.keys(legacy), ...Object.keys(modular)])].sort()
  const diffs = []
  for (const key of keys) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key
    diffs.push(...diffValues(legacy[key], modular[key], nextPrefix))
  }
  return diffs
}

async function runPath(runner, input, label) {
  if (!runner || typeof runner.run !== 'function') throw new TypeError(`${label} runner with run(input) is required`)
  return runner.run(input)
}

async function runShadowComparison(input = {}) {
  const eventBus = input.eventBus || new EventBus()
  const legacy = await runPath(input.legacy, input.input || {}, 'legacy')
  const modular = await runPath(input.modular, input.input || {}, 'modular')
  const diffs = typeof input.compare === 'function'
    ? input.compare(legacy, modular)
    : diffValues(legacy, modular)
  const result = {
    schemaVersion: SCHEMA_VERSION,
    mode: 'shadow',
    matched: diffs.length === 0,
    diffs,
    legacy,
    modular,
  }
  if (typeof eventBus.emit === 'function') {
    eventBus.emit('scheduler.shadow_compared', { matched: result.matched, diffs: diffs.length })
  }
  return result
}

async function writePath(writer, record, label) {
  if (!writer || typeof writer.write !== 'function') throw new TypeError(`${label} writer with write(record) is required`)
  return writer.write(record)
}

function createDualWriteRunner(dependencies = {}) {
  const authoritative = dependencies.authoritative === 'modular' ? 'modular' : 'legacy'
  const legacyWriter = dependencies.legacyWriter
  const modularWriter = dependencies.modularWriter

  return {
    async write(record) {
      const primaryLabel = authoritative
      const shadowLabel = authoritative === 'legacy' ? 'modular' : 'legacy'
      const primaryWriter = authoritative === 'legacy' ? legacyWriter : modularWriter
      const shadowWriter = authoritative === 'legacy' ? modularWriter : legacyWriter
      const result = await writePath(primaryWriter, record, primaryLabel)
      let shadowResult = null
      let shadowError = null
      try {
        shadowResult = await writePath(shadowWriter, record, shadowLabel)
      } catch (error) {
        shadowError = error && error.message ? error.message : String(error)
      }
      const diffs = shadowError ? [{ path: '$error', legacy: authoritative === 'legacy' ? null : shadowError, modular: authoritative === 'legacy' ? shadowError : null }] : diffValues(result, shadowResult)
      return {
        schemaVersion: SCHEMA_VERSION,
        mode: 'dual-write',
        authoritative,
        result,
        shadow: {
          target: shadowLabel,
          result: shadowResult,
          error: shadowError,
          matched: !shadowError && diffs.length === 0,
          diffs,
        },
      }
    },
  }
}

function assessCutoverReadiness(input = {}) {
  const shadowRuns = Array.isArray(input.shadowRuns) ? input.shadowRuns : []
  const dualWriteRuns = Array.isArray(input.dualWriteRuns) ? input.dualWriteRuns : []
  const minShadowRuns = Number.isFinite(input.minShadowRuns) ? input.minShadowRuns : 5
  const maxMismatchRate = Number.isFinite(input.maxMismatchRate) ? input.maxMismatchRate : 0
  const shadowMismatches = shadowRuns.filter((run) => !run || run.matched !== true).length
  const dualWriteFailures = dualWriteRuns.filter((run) => !run || !run.shadow || run.shadow.matched !== true).length
  const mismatchRate = shadowRuns.length > 0 ? shadowMismatches / shadowRuns.length : 1
  const reasons = []

  if (shadowRuns.length < minShadowRuns) reasons.push(`shadow samples ${shadowRuns.length}/${minShadowRuns}`)
  if (mismatchRate > maxMismatchRate) reasons.push(`shadow mismatch rate ${mismatchRate}`)
  if (dualWriteRuns.length === 0) reasons.push('dual-write has no samples')
  if (dualWriteFailures > 0) reasons.push(`dual-write failures ${dualWriteFailures}`)

  let status = 'pass'
  if (shadowMismatches > 0 || dualWriteFailures > 0) status = 'fail'
  if (reasons.some((reason) => reason.startsWith('shadow samples') || reason === 'dual-write has no samples')) {
    status = status === 'fail' ? 'fail' : 'hold'
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    shadowRuns: shadowRuns.length,
    dualWriteRuns: dualWriteRuns.length,
    shadowMismatches,
    dualWriteFailures,
    mismatchRate,
    reasons,
  }
}

function createStateMigrationPlan(input = {}) {
  const legacyRecords = Array.isArray(input.legacyRecords) ? input.legacyRecords : []
  const modularRecords = Array.isArray(input.modularRecords) ? input.modularRecords : []
  const identity = typeof input.identity === 'function' ? input.identity : (record) => record && record.id
  const transform = typeof input.transform === 'function' ? input.transform : (record) => record
  const modularById = new Map()
  const unchanged = []
  const toCreate = []
  const conflicts = []

  for (const record of modularRecords) {
    const id = identity(record)
    if (id !== undefined && id !== null) modularById.set(String(id), record)
  }

  for (const legacyRecord of legacyRecords) {
    const id = identity(legacyRecord)
    if (id === undefined || id === null) continue
    const key = String(id)
    const migrated = transform(legacyRecord)
    if (!modularById.has(key)) {
      toCreate.push(migrated)
      continue
    }
    const modularRecord = modularById.get(key)
    if (valuesEqual(migrated, modularRecord)) {
      unchanged.push(migrated)
    } else {
      conflicts.push({ id: key, legacy: migrated, modular: modularRecord, diffs: diffValues(migrated, modularRecord) })
    }
  }

  const legacyIds = new Set(legacyRecords.map(identity).filter((id) => id !== undefined && id !== null).map(String))
  const extra = modularRecords.filter((record) => {
    const id = identity(record)
    return id !== undefined && id !== null && !legacyIds.has(String(id))
  })

  return {
    schemaVersion: SCHEMA_VERSION,
    ready: conflicts.length === 0,
    unchanged,
    toCreate,
    extra,
    conflicts,
    summary: {
      legacy: legacyRecords.length,
      modular: modularRecords.length,
      unchanged: unchanged.length,
      toCreate: toCreate.length,
      extra: extra.length,
      conflicts: conflicts.length,
    },
  }
}

function createAuthoritySwitchPlan(input = {}) {
  const readiness = input.readiness || {}
  const from = input.from || 'legacy'
  const to = input.to || 'modular'
  const approved = readiness.status === 'pass'
  const blockers = approved ? [] : Array.isArray(readiness.reasons) && readiness.reasons.length > 0 ? readiness.reasons : [`cutover readiness is ${readiness.status || 'unknown'}`]
  return {
    schemaVersion: SCHEMA_VERSION,
    approved,
    from,
    to,
    blockers,
    actions: approved
      ? [
          { type: 'set_authority', from, to },
          { type: 'keep_fallback', target: from },
          { type: 'monitor_cutover', target: to },
        ]
      : [],
  }
}

function createAuthoritySwitchDryRun(input = {}) {
  if (input.dryRun !== true) {
    throw new Error('authority switch apply is dry-run only; pass dryRun: true to preview planned actions')
  }
  const plan = input.plan && typeof input.plan === 'object' ? input.plan : {}
  const approved = plan.approved === true
  const blockers = Array.isArray(plan.blockers) ? plan.blockers : []
  return {
    schemaVersion: SCHEMA_VERSION,
    dryRun: true,
    applied: false,
    status: approved ? 'ready' : 'blocked',
    project: input.project || null,
    from: plan.from || 'legacy',
    to: plan.to || 'modular',
    blockers: approved ? [] : blockers,
    actions: approved && Array.isArray(plan.actions) ? plan.actions : [],
  }
}

function createPipelineRunner(dependencies = {}) {
  const collectors = Array.isArray(dependencies.collectors) ? dependencies.collectors : []
  const executor = dependencies.executor || null
  const eventBus = dependencies.eventBus || new EventBus()
  const logger = dependencies.logger || createLogger('mio-scheduler')

  function emit(type, payload) {
    try {
      eventBus.emit(type, payload)
    } catch (error) {
      logger.warn('failed to emit scheduler event', { error: error && error.message ? error.message : String(error) })
    }
  }

  return {
    async runOnce(input = {}) {
      emit('scheduler.pipeline_started', { collectors: collectors.length })
      const tasks = []
      for (const collector of collectors) {
        if (!collector || typeof collector.collect !== 'function') continue
        const collected = await collector.collect(input)
        if (Array.isArray(collected)) tasks.push(...collected)
      }
      const schedule = createSchedulePlan({ ...input, tasks })
      const executed = []
      if (executor && typeof executor.execute === 'function') {
        for (const task of schedule.selected) {
          executed.push(await executor.execute(task, input))
        }
      }
      const result = { schemaVersion: SCHEMA_VERSION, schedule, executed, skipped: schedule.skipped }
      emit('scheduler.pipeline_finished', { collected: tasks.length, executed: executed.length, skipped: schedule.skipped.length })
      return result
    },
  }
}

function createSchedulerModule(dependencies = {}) {
  return {
    name: MODULE_NAME,
    version: MODULE_VERSION,
    createSchedulePlan,
    createReplayPlan,
    createPipelineRunner: (overrides = {}) => createPipelineRunner({ ...dependencies, ...overrides }),
    runShadowComparison,
    createDualWriteRunner,
    assessCutoverReadiness,
    createStateMigrationPlan,
    createAuthoritySwitchPlan,
    createAuthoritySwitchDryRun,
  }
}

module.exports = {
  SCHEMA_VERSION,
  MODULE_NAME,
  MODULE_VERSION,
  createSchedulePlan,
  createReplayPlan,
  createPipelineRunner,
  runShadowComparison,
  createDualWriteRunner,
  assessCutoverReadiness,
  createStateMigrationPlan,
  createAuthoritySwitchPlan,
  createAuthoritySwitchDryRun,
  createSchedulerModule,
}
