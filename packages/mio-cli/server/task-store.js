'use strict'

// Shared task store: the single implementation behind mio.task.route, consumed
// by both the MCP server and the CLI (`mio task route`). It answers "which
// verified experiences apply to this kind of task, and which agents have
// actually succeeded at it" by cross-referencing memory + experience reuse,
// with an agent-health signal from the latest digest snapshot.
//
// Extracted from mio-intelligence-mcp/index.js so the terminal and the MCP tool
// can never route differently.
//
// One behavioural knob is deliberate: `persistQuery`. The MCP call feeds the
// query log so a later task_outcome can auto-claim route-driven reuse, which is
// load-bearing for the experience loop. A terminal `mio task route` is an
// inspection command and must NOT write to queries.jsonl on every invocation,
// so the CLI passes persistQuery: false. Default stays true so MCP behaviour is
// unchanged.

const fs = require('fs')
const path = require('path')
const { createId, readJsonlCached, appendJsonl, writeJsonl } = require('./memory-store.js')
const { REUSE_STATUS_FILTERS } = require('./experience-store.js')
const { createQueryLog } = require('./query-log.js')

const AGENT_HEALTH_FRESH_MS = 48 * 3600000

// Token overlap helpers for the routing-gate diagnostic below. Kept local and
// deliberately stricter than memory-store's scoreRecord: that scorer also
// counts prefix matches, which are right for fuzzy recall but would make this
// diagnostic fire on unrelated records. These require exact token equality.
function tokenizeForOverlap(text) {
  const normalized = String(text || '').toLowerCase()
  const latin = normalized.match(/[a-z0-9]+/g) || []
  const cjk = (normalized.match(/[\u4e00-\u9fff]/g) || []).map((char) => `cjk:${char}`)
  return [...latin, ...cjk]
}

function cjkBigramsForOverlap(text) {
  const chars = String(text || '').toLowerCase().match(/[\u4e00-\u9fff]/g) || []
  const bigrams = new Set()
  for (let i = 0; i + 1 < chars.length; i += 1) {
    bigrams.add(`${chars[i]}${chars[i + 1]}`)
  }
  return bigrams
}

