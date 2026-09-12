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

const { EventBus, createId, createLogger } = requireWorkspacePackage(
  '@akemi-mio/runtime-foundation',
  path.resolve(__dirname, '..', 'runtime-foundation'),
)

const SCHEMA_VERSION = 1
const MODULE_NAME = '@akemi-mio/evolution-safety'
const MODULE_VERSION = '0.1.0'
const RISK_ORDER = { low: 1, medium: 2, high: 3 }

function asStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : []
}

function validateProposal(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('validation input must be an object')
  const proposal = input.proposal || {}
  const policy = input.policy || {}
  const maxRiskLevel = policy.maxRiskLevel || 'high'
  const riskLevel = proposal.riskLevel || 'low'
  const violations = []

  if ((RISK_ORDER[riskLevel] || 0) > (RISK_ORDER[maxRiskLevel] || RISK_ORDER.high)) {
    violations.push({ code: 'risk.too_high', message: `proposal risk ${riskLevel} exceeds ${maxRiskLevel}` })
  }

  const blockedTerms = asStringList(policy.blockedTerms).map((term) => term.toLowerCase())
  if (blockedTerms.length > 0) {
    const text = [proposal.title, proposal.summary, ...asStringList(proposal.steps)].join(' ').toLowerCase()
    const matched = blockedTerms.filter((term) => text.includes(term))
    if (matched.length > 0) {
      violations.push({ code: 'term.blocked', message: `proposal contains blocked term(s): ${matched.join(', ')}` })
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    proposalId: proposal.id || null,
    approved: violations.length === 0,
    riskLevel,
    violations,
  }
}

function lowerIsBetter(metric) {
  return /(latency|duration|time|ms|error|failure|fail)/i.test(metric)
}

function detectRegressions(input = {}) {
  const baseline = input.baseline && typeof input.baseline === 'object' ? input.baseline : {}
  const current = input.current && typeof input.current === 'object' ? input.current : {}
  const thresholds = input.thresholds && typeof input.thresholds === 'object' ? input.thresholds : {}
  const regressions = []

  for (const metric of Object.keys(baseline)) {
    const baseValue = Number(baseline[metric])
    const currentValue = Number(current[metric])
    if (!Number.isFinite(baseValue) || !Number.isFinite(currentValue)) continue
    const delta = currentValue - baseValue
    const threshold = Number.isFinite(Number(thresholds[metric])) ? Number(thresholds[metric]) : 0
    const regressed = lowerIsBetter(metric) ? delta > threshold : delta < threshold
    if (regressed) regressions.push({ metric, baseline: baseValue, current: currentValue, delta, threshold })
  }

  return { schemaVersion: SCHEMA_VERSION, regressed: regressions.length > 0, regressions }
}

function createCheckpoint(input = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id || createId('cp'),
    createdAt: input.createdAt || new Date().toISOString(),
    project: typeof input.project === 'string' ? input.project : null,
    files: asStringList(input.files),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  }
}

function planRollback(input = {}) {
  if (!input.checkpoint || typeof input.checkpoint !== 'object') throw new TypeError('checkpoint is required')
  const checkpoint = input.checkpoint
  const reason = String(input.reason || 'safety validation failed')
  return {
    schemaVersion: SCHEMA_VERSION,
    checkpointId: checkpoint.id,
    reason,
    files: asStringList(checkpoint.files),
    requiresHostCapability: true,
    instructions: [
      `Restore checkpoint ${checkpoint.id} through the host rollback capability.`,
      'Run the verification command that originally guarded the proposal.',
    ],
  }
}

function createSafetyModule(dependencies = {}) {
  const checkpointStore = dependencies.checkpointStore || null
  const eventBus = dependencies.eventBus || new EventBus()
  const logger = dependencies.logger || createLogger('mio-safety')

  function emit(type, payload) {
    try {
      eventBus.emit(type, payload)
    } catch (error) {
      logger.warn('failed to emit safety event', { error: error && error.message ? error.message : String(error) })
    }
  }

  return {
    name: MODULE_NAME,
    version: MODULE_VERSION,
    validate(input) {
      const decision = validateProposal(input)
      emit('safety.proposal_validated', { proposalId: decision.proposalId, approved: decision.approved, violations: decision.violations.length })
      return decision
    },
    detectRegressions,
    checkpoint(input) {
      const checkpoint = createCheckpoint(input)
      if (checkpointStore && typeof checkpointStore.append === 'function') checkpointStore.append(checkpoint)
      emit('safety.checkpoint_created', { checkpointId: checkpoint.id, project: checkpoint.project, files: checkpoint.files.length })
      return checkpoint
    },
    planRollback,
  }
}

module.exports = {
  SCHEMA_VERSION,
  MODULE_NAME,
  MODULE_VERSION,
  validateProposal,
  detectRegressions,
  createCheckpoint,
  planRollback,
  createSafetyModule,
}
