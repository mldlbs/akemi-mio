'use strict'

// Evolution suggestion lifecycle store (ADR-017 Evolution plane, Phase 2).
//
// `mio.evolution.report` generates diagnostic suggestions; the `routing`
// suggestion is the one the control plane can act on. This store turns a
// high-confidence routing suggestion into a tracked, gated lifecycle:
//
//   proposed -> shadowing -> dual_writing -> ready -> authorized -> applied
//                                  \-> rejected        \-> expired
//
// `apply` is the only terminal that writes a routing preference
// (routing_preferences.jsonl consumed by task.route in PR3). It requires a
// human authority (`approvedBy`) and, when a cutover backend is injected,
// runs the Evolution gated-rollout primitives (shadow / dual_write /
// readiness) before promoting. Nothing here auto-applies without authority.
//
// Files are append-only; mutable state is recovered by taking the last
// record per id (same pattern as route_events.jsonl).

const path = require('path')
const fs = require('fs')

const PREFERENCE_TTL_MS = 30 * 86400000 // 30 days

const ALLOWED_TRANSITIONS = {
  proposed: ['shadowing', 'rejected'],
  shadowing: ['dual_writing', 'rejected'],
  dual_writing: ['ready', 'rejected'],
  ready: ['authorized', 'rejected'],
  authorized: ['applied', 'rejected'],
  applied: ['expired'],
  rejected: [],
  expired: [],
}

function notFound(id) {
  const err = new Error('suggestion not found: ' + id)
  err.code = 'NOT_FOUND'
  return err
}

function createEvolutionSuggestionStore({
  dataDir,
  projectName,
  cutover,
  appendJsonl,
  readJsonl,
  now = () => Date.now(),
}) {
  const suggestionsPath = path.join(dataDir, 'evolution_suggestions.jsonl')
  const preferencesPath = path.join(dataDir, 'routing_preferences.jsonl')

  function append(file, value) {
    if (appendJsonl) return appendJsonl(file, value)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
  }

  function read(file) {
    if (readJsonl) return readJsonl(file)
    if (!fs.existsSync(file)) return []
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }

  // Append-only: return the latest record per id.
  function readLatest() {
    const byId = new Map()
    for (const record of read(suggestionsPath)) byId.set(record.id, record)
    return [...byId.values()]
  }

  function writeSuggestion(record) {
    append(suggestionsPath, record)
  }

  // Only high-priority routing suggestions with enough sample qualify.
  function isEligible(suggestion) {
    return (
      suggestion &&
      suggestion.category === 'routing' &&
      suggestion.priority === 'high' &&
      typeof suggestion.preferAgent === 'string' &&
      suggestion.minSamplePerAgent != null &&
      suggestion.evidence &&
      suggestion.evidence.best &&
      suggestion.evidence.best.total >= suggestion.minSamplePerAgent
    )
  }

  function propose(reportSuggestion, args = {}) {
    if (!isEligible(reportSuggestion)) {
      const err = new Error('only high-priority routing suggestions with sufficient sample qualify')
      err.code = 'INELIGIBLE'
      throw err
    }
    const project = args.project || projectName()
    const at = new Date(now()).toISOString()
    const record = {
      id: `sug_${now()}_${Math.random().toString(36).slice(2, 8)}`,
      category: reportSuggestion.category,
      priority: reportSuggestion.priority,
      preferAgent: reportSuggestion.preferAgent,
      baselineAgent: reportSuggestion.baselineAgent,
      successRateDelta: reportSuggestion.successRateDelta,
      minSamplePerAgent: reportSuggestion.minSamplePerAgent,
      evidence: reportSuggestion.evidence,
      description: reportSuggestion.description,
      project,
      status: 'proposed',
      createdAt: at,
      stateHistory: [{ status: 'proposed', at }],
    }
    writeSuggestion(record)
    return record
  }

  function get(id) {
    return readLatest().find((s) => s.id === id) || null
  }

  function list(args = {}) {
    const project = args.project
    const status = args.status
    return readLatest().filter(
      (s) => (!project || s.project === project) && (!status || s.status === status),
    )
  }

  function transition(id, to, extra = {}) {
    const current = get(id)
    if (!current) throw notFound(id)
    const allowed = ALLOWED_TRANSITIONS[current.status] || []
    if (!allowed.includes(to)) {
      const err = new Error(`illegal transition ${current.status} -> ${to}`)
      err.code = 'ILLEGAL_TRANSITION'
      throw err
    }
    const at = new Date(now()).toISOString()
    const updated = {
      ...current,
      status: to,
      stateHistory: [...(current.stateHistory || []), { status: to, at, ...extra }],
      ...extra,
    }
    writeSuggestion(updated)
    return updated
  }

  async function apply(id, args = {}) {
    const current = get(id)
    if (!current) throw notFound(id)
    if (!args.approvedBy) {
      const err = new Error('apply requires approvedBy (human authority)')
      err.code = 'UNAUTHORIZED'
      throw err
    }

    let staged = current
    // Drive the gated-rollout pipeline when a cutover backend is present.
    if (cutover) {
      if (cutover.recordShadowComparison && args.shadow) {
        const shadow = await cutover.recordShadowComparison({ ...args.shadow, project: current.project })
        staged = transition(staged.id, 'shadowing', { shadowRunId: shadow.id })
      }
      if (cutover.recordDualWrite && args.dualWrite) {
        const dual = await cutover.recordDualWrite({ ...args.dualWrite, project: current.project })
        staged = transition(staged.id, 'dual_writing', { dualWriteRunId: dual.id })
      }
      if (cutover.cutoverReadiness) {
        const assessment = cutover.cutoverReadiness({ project: current.project, ...args.readiness })
        if (!assessment.ready) {
          transition(staged.id, 'ready', { readiness: assessment })
          const err = new Error('cutover readiness gate failed: ' + JSON.stringify(assessment))
          err.code = 'NOT_READY'
          throw err
        }
        staged = transition(staged.id, 'ready', { readiness: assessment })
      }
    }

    if (staged.status !== 'ready') {
      // No cutover backend: require explicit authority to skip the staged gate.
      if (!args.forceAuthority) {
        const err = new Error('suggestion must pass gated rollout (or forceAuthority) before apply')
        err.code = 'NOT_READY'
        throw err
      }
      // Walk the legal forward chain to 'ready' (explicit gate skip, audited).
      for (const next of ['shadowing', 'dual_writing', 'ready']) {
        if (staged.status === next) break
        staged = transition(staged.id, next, { forced: true })
      }
    }
    staged = transition(staged.id, 'authorized', { authorizedBy: args.approvedBy })

    const expiresAt = now() + PREFERENCE_TTL_MS
    const preference = {
      id: `pref_${staged.id}`,
      project: staged.project,
      preferAgent: staged.preferAgent,
      baselineAgent: staged.baselineAgent,
      successRateDelta: staged.successRateDelta,
      suggestionId: staged.id,
      status: 'active',
      createdAt: new Date(now()).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    }
    append(preferencesPath, preference)

    return transition(staged.id, 'applied', {
      appliedAt: new Date(now()).toISOString(),
      preferenceId: preference.id,
      authorizedBy: args.approvedBy,
    })
  }

  function reject(id, args = {}) {
    return transition(id, 'rejected', { reason: args.reason || 'rejected' })
  }

  function expire(id) {
    return transition(id, 'expired')
  }

  function listPreferences(args = {}) {
    const nowMs = now()
    return read(preferencesPath).filter((p) => {
      if (args.project && p.project !== args.project) return false
      if (args.activeOnly === false) return true
      return new Date(p.expiresAt).getTime() > nowMs && p.status === 'active'
    })
  }

  return {
    propose,
    get,
    list,
    apply,
    reject,
    expire,
    listPreferences,
    isEligible,
    _paths: { suggestionsPath, preferencesPath },
  }
}