function createTaskStore(options) {
  const dataDir = options.dataDir
  const projectName = options.projectName || (() => null)
  const memoryStore = options.memoryStore
  // Who is asking. The MCP passes the runtime agent id; the CLI passes 'cli'.
  // Named resolveAgentId so recordTaskOutcome can still use `agentId` as a local.
  const resolveAgentId = options.agentId || (() => 'mcp')

  const {
    normalizeScope,
    isGlobalRecord,
    matchesProjectScope,
    scoreRecord,
    loadEvidenceWeights,
  } = memoryStore

  const memoryPath = path.join(dataDir, 'memory.jsonl')
  const experienceReusePath = path.join(dataDir, 'experience_reuse.jsonl')
  const tracePath = path.join(dataDir, 'traces.jsonl')
  const agentsPath = path.join(dataDir, 'agents.jsonl')

  function readAgentHealth() {
    const file = path.join(dataDir, 'digest', 'latest.json')
    if (!fs.existsSync(file)) return null
    try {
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'))
      const ts = Date.parse(snapshot.generatedAt || '')
      const generatedAt = Number.isFinite(ts) ? snapshot.generatedAt : null
      if (!Number.isFinite(ts) || Date.now() - ts > AGENT_HEALTH_FRESH_MS) {
        return { stale: true, generatedAt, best: null, degraded: [], agents: [] }
      }
      const agents = Array.isArray(snapshot.agents) ? snapshot.agents : []
      const reliable = agents.filter((a) => Number(a.total) >= 5)
      const best =
        reliable.length > 0
          ? reliable.reduce((a, b) => (b.successRate > a.successRate ? b : a))
          : null
      const degraded = reliable
        .filter((a) => a.successRate < 50)
        .map((a) => ({ agent: a.agent, successRate: a.successRate, total: a.total }))
      return {
        stale: false,
        generatedAt,
        periodDays: snapshot.periodDays || null,
        best: best ? { agent: best.agent, successRate: best.successRate, total: best.total } : null,
        degraded,
        agents: agents.map((a) => ({ agent: a.agent, total: a.total, successRate: a.successRate })),
      }
    } catch (_) {
      return null
    }
  }

  // queries.jsonl is owned by the shared query log (see ../query-log.js). The
  // MCP server and the CLI hand in the same instance the memory store uses, so
  // there is exactly one reader/writer for this file.
  const queryLog = options.queryLog || createQueryLog({ dataDir })
  const loadRecentQueries = () => queryLog.load()
  const persistRecentQueries = (entries) => queryLog.persist(entries)
  const REUSE_MATCH_WINDOW_MS = queryLog.windowMs

  function routeTask(args = {}) {
    const task = String(args.task || '').trim()
    if (!task) throw new Error('task.route requires a non-empty task')
    const project = args.project || projectName()
    const scope = normalizeScope(args.scope)
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10)

    const memories = readJsonlCached(memoryPath).filter((record) => record.archived !== true)
    const memoryById = new Map(memories.map((record) => [record.id, record]))
    const evidence = loadEvidenceWeights()

    // Match verified reuse experiences whose source memory is relevant to the task.
    //
    // ⚠️ The `verified` predicate (experience-store.js) is
    // `reuse && behaviorChanged && outcomeImproved` -- note it does NOT include
    // `confirmed`. It has a failure mode that looks exactly like "no match": an
    // auto-claim is written with behaviorChanged=false (task-store.js
    // buildAutoClaim), and nothing flips it to true except
    // `mio.experience.confirm` (experience-store.js:146). So if nothing was ever
    // confirmed, verified is empty and routing returns nothing for every task,
    // forever. Measured on the real dataset 2026-09-20: 21 reuse records,
    // behaviorChanged=false in all of them, verified == 0, and `task.route`
    // could not return a single hit on a task that plainly had matching
    // experience. Confirming three records made the same route return 1. So
    // `count` is not a routing-quality signal until confirmations exist --
    // `gatedBy` below reports that distinction.
    const reuseRecords = readJsonlCached(experienceReusePath)
    const routeByMemory = new Map()
    for (const record of reuseRecords) {
      if (!REUSE_STATUS_FILTERS.verified(record)) continue
      const memory = memoryById.get(record.experienceId)
      if (!memory || !matchesProjectScope(memory, project, scope)) continue
      const score = scoreRecord(memory, task, project)
      if (score <= 0) continue
      let entry = routeByMemory.get(record.experienceId)
      if (!entry) {
        entry = {
          experienceId: record.experienceId,
          memory,
          weight: 0,
          confirmed: false,
          sourceAgents: new Set(),
          targetAgents: new Set(),
          reuseCount: 0,
        }
        routeByMemory.set(record.experienceId, entry)
      }
      entry.reuseCount += 1
      if (record.confirmed === true) entry.confirmed = true
      if (record.sourceAgent) entry.sourceAgents.add(record.sourceAgent)
      if (record.targetAgent) entry.targetAgents.add(record.targetAgent)
      entry.weight = Math.max(entry.weight, score + (entry.confirmed ? 2 : 1.5))
    }

    const routes = [...routeByMemory.values()]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map((entry) => ({
        experienceId: entry.experienceId,
        reuseCount: entry.reuseCount,
        confirmed: entry.confirmed,
        sourceAgents: [...entry.sourceAgents].filter(Boolean),
        targetAgents: [...entry.targetAgents].filter(Boolean),
        score: Number(entry.weight.toFixed(2)),
        memory: {
          id: entry.memory.id,
          timestamp: entry.memory.timestamp,
          kind: entry.memory.kind,
          content: entry.memory.content,
          tags: entry.memory.tags || [],
          project: entry.memory.project || null,
          scope: entry.memory.scope || 'project',
        },
      }))

    // Why routing came back empty, when it did. `no-match` means the strict
    // filter was satisfied by nothing relevant; `unconfirmed` means relevant
    // experience exists but was never confirmed, so the filter excluded it. The
    // two look identical in `count` but need opposite responses -- the first is
    // a recall problem, the second is a one-command fix.
    //
    // "Relevant" here deliberately does NOT reuse scoreRecord: that scorer's
    // prefix rule is symmetric (`token.startsWith(item) || item.startsWith(token)`),
    // so a query token merely starting with any short haystack token counts --
    // "nonsense" matches a record containing "no read path". Fine for fuzzy
    // recall, useless as a diagnostic: measured on the real dataset, a nonsense
    // task scored 10 unrelated records as "relevant". Require a real shared
    // token (or CJK bigram) instead, so the count only moves for genuine overlap.
    let gatedBy = null
    if (routes.length === 0) {
      const queryTokens = new Set(tokenizeForOverlap(task))
      const bigrams = cjkBigramsForOverlap(task)
      const overlaps = (memory) => {
        const content = `${memory.content || ''} ${(memory.tags || []).join(' ')} ${memory.kind || ''}`
        if (tokenizeForOverlap(content).some((token) => queryTokens.has(token))) return true
        if (bigrams.size === 0) return false
        const haystack = cjkBigramsForOverlap(content)
        for (const bigram of bigrams) if (haystack.has(bigram)) return true
        return false
      }
      const relevantUnconfirmed = reuseRecords.filter((record) => {
        if (!REUSE_STATUS_FILTERS.pending(record)) return false
        const memory = memoryById.get(record.experienceId)
        if (!memory || !matchesProjectScope(memory, project, scope)) return false
        return overlaps(memory)
      }).length
      const totalVerified = reuseRecords.filter(REUSE_STATUS_FILTERS.verified).length
      gatedBy = {
        reason: relevantUnconfirmed > 0 ? 'unconfirmed' : 'no-match',
        verifiedTotal: totalVerified,
        relevantUnconfirmed,
      }
    }

    // Broader context: top related memories not already routed.
    const routedIds = new Set(routes.map((route) => route.experienceId))
    const scoreRelated = (record) =>
      scoreRecord(record, task, project, evidence) +
      (scope === 'all' && isGlobalRecord(record) ? 0.5 : 0)
    // Same shape as memory-store.queryMemory: score once, then sort the scored
    // pairs. Scoring inside the comparator re-tokenized every candidate on every
    // comparison, which is what made mio.task.route the slowest tool call
    // (~100 ms median on a 1094-record store).
    const scoredRelated = []
    for (const record of memories) {
      if (routedIds.has(record.id)) continue
      if (!matchesProjectScope(record, project, scope)) continue
      const score = scoreRelated(record)
      if (score > 0) scoredRelated.push({ record, score })
    }
    const relatedMemories = scoredRelated
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit, 5))
      .map(({ record }) => {
        const ev = evidence.get(record.id)
        return {
          id: record.id,
          timestamp: record.timestamp,
          kind: record.kind,
          content: record.content,
          tags: record.tags || [],
          project: record.project || null,
          scope: record.scope || 'project',
          evidence: ev
            ? { reuseCount: ev.reuseCount, confirmedCount: ev.confirmedCount }
            : null,
        }
      })

    // Feed the query log so a later task_outcome can auto-claim route-driven
    // reuse. Skipped when persistQuery is false (the CLI, which is read-only).
    if (args.persistQuery !== false && (routes.length > 0 || relatedMemories.length > 0)) {
      const now = Date.now()
      const entries = loadRecentQueries()
      entries.push({
        agent: resolveAgentId() || 'mcp',
        project,
        query: task,
        resultIds: [...routedIds, ...relatedMemories.map((record) => record.id)].filter(Boolean),
        resultSources: [
          ...routes.map(() => 'experience'),
          ...relatedMemories.map((record) => record.source || null),
        ],
        timestamp: now,
        expiresAt: now + REUSE_MATCH_WINDOW_MS,
      })
      persistRecentQueries(entries)
    }

    let suggestion
    if (routes.length > 0) {
      suggestion =
        `Route ${routes.length} verified experience(s) to this task; apply the top match first and record the outcome with mio.observer.ingest / mio.experience.reuse.`
    } else if (gatedBy && gatedBy.reason === 'unconfirmed') {
      // Distinct from "no match": the experience is there and relevant, it just
      // was never confirmed. `verified` requires behaviorChanged, which only
      // `experience.confirm` sets on an auto-claim, so an unconfirmed backlog
      // silently empties the routing set. Point at the fix, not at recall.
      suggestion =
        `${gatedBy.relevantUnconfirmed} relevant experience(s) match this task but are unconfirmed, so routing skipped them (only verified experience routes, and confirming is what marks behaviorChanged). Run "mio status" to see the backlog, then "mio experience confirm --ids <id,...>".`
    } else if (relatedMemories.length > 0) {
      suggestion =
        'No verified experience matches yet. Consult the related memories, then record the outcome so this task can seed future routes.'
    } else {
      suggestion =
        'No matching experience or memory found. Proceed with care and record the outcome to grow the experience base.'
    }

    // Agent-health routing signal from the latest digest snapshot (value loop:
    // collected task outcomes influence who should execute the next task).
    const agentHealth = readAgentHealth()
    let routingSignal = null
    if (agentHealth && !agentHealth.stale && agentHealth.best) {
      const parts = []
      if (agentHealth.best.successRate >= 80) {
        parts.push(
          `prefer ${agentHealth.best.agent} (${agentHealth.best.successRate}% success over ${agentHealth.best.total} tasks)`,
        )
      }
      for (const bad of agentHealth.degraded) {
        parts.push(`avoid ${bad.agent} (${bad.successRate}% success over ${bad.total} tasks)`)
      }
      if (parts.length > 0) {
        routingSignal = `Agent health (last ${agentHealth.periodDays || '?'}d): ${parts.join('; ')}.`
        suggestion = `${suggestion} ${routingSignal}`
      }
    }

    return {
      task,
      project,
      scope,
      count: routes.length,
      routes,
      relatedMemories,
      agentHealth,
      gatedBy,
      summary: {
        verifiedRoutes: routes.length,
        relatedMemories: relatedMemories.length,
        routingSignal,
        suggestion,
      },
    }
  }

  function buildAutoClaim(entry, event, targetAgent) {
    const crossSourceIndex = entry.resultSources.findIndex(
      (source) => source && String(source).toLowerCase() !== targetAgent.toLowerCase()
    )
    const sourceAgent =
      crossSourceIndex >= 0 ? String(entry.resultSources[crossSourceIndex]) : targetAgent
    const experienceId =
      entry.resultIds[crossSourceIndex >= 0 ? crossSourceIndex : 0] ||
      entry.resultIds[0] ||
      'unknown'
    const outcomeImproved = String(event.outcome || '').toLowerCase() === 'success'
    return {
      id: createId('xfer'),
      timestamp: new Date().toISOString(),
      sourceAgent,
      targetAgent,
      experienceId,
      reuse: true,
      behaviorChanged: false,
      outcomeImproved,
      project: entry.project,
      source: 'auto_claim',
      traceId: event.trace_id || null,
      notes: `Auto-claimed: memory.query "${entry.query}" matched task_outcome ${event.outcome || 'unknown'} in trace ${event.trace_id || 'unknown'}.`,
    }
  }

  // Phase 0 auto-claim: a task_outcome arriving within the match window of a
  // prior query is attributed to that query's results, so reuse evidence does
  // not depend on the agent self-reporting mio.experience.reuse. Shared with
  // observer.ingest, which is why it lives in the store rather than the MCP
  // handler.
  function autoClaimExperienceReuse(event) {
    if (String(event.event_type || '').toLowerCase() !== 'task_outcome') return []
    const targetAgent = String(event.agent || '').trim()
    if (!targetAgent) return []
    const now = Date.now()
    const claims = []
    const remaining = []
    const entries = loadRecentQueries()
    for (const entry of entries) {
      const expired = now - entry.timestamp > REUSE_MATCH_WINDOW_MS
      const matches =
        entry.agent === targetAgent && (!event.project || entry.project === event.project)
      if (expired || matches) {
        if (matches && !expired) {
          claims.push(buildAutoClaim(entry, event, targetAgent))
        }
        continue
      }
      remaining.push(entry)
    }
    persistRecentQueries(remaining)
    for (const evidence of claims) {
      appendJsonl(experienceReusePath, evidence)
    }
    return claims
  }

  function recordTaskOutcome(args = {}) {
    const outcome = String(args.outcome || '').trim().toLowerCase()
    if (!['success', 'failure', 'aborted'].includes(outcome)) {
      throw new Error('task.record_outcome requires outcome to be success, failure, or aborted')
    }
    const agentId = String(args.agentId || resolveAgentId() || 'unknown').trim()
    const project = args.project || projectName()
    const task = String(args.task || '').trim()
    const summary = String(args.summary || '').trim()
    const verification = String(args.verification || '').trim()
    const traceId = String(args.traceId || '').trim() || createId('trace:' + agentId + ':' + project)

    // 1. Record trace event
    const event = {
      id: createId('trace'),
      timestamp: new Date().toISOString(),
      trace_id: traceId,
      event_type: 'task_outcome',
      outcome,
      payload: { task, summary, verification },
      agent: agentId,
      host: 'mcp',
      project,
    }
    appendJsonl(tracePath, event)

    // 2. Auto-claim experience reuse
    const autoClaims = autoClaimExperienceReuse(event)

    // 3. Update agent registry
    const now = new Date().toISOString()
    const agents = readJsonlCached(agentsPath)
    const agent = agents.find((a) => a.agentId === agentId && a.project === project)
    if (agent) {
      agent.lastSeenAt = now
      agent.taskCount = (agent.taskCount || 0) + 1
      agent.successCount = (agent.successCount || 0) + (outcome === 'success' ? 1 : 0)
      agent.failureCount = (agent.failureCount || 0) + (outcome === 'failure' ? 1 : 0)
      writeJsonl(agentsPath, agents)
    }

    return {
      recorded: true,
      event: { id: event.id, trace_id: traceId, outcome, agent: agentId, project },
      agentUpdated: !!agent,
      autoClaims: autoClaims.length > 0 ? autoClaims : undefined,
    }
  }

  function ingestObservation(args = {}) {
    const traceId = String(args.trace_id || '').trim()
    const eventType = String(args.event_type || '').trim()
    if (!traceId) throw new Error('observer.ingest requires trace_id')
    if (!eventType) throw new Error('observer.ingest requires event_type')
    const event = {
      id: createId('trace'),
      timestamp: new Date().toISOString(),
      trace_id: traceId,
      event_type: eventType,
      outcome: args.outcome || null,
      payload: args.payload || {},
      agent: args.agent || resolveAgentId(),
      host: args.host || 'mcp',
      project: args.project || projectName(),
    }
    appendJsonl(tracePath, event)
    const autoClaims = autoClaimExperienceReuse(event)
    if (autoClaims.length > 0) {
      return { recorded: true, event, autoClaims }
    }
    return { recorded: true, event }
  }

  return {
    routeTask,
    readAgentHealth,
    autoClaimExperienceReuse,
    recordTaskOutcome,
    ingestObservation,
  }
}

module.exports = { createTaskStore }
