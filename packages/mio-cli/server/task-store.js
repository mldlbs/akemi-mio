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
const { readJsonl } = require('./memory-store.js')
const { REUSE_STATUS_FILTERS } = require('./experience-store.js')

const AGENT_HEALTH_FRESH_MS = 48 * 3600000
const MAX_RECENT_QUERIES = 200
const REUSE_MATCH_WINDOW_MS = (() => {
  const minutes = Number(process.env.MIO_REUSE_MATCH_WINDOW_MIN)
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 60 * 1000
})()

function createTaskStore(options) {
  const dataDir = options.dataDir
  const projectName = options.projectName || (() => null)
  const memoryStore = options.memoryStore
  // Who is asking. The MCP passes the runtime agent id; the CLI passes 'cli'.
  const agentId = options.agentId || (() => 'mcp')

  const {
    normalizeScope,
    isGlobalRecord,
    matchesProjectScope,
    scoreRecord,
    loadEvidenceWeights,
  } = memoryStore

  const memoryPath = path.join(dataDir, 'memory.jsonl')
  const experienceReusePath = path.join(dataDir, 'experience_reuse.jsonl')
  const queryPath = path.join(dataDir, 'queries.jsonl')

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

  function loadRecentQueries() {
    const now = Date.now()
    return readJsonl(queryPath)
      .filter(
        (entry) =>
          entry &&
          typeof entry.agent === 'string' &&
          entry.agent &&
          typeof entry.expiresAt === 'number' &&
          entry.expiresAt > now
      )
      .slice(-MAX_RECENT_QUERIES)
  }

  function persistRecentQueries(entries) {
    const limited = entries.slice(-MAX_RECENT_QUERIES)
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(
      queryPath,
      limited.length > 0 ? limited.map((entry) => JSON.stringify(entry)).join('\n') + '\n' : '',
      'utf8'
    )
    return limited
  }

  function routeTask(args = {}) {
    const task = String(args.task || '').trim()
    if (!task) throw new Error('task.route requires a non-empty task')
    const project = args.project || projectName()
    const scope = normalizeScope(args.scope)
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10)

    const memories = readJsonl(memoryPath).filter((record) => record.archived !== true)
    const memoryById = new Map(memories.map((record) => [record.id, record]))
    const evidence = loadEvidenceWeights()

    // Match verified reuse experiences whose source memory is relevant to the task.
    const routeByMemory = new Map()
    for (const record of readJsonl(experienceReusePath)) {
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

    // Broader context: top related memories not already routed.
    const routedIds = new Set(routes.map((route) => route.experienceId))
    const scoreRelated = (record) =>
      scoreRecord(record, task, project, evidence) +
      (scope === 'all' && isGlobalRecord(record) ? 0.5 : 0)
    const relatedMemories = memories
      .filter((record) => !routedIds.has(record.id))
      .filter((record) => matchesProjectScope(record, project, scope))
      .filter((record) => scoreRelated(record) > 0)
      .sort((a, b) => scoreRelated(b) - scoreRelated(a))
      .slice(0, Math.max(limit, 5))
      .map((record) => {
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
        agent: agentId() || 'mcp',
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
      summary: {
        verifiedRoutes: routes.length,
        relatedMemories: relatedMemories.length,
        routingSignal,
        suggestion,
      },
    }
  }

  return { routeTask, readAgentHealth }
}

module.exports = { createTaskStore }
