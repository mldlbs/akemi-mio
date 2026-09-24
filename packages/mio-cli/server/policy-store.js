'use strict'

// Shared policy store: the single implementation of mio.policy.check, consumed
// by both the MCP server (index.js) and the CLI (`mio policy check`). Keeping it
// here rather than inlined in the MCP server means both entry points score
// risk identically and cannot drift -- same rationale as memory-store.js and
// experience-store.js.
//
// Unlike those stores, the CLI deliberately points this one at the *global*
// MIO_HOME rather than the per-project directory the MCP server uses, so that
// `mio policy check` sees the same history as `mio recall` / `mio traces`.

const path = require('path')

const { readJsonlCached } = require('./memory-store.js')

// Outcomes that count against an action. `retry` is included because a retried
// action is evidence the first attempt did not simply work.
const FAILURE_OUTCOMES = new Set(['failure', 'error', 'aborted', 'retry'])

function isFailureOutcome(value) {
  return FAILURE_OUTCOMES.has(String(value || '').toLowerCase())
}

function summarizeTrace(event) {
  const payload = event.payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (typeof payload.summary === 'string' && payload.summary.trim()) {
      return payload.summary.trim().slice(0, 160)
    }
    if (typeof payload.tool === 'string' && payload.tool.trim()) {
      return `tool: ${payload.tool.trim().slice(0, 120)}`
    }
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim().slice(0, 160)
    }
  }
  return String(event.event_type || 'trace').slice(0, 120)
}

function buildPolicyGuidance({ total, failures, risk, failureExamples, relatedMemories }) {
  const guidance = {
    level: 'none',
    rationale: null,
    saferAlternatives: [],
    verificationSteps: [],
    avoid: [],
    hardGate: false,
  }
  if (total === 0) {
    guidance.rationale =
      'No historical evidence for this action yet. Treat as normal risk and record the outcome.'
    return guidance
  }
  const verifiedMemories = relatedMemories.filter((record) => record.evidence)
  const hasVerified = verifiedMemories.length > 0
  if (risk >= 0.4 && failures >= 2) {
    guidance.level = hasVerified ? 'actionable' : 'advisory'
    guidance.rationale =
      'Repeated historical failures. Prefer an alternative approach and add rollback/verification.'
    guidance.avoid = failureExamples
      .map((example) => example.summary)
      .filter(Boolean)
      .slice(0, 3)
  } else if (risk >= 0.2 || hasVerified) {
    guidance.level = hasVerified ? 'actionable' : 'advisory'
    guidance.rationale = hasVerified
      ? 'Verified experience exists for this action; apply it before proceeding.'
      : 'Moderate historical risk. Add verification before proceeding.'
  } else {
    guidance.level = 'advisory'
    guidance.rationale = 'Low historical risk. Proceed with normal checks and record the outcome.'
  }
  if (hasVerified) {
    guidance.saferAlternatives = verifiedMemories.slice(0, 3).map((record) => ({
      memoryId: record.id,
      reuseCount: record.evidence.reuseCount,
      content: String(record.content || '').slice(0, 300),
    }))
  }
  guidance.verificationSteps = [
    'Add an explicit verification step after execution (dry-run, rollback plan, or assertion).',
    'Record the outcome with mio.observer.ingest so the evidence base improves.',
  ]
  return guidance
}

// Risk score thresholds. `unknown` (no history) is deliberately distinct from
// `low` (history exists and is clean) -- they call for different behavior.
const POLICY_RISK_HIGH = 0.4
const POLICY_RISK_MODERATE = 0.2

// A token appearing in more than this share of the trace corpus carries no
// discriminative power -- it is a structural JSON key (`task`, `outcome`,
// `summary`, `project`, `host`, `sessionid`...) rather than a description of
// what the action does. Measured on a real 920-trace corpus, those keys sit
// above 85%, while meaningful verbs sit far lower.
const POLICY_GENERIC_TOKEN_SHARE = 0.5

// Below this many matched traces the failure ratio is too noisy to call a
// level, so it is reported but flagged.
const POLICY_MIN_SAMPLE = 5

// Tokens that appear in most traces regardless of subject. Matching on these is
// what makes `mio policy check task` return the entire corpus, so the caller is
// warned rather than shown a confident-looking but meaningless risk level.
function collectGenericTokens(traces, tokenize) {
  const total = traces.length
  const generic = new Set()
  if (total === 0) return generic
  const counts = new Map()
  for (const event of traces) {
    const seen = new Set(
      tokenize(`${event.event_type || ''} ${JSON.stringify(event.payload || {})}`)
    )
    for (const token of seen) counts.set(token, (counts.get(token) || 0) + 1)
  }
  for (const [token, count] of counts) {
    if (count / total >= POLICY_GENERIC_TOKEN_SHARE) generic.add(token)
  }
  return generic
}

