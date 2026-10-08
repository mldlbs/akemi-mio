'use strict'

// `mio.idea.generate` — one-shot goal-driven idea pipeline (spec Capability 1).
// Shared by the CLI (`mio idea generate`) and the MCP server (tool
// `mio.idea.generate`): each entry point only assembles entry-specific inputs
// (which store is authoritative, where local data lives) and renders the
// response this module returns.
//
// Contract:
//   - source order: goal → context → constraints → grounding → local auto,
//     deduplicated by `origin` (fallback name), first occurrence wins — so a
//     memory that arrives both as a grounding hit and through the local
//     provider contributes exactly once, the grounding copy first;
//   - pairing strategy: cross-type `explore` only when two types exist, else
//     the `stable` fallback (an all-knowledge set explores into ZERO combos);
//   - every candidate passes evaluateNovelty against stored hypotheses: a
//     near-duplicate of a REJECTED one is persisted as rejected with a reason,
//     a merely-similar recent one is down-scored; drafts AND rejects both land
//     in the store so later runs can dedup against them;
//   - ideas are never written to Mio memory — CreativityStore only.

const { IdeaGenerator } = require('@akemi-mio/creativity/IdeaGenerator')
const { evaluateNovelty } = require('@akemi-mio/creativity/NoveltyScorer')

// All > 0.7: IdeaGenerator.applyTemperature keeps such sources unconditionally
// (temperature 0.5 middle branch) — deterministic prompt, no RNG survival.
const WEIGHTS = { goal: 0.95, context: 0.9, constraint: 0.88, grounding: 0.75 }

// `queryMemory` result → grounding sources + ids. Tolerates null/empty
// (a thrown query is the caller's problem to catch; a miss is not).
function groundingFrom(queryResult) {
  const results = Array.isArray(queryResult && queryResult.results) ? queryResult.results : []
  const sources = results.map((r) => ({
    name: `${r.kind || 'memory'}: ${String(r.content || '').slice(0, 40)}`,
    content: String(r.content || ''),
    type: 'feedback',
    weight: WEIGHTS.grounding,
    origin: `memory:${r.id}`,
    originId: r.id,
    ...(r.timestamp ? { timestamp: r.timestamp } : {}),
  }))
  return { sources, relatedMemoryIds: results.map((r) => r.id), groundedWith: results.length }
}

function namedSource(role, text, origin, weight) {
  const body = String(text).trim()
  return {
    name: `${role}: ${body.slice(0, 40)}`,
    content: body,
    type: 'knowledge',
    weight,
    origin,
  }
}

async function runIdeaGenerate(options) {
  const {
    goal,
    context = '',
    constraints = [],
    numIdeas,
    chatJson,
    store,
    groundingSources = [],
    relatedMemoryIds = [],
    autoSources = [],
  } = options || {}

  const ordered = []
  if (typeof goal === 'string' && goal.trim()) ordered.push(namedSource('goal', goal, 'goal', WEIGHTS.goal))
  if (typeof context === 'string' && context.trim()) ordered.push(namedSource('context', context, 'context', WEIGHTS.context))
  if (Array.isArray(constraints)) {
    constraints.forEach((c, i) => {
      if (typeof c === 'string' && c.trim()) ordered.push(namedSource('constraint', c, `constraint:${i}`, WEIGHTS.constraint))
    })
  }
  for (const s of [...groundingSources, ...autoSources]) {
    if (s && typeof s === 'object' && s.name) ordered.push(s)
  }

  const seen = new Set()
  const sources = []
  for (const s of ordered) {
    const key = s.origin || s.name
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(s)
  }

  if (sources.length < 2) {
    return { reason: 'need at least 2 sources — add --context/--constraints, or run `mio remember` first' }
  }

  const pairingStrategy = new Set(sources.map((s) => s.type)).size >= 2 ? 'explore' : 'stable'
  const requested = Number(numIdeas)
  const maxIdeas = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 3) : 3

  const rotationSeed = store.getHypotheses().length
  const generator = new IdeaGenerator(chatJson, 0.5, undefined, rotationSeed)
  // method left undefined: HypothesisGenerator rotates techniques internally
  // from rotationSeed; the chosen one comes back on hypothesis.technique.
  const creativeIdeas = await generator.generateIdeas(sources, maxIdeas, pairingStrategy, [])

  const generatedAt = new Date().toISOString()
  const recent = store.getHypotheses().slice(-30)
  const rejected = store.getHypotheses({ status: 'rejected' }).slice(-50)

  const ideas = []
  const persistedIds = []
  for (const { hypothesis: h, experiment } of creativeIdeas) {
    const verdict = evaluateNovelty(h, recent, rejected)
    if (verdict.shouldReject) {
      h.status = 'rejected'
      h.rejectionReason = verdict.rejectReason
    } else {
      h.novelty = verdict.adjustedNovelty
    }
    const labels = new Set(Array.isArray(h.sourceLabels) ? h.sourceLabels : [])
    h.provenance = {
      strategy: pairingStrategy,
      technique: h.technique,
      relatedMemoryIds: [...relatedMemoryIds],
      sources: sources
        .filter((s) => labels.has(s.name))
        .map((s) => ({ name: s.name, type: s.type, origin: s.origin, timestamp: s.timestamp })),
      generatedAt,
    }
    store.addHypothesis(h)
    persistedIds.push(h.id)
    ideas.push({ title: h.title, hypothesis: h, experiment, novelty: h.novelty, provenance: h.provenance })
  }

  return { ideas, generatedAt, groundedWith: groundingSources.length, persistedIds }
}

module.exports = { runIdeaGenerate, groundingFrom }