// Text renderers for the CLI (`mio evolution suggestion list/apply`). Kept here
// rather than in bin/mio.js so they are unit-testable without spawning the CLI,
// matching how evolution-report.js exports its own formatter.
function formatEvolutionSuggestionsText(suggestions) {
  const list = Array.isArray(suggestions) ? suggestions : []
  if (list.length === 0) return 'No evolution routing suggestions.'
  const lines = [`${list.length} evolution routing suggestion(s):`]
  for (const s of list) {
    lines.push(
      `  ${s.id}  ${String(s.status).padEnd(12)} ${s.project || '-'}  ` +
        `prefer ${s.preferAgent} over ${s.baselineAgent}  ` +
        `(successRate +${Math.round((s.successRateDelta || 0) * 1000) / 10}%)`,
    )
  }
  return lines.join('\n')
}

function formatEvolutionSuggestionText(suggestion) {
  if (!suggestion) return 'Unknown suggestion.'
  const lines = [
    `${suggestion.id}  ${suggestion.status}`,
    `  project         ${suggestion.project || '-'}`,
    `  routing         ${suggestion.baselineAgent} -> ${suggestion.preferAgent}`,
    `  successRateDelta +${Math.round((suggestion.successRateDelta || 0) * 1000) / 10}%`,
  ]
  if (suggestion.preferenceId) lines.push(`  preferenceId    ${suggestion.preferenceId}`)
  if (suggestion.authorizedBy) lines.push(`  authorizedBy    ${suggestion.authorizedBy}`)
  return lines.join('\n')
}

module.exports = {
  createEvolutionSuggestionStore,
  formatEvolutionSuggestionsText,
  formatEvolutionSuggestionText,
  ALLOWED_TRANSITIONS,
  PREFERENCE_TTL_MS,
}