function createPolicyStore(options = {}) {
  const dataDir = options.dataDir
  const projectName = options.projectName || (() => null)
  const memoryStore = options.memoryStore
  // scoreRecord / tokenize / loadEvidenceWeights all live in the memory store
  // and must match the ranking used by mio.memory.query.
  const tokenize = options.tokenize || memoryStore.tokenize
  const scoreRecord = options.scoreRecord || memoryStore.scoreRecord
  const loadEvidenceWeights = options.loadEvidenceWeights || memoryStore.loadEvidenceWeights

  const tracePath = options.tracePath || path.join(dataDir, 'traces.jsonl')
  const memoryPath = options.memoryPath || path.join(dataDir, 'memory.jsonl')

  function policyCheck(args = {}) {
    const action = String(args.action || '').trim()
    if (!action) throw new Error('policy.check requires action')
    const project = args.project || projectName()
    const actionTokens = tokenize(action)
    const allTraces = readJsonlCached(tracePath)
    const scopedTraces = allTraces.filter(
      (event) => !(project && event.project && event.project !== project)
    )
    const traces = scopedTraces.filter((event) => {
      const haystack = tokenize(`${event.event_type || ''} ${JSON.stringify(event.payload || {})}`)
      return actionTokens.some((token) => haystack.includes(token))
    })
    const total = traces.length
    const failures = traces.filter((event) => isFailureOutcome(event.outcome)).length
    const risk = total > 0 ? failures / total : null
    const riskLevel =
      total === 0
        ? 'unknown'
        : risk >= POLICY_RISK_HIGH
          ? 'high'
          : risk >= POLICY_RISK_MODERATE
            ? 'moderate'
            : 'low'
    const outcomeCounts = traces.reduce((counts, event) => {
      const outcome = String(event.outcome || 'unknown').toLowerCase() || 'unknown'
      counts[outcome] = (counts[outcome] || 0) + 1
      return counts
    }, {})
    const failureExamples = traces
      .filter((event) => isFailureOutcome(event.outcome))
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
      .slice(0, 3)
      .map((event) => ({
        trace_id: event.trace_id || event.id || null,
        event_type: event.event_type || null,
        outcome: event.outcome || null,
        timestamp: event.timestamp || null,
        agent: event.agent || null,
        summary: summarizeTrace(event),
      }))
    let suggestion
    if (total === 0) {
      suggestion = 'No history for this action. Treat as normal risk and record the outcome.'
    } else if (risk >= POLICY_RISK_HIGH) {
      suggestion = 'Historically risky. Prefer an alternative approach or add rollback/verification.'
    } else if (risk >= POLICY_RISK_MODERATE) {
      suggestion = 'Moderate risk. Add verification before proceeding.'
    } else {
      suggestion = 'Low historical risk. Proceed with normal checks.'
    }
    const evidence = loadEvidenceWeights()
    const relatedMemories = readJsonlCached(memoryPath)
      .filter((record) => scoreRecord(record, action, project, evidence) > 0)
      .sort(
        (a, b) => scoreRecord(b, action, project, evidence) - scoreRecord(a, action, project, evidence)
      )
      .slice(0, 3)
      .map((record) => {
        const ev = evidence.get(record.id)
        return {
          id: record.id,
          timestamp: record.timestamp,
          kind: record.kind,
          content: String(record.content || '').slice(0, 300),
          evidence: ev ? { reuseCount: ev.reuseCount, confirmedCount: ev.confirmedCount } : null,
        }
      })
    const genericTokens = collectGenericTokens(scopedTraces, tokenize)
    // Only flag when the match is *carried* by generic tokens: an action like
    // "npm publish" also contains "npm", which is common but still meaningful.
    const genericMatched = actionTokens.filter((token) => genericTokens.has(token))
    const meaningfulTokens = actionTokens.filter((token) => !genericTokens.has(token))
    const lowSignal =
      actionTokens.length > 0 && meaningfulTokens.length === 0 && genericMatched.length > 0

    return {
      action,
      project,
      total,
      failures,
      risk: risk === null ? null : Number(risk.toFixed(3)),
      riskLevel,
      outcomeCounts,
      failureExamples,
      suggestion,
      guidance: buildPolicyGuidance({
        total,
        failures,
        risk,
        failureExamples,
        relatedMemories,
      }),
      related_memories: relatedMemories,
      // Additive diagnostics. Existing consumers (mio.policy.check) ignore
      // these; the CLI uses them to avoid presenting a confident risk level
      // derived from tokens that match everything.
      diagnostics: {
        lowSignal,
        genericTokens: genericMatched,
        meaningfulTokens,
        sampleSize: total,
        lowSample: total > 0 && total < POLICY_MIN_SAMPLE,
      },
    }
  }

  return {
    tracePath,
    memoryPath,
    policyCheck,
    // pure helpers, exported for tests and other consumers
    isFailureOutcome,
    summarizeTrace,
    buildPolicyGuidance,
  }
}

module.exports = {
  createPolicyStore,
  FAILURE_OUTCOMES,
  isFailureOutcome,
  summarizeTrace,
  buildPolicyGuidance,
  POLICY_RISK_HIGH,
  POLICY_RISK_MODERATE,
}
