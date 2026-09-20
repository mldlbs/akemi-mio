'use strict'

// ADR-017 evaluation-period metrics: the numbers that decide whether the Agent
// Control Plane keeps expanding (`agent.register` / `agent.list` /
// `agent.report` are already authorised) or the whole direction gets rolled
// back. The ADR names four, and until now none of them had an implementation:
// a grep for adoptionRate / behaviorChangeRate / recallQuality / routingAccuracy
// across the CLI returned zero hits. The evaluation period was therefore
// running on a checklist a human had to tally by hand, which is exactly the
// kind of thing that silently stops happening.
//
// The four metrics, verbatim from the ADR, and how each is computed here:
//
//   1. 路由采纳率 (route adoption rate)
//        "task.route 命中且被采纳的次数 / 调用次数"
//      Denominator: `queries.jsonl` entries that carried at least one route
//      result (i.e. routes.length > 0 -- a "hit"). Numerator: those that can be
//      linked to a reuse record. A hit that nobody acts on is not adoption, so
//      only routes with a correlating reuse count.
//
//   2. 行为改变率 (behavior change rate)
//        "confirmed（behaviorChanged=true）数量变化"
//      Numerator: reuse records with behaviorChanged=true and confirmed=true.
//      Denominator: all reuse records. Kept separate from `verified` (which
//      additionally requires outcomeImproved) because the ADR asks about the
//      behaviour change specifically, not its benefit.
//
//   3. 召回质量 (recall quality)
//        "scope=all 与混合检索是否减少无效探索"
//      Proxied by query yield: of the queries that returned results, how many
//      led to a confirmed reuse. A high-miss recall path shows up as a low
//      yield and an `emptyQueryRate`, which is the "无效探索" the ADR asks about.
//
//   4. 数据卫生 (data hygiene)
//        "pending auto-claim 噪声占比是否随确认纪律下降"
//      `pendingAutoClaims / total` -- the share of reuse records that are
//      unconfirmed auto-claims. These are invisible dead weight: they never
//      feed ranking or routing, so a rising ratio means the confirmation
//      discipline is slipping.
//
// ⚠️ TWO OF THESE METRICS READ A BUFFER THAT IS EMPTY BY DESIGN.
//
// Metrics 1 and 3 are derived from `queries.jsonl`, which is not an evaluation
// log: it is the auto-claim correlation buffer (see ../query-log.js), holding
// at most 200 entries and pruning anything past a 1-hour `expiresAt` window
// (retention.js lists it under EXPIRY_BASED_FILES). Measured against the real
// dataset on 2026-09-20: queries.jsonl was 0 bytes while traces.jsonl held 764
// task_outcomes and experience_reuse.jsonl held 21 records. So in practice
// these two metrics report "no data" almost always -- not because routing is
// unused, but because its evidence deliberately does not survive.
//
// That is a real limitation of the metric definitions, not of the data, and it
// is reported rather than hidden: `sources` below names each metric's backing
// file and whether that file is durable, so a reader can tell "route adoption
// is 0%" from "route adoption cannot be measured from what we keep".
//
// Everything is read-only. Each metric reports its own denominator so a caller
// can tell "0%" from "no data at all" -- reporting a confident 0% on zero
// samples is the failure mode this repo keeps rediscovering.

const path = require('path')
const { readJsonl } = require('./memory-store.js')
const { REUSE_STATUS_FILTERS } = require('./experience-store.js')
const { REUSE_MATCH_WINDOW_MS } = require('./query-log.js')

// Reported so the client can say "this number is windowed to the last N
// minutes". Read from the query log itself rather than hardcoded, so a change
// to the auto-claim window cannot leave this description stale.
const QUERY_BUFFER_MINUTES = Math.round(REUSE_MATCH_WINDOW_MS / 60000)

// The ADR frames the whole evaluation period as a comparison against the Phase 0
// baseline, and states it in its own line:
//
//   "对照 Phase 0 基线 2026-08-17：hosts 3/2、tasks 176/20、verified 6/5、
//    improved 30/1"
//
// Each pair is `observed / threshold`, which the Phase 0 implementation
// confirms: phase0.js declares thresholds {minHosts:2, minTaskOutcomes:20,
// minVerifiedReuse:5, minImprovementEvidence:1} and renders them as
// `current/required` (phase0.js:313). So `verified 6/5` means verified=6
// against a required 5 -- passing, with one to spare.
//
// Without this the metrics report bare numbers with no reference point, and a
// regression like verified 6 -> 0 reads as an unremarkable "0" instead of a
// gate that used to pass and no longer does. Measured 2026-09-20: verified is
// in fact 0.
//
// The keys match phase0's `criteria[].key` values so the two reports can be
// read side by side.
const PHASE0_BASELINE = Object.freeze({
  date: '2026-08-17',
  source: 'docs/adr-017-mio-agent-control-plane.md',
  values: Object.freeze({
    hosts: Object.freeze({ observed: 3, required: 2 }),
    tasks: Object.freeze({ observed: 176, required: 20 }),
    verified_reuse: Object.freeze({ observed: 6, required: 5 }),
    measurable_improvement: Object.freeze({ observed: 30, required: 1 }),
  }),
})

function ratio(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : null
}

