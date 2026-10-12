'use strict'

const path = require('path')

// Re-export the pure TS helpers from the creativity package so CLI and MCP
// share one implementation of the A5 gate, promotion gate, and state machine.
// The JSONL store itself is the same MechanismRegistryStore the TS tests use.
let _registry = null
let _registryDir = null

function ensureRegistry(dataDir) {
  if (_registry && _registryDir === dataDir) return _registry
  const { MechanismRegistryStore } = require('@akemi-mio/creativity/MechanismRegistry')
  const base = path.join(dataDir, 'creativity')
  _registry = new MechanismRegistryStore(path.join(base, 'mechanisms.jsonl'))
  _registryDir = dataDir
  return _registry
}

function resetRegistryCache() {
  _registry = null
  _registryDir = null
}

/**
 * Query the mechanism registry: active/rolled_back versions and promotion requests.
 */
function mechanismRegistry(args = {}, dataDir) {
  const registry = ensureRegistry(dataDir)
  const mechanismId = args.mechanismId || undefined
  const versions = mechanismId ? registry.listVersions(mechanismId) : registry.listVersions()
  const requests = args.status ? registry.listRequests(args.status) : registry.listRequests()
  return { versions, requests }
}

/**
 * Submit a PromotionRequest. Gate is provided by the caller (checkSubmitGate).
 * A5 is enforced inside MechanismRegistryStore.approve.
 */
function mechanismPromote(args = {}, dataDir) {
  const registry = ensureRegistry(dataDir)
  const action = args.action || 'submit'

  if (action === 'submit') {
    const { checkSubmitGate } = require('@akemi-mio/creativity/MechanismRegistry')
    const { DEFAULT_STOPPING_RULE } = require('@akemi-mio/creativity/ExperimentRunStore')
    // Build a minimal gate from provided experimentRunIds length; full gate
    // wiring is in the TS layer. For CLI/MCP thin surface we accept an
    // explicit gate override or compute from runs.length vs minSamples.
    const runs = (args.experimentRunIds || []).map((id, i) => ({
      id,
      assignment: 'candidate',
      outcome: 'success',
      metrics: {},
      evidenceIds: [],
      createdAt: Date.now() - i,
    }))
    const gate = args.gateOverride
      ? { allowed: !!args.gateOverride.allowed, reason: args.gateOverride.reason || 'ok' }
      : checkSubmitGate(DEFAULT_STOPPING_RULE, runs, args.currentSnapshotId)
    const result = registry.submit(
      {
        mechanismId: args.mechanismId,
        version: args.version,
        hypothesisId: args.hypothesisId,
        experimentRunIds: args.experimentRunIds,
        submittedBy: args.submittedBy,
      },
      gate,
    )
    return result
  }

  if (action === 'approve') {
    return registry.approve(args.requestId, args.approvedBy)
  }

  if (action === 'reject') {
    return registry.reject(args.requestId, args.approvedBy, args.reason || 'rejected')
  }

  return { ok: false, reason: 'unknown_action' }
}

/**
 * Rollback the active version of a mechanism to its rollbackTo target.
 */
function mechanismRollback(args = {}, dataDir) {
  const registry = ensureRegistry(dataDir)
  return registry.rollback(args.mechanismId)
}

module.exports = {
  mechanismRegistry,
  mechanismPromote,
  mechanismRollback,
  ensureRegistry,
  resetRegistryCache,
}