function createEvaluationStore(options = {}) {
  const dataDir = options.dataDir
  const projectName = options.projectName || (() => null)

  const queryPath = path.join(dataDir, 'queries.jsonl')
  const reusePath = path.join(dataDir, 'experience_reuse.jsonl')
  const tracePath = path.join(dataDir, 'traces.jsonl')
  const agentsPath = path.join(dataDir, 'agents.jsonl')

  // The query log prunes itself by expiresAt, but for an evaluation window we
  // want the historical record, so read the file directly rather than through
  // query-log.js (whose `load()` deliberately drops expired entries).
  function readQueries(project) {
    const entries = readJsonl(queryPath).filter((entry) => entry && typeof entry === 'object')
    if (!project) return entries
    return entries.filter((entry) => !entry.project || entry.project === project)
  }

  function evaluate(args = {}) {
    const project = args.project || projectName()
    const since = args.since ? Date.parse(args.since) : null
    const inWindow = (record) => {
      if (!Number.isFinite(since)) return true
      const ts = Date.parse(record.timestamp || '')
      return Number.isFinite(ts) && ts >= since
    }

    const queries = readQueries(project).filter(inWindow)
    const reuses = readJsonl(reusePath).filter(
      (r) => r && inWindow(r) && (!project || !r.project || r.project === project)
    )
    const traces = readJsonl(tracePath).filter(
      (t) => t && inWindow(t) && (!project || !t.project || t.project === project)
    )
    const agents = readJsonl(agentsPath).filter(
      (a) => a && (!project || !a.project || a.project === project)
    )

    // ---- 1. route adoption rate -------------------------------------------
    // A query entry is a "route hit" when it came back with at least one result
    // id to act on. `resultSources` marks which of those came from a verified
    // experience rather than a plain memory.
    const routeHits = queries.filter(
      (q) => Array.isArray(q.resultIds) && q.resultIds.length > 0
    )
    const experienceHits = queries.filter(
      (q) => Array.isArray(q.resultSources) && q.resultSources.some((s) => s === 'experience')
    )
    // Adoption: a route hit whose experience was subsequently reused. Correlate
    // on experienceId, which both the route result and the reuse record carry.
    const reusedIds = new Set(reuses.map((r) => r.experienceId).filter(Boolean))
    const adopted = experienceHits.filter((q) =>
      (q.resultIds || []).some((id) => reusedIds.has(id))
    )

    // ---- 2. behaviour change rate -----------------------------------------
    const behaviorChanged = reuses.filter(
      (r) => r.confirmed === true && (r.behaviorChanged === true || r.behaviorChanged === 'true')
    )
    const verified = reuses.filter(REUSE_STATUS_FILTERS.verified)

    // ---- 3. recall quality -------------------------------------------------
    const withResults = queries.filter((q) => (q.resultIds || []).length > 0)
    const linkedToReuse = withResults.filter((q) =>
      (q.resultIds || []).some((id) => reusedIds.has(id))
    )
    const emptyQueries = queries.filter((q) => (q.resultIds || []).length === 0)

    // ---- 4. data hygiene ---------------------------------------------------
    const pendingAutoClaims = reuses.filter(REUSE_STATUS_FILTERS.pending)

    const outcomes = traces.filter((t) => t.event_type === 'task_outcome')
    const successes = outcomes.filter((t) => t.outcome === 'success').length
    const failures = outcomes.filter((t) => t.outcome === 'failure').length

    return {
      project,
      since: args.since || null,
      // Which file each metric is derived from, and whether that file survives.
      // Metrics 1 and 3 depend on a 1-hour buffer, so their denominators decay
      // to zero on their own; without this a reader cannot tell an unused
      // feature from an unmeasurable one.
      sources: {
        routeAdoption: { file: 'queries.jsonl', durable: false, windowMinutes: QUERY_BUFFER_MINUTES },
        behaviorChange: { file: 'experience_reuse.jsonl', durable: true },
        recallQuality: { file: 'queries.jsonl', durable: false, windowMinutes: QUERY_BUFFER_MINUTES },
        dataHygiene: { file: 'experience_reuse.jsonl', durable: true },
      },
      // The Phase 0 reference point the ADR asks these numbers to be read
      // against. Reported verbatim, with no interpretation folded in -- a
      // caller compares `behaviorChange.verified` to
      // `baseline.values.verified_reuse.observed` itself. Deliberately NOT
      // merged into the metrics above: the baseline was measured on different
      // record shapes, so silently differencing them would be another confident
      // number with a shaky basis.
      baseline: PHASE0_BASELINE,
      sample: {
        queries: queries.length,
        routeHits: routeHits.length,
        reuses: reuses.length,
        traces: traces.length,
        agents: agents.length,
        taskOutcomes: outcomes.length,
      },
      routeAdoption: {
        routeHits: experienceHits.length,
        adopted: adopted.length,
        rate: ratio(adopted.length, experienceHits.length),
      },
      behaviorChange: {
        confirmed: behaviorChanged.length,
        verified: verified.length,
        total: reuses.length,
        rate: ratio(behaviorChanged.length, reuses.length),
      },
      recallQuality: {
        queriesWithResults: withResults.length,
        queriesLinkedToReuse: linkedToReuse.length,
        emptyQueries: emptyQueries.length,
        emptyQueryRate: ratio(emptyQueries.length, queries.length),
        yield: ratio(linkedToReuse.length, withResults.length),
      },
      dataHygiene: {
        pendingAutoClaims: pendingAutoClaims.length,
        total: reuses.length,
        pendingRatio: ratio(pendingAutoClaims.length, reuses.length),
      },
      taskOutcomes: {
        total: outcomes.length,
        success: successes,
        failure: failures,
        successRate: ratio(successes, outcomes.length),
      },
    }
  }

  return { evaluate }
}

module.exports = { createEvaluationStore }
