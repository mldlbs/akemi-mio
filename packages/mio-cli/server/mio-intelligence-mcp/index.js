#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { execFileSync } = require('child_process')
const { getEvolutionStatus } = require('../runtime-modules.js')
const { listHostCapabilities } = require('../host-capabilities.js')
const { createEvolutionCutoverTools } = require('../evolution-cutover.js')
const { createMemoryStore } = require('../memory-store.js')
const { createExperienceStore, REUSE_STATUS_FILTERS } = require('../experience-store.js')
const { createPolicyStore } = require('../policy-store.js')
const { createAgentStore } = require('../agent-store.js')
const { createTaskStore } = require('../task-store.js')
const { createDigest } = require('../digest.js')

const { CreativityEngine } = require('../creativity-engine.js')
// The observer and insight engines are optional dependencies. Their stores own
// the require and expose isObserverAvailable() / isInsightAvailable() so tool
// registration can be gated on them, and both the MCP server and the CLI share
// one implementation (see ../observer-store.js and ../insight-store.js).
const { createObserverStore, isObserverAvailable } = require('../observer-store.js')
const { createInsightStore, isInsightAvailable } = require('../insight-store.js')

const SERVER_INFO = { name: 'mio-intelligence-mcp', version: '0.1.0' }
const PROTOCOL_VERSION = '2024-11-05'

// ═══════════════════════════════════════════════
//  LLM chatJson — shared with the CLI (see ../llm-client.js)
// ═══════════════════════════════════════════════

const { chatJson } = require('../llm-client.js')


const dataDir = path.resolve(
  process.env.MIO_DATA_DIR || path.join(process.cwd(), '.mio-intelligence')
)
const memoryPath = path.join(dataDir, 'memory.jsonl')
const tracePath = path.join(dataDir, 'traces.jsonl')
const experienceReusePath = path.join(dataDir, 'experience_reuse.jsonl')
const queryPath = path.join(dataDir, 'queries.jsonl')
const agentsPath = path.join(dataDir, 'agents.jsonl')
const subscriptionPath = path.join(dataDir, 'subscriptions.jsonl')
const digestStatePath = path.join(dataDir, 'digest_state.json')
fs.mkdirSync(dataDir, { recursive: true })

const { loadPhase0, summarizePhase0, renderPhase0Markdown } = require('./phase0')
const evolutionCutover = createEvolutionCutoverTools({ dataDir, appendJsonl, readJsonl, projectName })
const creativityEngine = new CreativityEngine(path.join(dataDir, 'creativity'), chatJson)
const insightStore = createInsightStore({ dataDir, chatJson })
// baseDir defaults to <cwd>/.local/observer, matching the previous inline
// behaviour; individual calls may still override it via args.baseDir.
const observerStore = createObserverStore({})

let runtimeContext = {}
try {
  const rawContext = process.env.MIO_CONTEXT
  if (rawContext) {
    const parsed = JSON.parse(rawContext)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      runtimeContext = parsed
    }
  }
} catch (_) {
  runtimeContext = {}
}

function runtimeAgentId() {
  return runtimeContext.agentId || null
}

// Phase 0 auto-claim: match memory.query results with a later task_outcome
// from the same agent+project, so reuse evidence does not depend on the
// agent self-reporting mio.experience.reuse.
const REUSE_MATCH_WINDOW_MS = (() => {
  const minutes = Number(process.env.MIO_REUSE_MATCH_WINDOW_MIN)
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 60 * 1000
})()
const MAX_RECENT_QUERIES = 200
let recentQueries = []

function loadRecentQueries() {
  const now = Date.now()
  const entries = readJsonl(queryPath)
    .filter(
      (entry) =>
        entry &&
        typeof entry.agent === 'string' &&
        entry.agent &&
        typeof entry.expiresAt === 'number' &&
        entry.expiresAt > now
    )
    .slice(-MAX_RECENT_QUERIES)
  recentQueries = entries
  return entries
}

function persistRecentQueries(entries) {
  const limited = entries.slice(-MAX_RECENT_QUERIES)
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    queryPath,
    limited.length > 0 ? limited.map((entry) => JSON.stringify(entry)).join('\n') + '\n' : '',
    'utf8'
  )
  recentQueries = limited
  return limited
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

function writeJsonl(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    values.length > 0 ? values.map((value) => JSON.stringify(value)).join('\n') + '\n' : '',
    'utf8'
  )
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch (_) {
        return null
      }
    })
    .filter(Boolean)
}

let lastProjectCwd = null
let lastProjectName = null

function projectName() {
  const currentCwd = process.cwd()
  if (lastProjectCwd === currentCwd && lastProjectName) {
    return lastProjectName
  }
  lastProjectCwd = currentCwd
  if (runtimeContext.project) {
    lastProjectName = runtimeContext.project
    return lastProjectName
  }
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: currentCwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim()
    if (commonDir) {
      const repoRoot = path.dirname(commonDir)
      const name = path.basename(repoRoot)
      if (name) {
        lastProjectName = name
        return lastProjectName
      }
    }
  } catch (_) {
    // fall through to cwd basename
  }
  lastProjectName = path.basename(currentCwd)
  return lastProjectName
}

// Memory store: shared implementation with the CLI (`mio recall`/`mio remember`).
// The pure scoring/filter helpers and queryMemory/recordMemory live in
// server/memory-store.js so both entry points rank and persist identically.
const experienceStore = createExperienceStore({
  dataDir,
  projectName,
  // Preserves the phase0 summary these tools have always returned.
  phase0Summary: (project) => summarizePhase0(loadPhase0(dataDir, project)),
})
const {
  listReuse: listExperienceReuse,
  confirmReuse: confirmExperienceReuse,
  recordReuse: recordExperienceReuse,
} = experienceStore

const memoryStore = createMemoryStore({
  dataDir,
  projectName,
  agentId: runtimeAgentId,
  reuseMatchWindowMs: REUSE_MATCH_WINDOW_MS,
  verifiedFilter: REUSE_STATUS_FILTERS.verified,
  recordQuery(entry) {
    const entries = loadRecentQueries()
    entries.push(entry)
    persistRecentQueries(entries)
  },
})

const digestEngine = createDigest({ home: dataDir })

const {
  normalizeTags,
  tokenize,
  normalizeScope,
  isGlobalRecord,
  matchesProjectScope,
  latinTokens,
  cjkBigrams,
  scoreRecord,
  matchesMemoryFilters,
  queryMemory,
  recordMemory,
  queryTraces,
  analyzeMemory,
  archiveMemory,
  mergeMemory,
  migrateMemory,
  loadEvidenceWeights,
} = memoryStore

// policy.check reuses the memory store's tokenizer and scoring so its risk
// evidence and related-memory ranking match mio.memory.query exactly.
const policyStore = createPolicyStore({
  dataDir,
  projectName,
  memoryStore,
  tracePath,
  memoryPath,
})
const { policyCheck } = policyStore

// agent.list / register / report delegate to the shared store so the CLI
// (mio agents list / report) and this MCP tool report identical telemetry.
const agentStore = createAgentStore({ dataDir, projectName })
const { listAgents, reportAgent, registerAgent } = agentStore

// task.route delegates to the shared store so the CLI (`mio task route`) and
// this MCP tool route identically. The MCP keeps feeding the query log
// (auto-claim depends on it); the CLI passes persistQuery: false.
const taskStore = createTaskStore({
  dataDir,
  projectName,
  memoryStore,
  agentId: runtimeAgentId,
})
const { routeTask, autoClaimExperienceReuse, recordTaskOutcome } = taskStore

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
    agent: args.agent || runtimeAgentId(),
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


const SUBSCRIPTION_DEFAULT_TTL_DAYS = 30
const MAX_SUBSCRIPTIONS_PER_AGENT = 20
const MAX_DIGEST_EVENTS = 100

function readDigestState() {
  if (!fs.existsSync(digestStatePath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(digestStatePath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

function writeDigestState(state) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(digestStatePath, JSON.stringify(state), 'utf8')
}

function subscribeKey(agent, project, eventTypes, topic) {
  return `${agent}|${project}|${eventTypes.join(',')}|${topic || ''}`
}

function loadActiveSubscriptions(agent) {
  const now = Date.now()
  return readJsonl(subscriptionPath)
    .filter((subscription) => subscription && subscription.agent === agent)
    .filter((subscription) => {
      if (subscription.expiresAt) {
        const expires = new Date(subscription.expiresAt).getTime()
        if (Number.isFinite(expires) && expires <= now) return false
      }
      return true
    })
}

function subscribeObserver(args = {}) {
  const agent = runtimeAgentId() || 'mcp'
  const project = args.project || projectName()
  const eventTypes = Array.isArray(args.eventTypes)
    ? args.eventTypes.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : []
  const topic = args.topic ? String(args.topic).trim().slice(0, 120) : ''
  const ttlDays = Number(args.ttlDays) || SUBSCRIPTION_DEFAULT_TTL_DAYS
  const ttlMs = Math.max(1, ttlDays) * 24 * 60 * 60 * 1000

  const subscriptions = readJsonl(subscriptionPath)
  const key = subscribeKey(agent, project, eventTypes, topic)
  let existing = subscriptions.find((subscription) => {
    return (
      subscription &&
      subscribeKey(
        subscription.agent,
        subscription.project,
        subscription.eventTypes || [],
        subscription.topic || '',
      ) === key
    )
  })
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
  if (existing) {
    existing.updatedAt = now.toISOString()
    existing.expiresAt = expiresAt
  } else {
    existing = {
      id: createId('sub'),
      agent,
      project,
      eventTypes,
      topic: topic || null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt,
    }
    subscriptions.push(existing)
  }
  const agentSubscriptions = subscriptions.filter((subscription) => subscription.agent === agent)
  if (agentSubscriptions.length > MAX_SUBSCRIPTIONS_PER_AGENT) {
    throw new Error(`Too many subscriptions for agent ${agent} (max ${MAX_SUBSCRIPTIONS_PER_AGENT})`)
  }
  writeJsonl(subscriptionPath, subscriptions)
  return { subscribed: true, subscription: existing, project }
}

function observerDigest(args = {}) {
  const agent = runtimeAgentId() || 'mcp'
  const project = args.project || projectName()
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), MAX_DIGEST_EVENTS)
  const filterEventTypes = Array.isArray(args.eventTypes)
    ? args.eventTypes.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : null

  let subscriptions = loadActiveSubscriptions(agent)
  if (args.project) {
    subscriptions = subscriptions.filter((subscription) => subscription.project === project)
  }
  if (filterEventTypes) {
    subscriptions = subscriptions.filter((subscription) => {
      if ((subscription.eventTypes || []).length === 0) return true
      return filterEventTypes.some((eventType) =>
        (subscription.eventTypes || []).includes(eventType),
      )
    })
  }

  const state = readDigestState()
  const traces = readJsonl(tracePath)
  const digestTime = new Date().toISOString()
  const events = []
  const seenIds = new Set()
  const matchedSubscriptionIds = new Set()

  for (const subscription of subscriptions) {
    const cursor = state[subscription.id] || null
    const cursorTime = cursor ? Date.parse(cursor) : null
    const subscriptionEventTypes = subscription.eventTypes || []
    let lastEventTime = null
    for (const event of traces) {
      if (subscription.project && event.project && event.project !== subscription.project) {
        continue
      }
      if (
        subscriptionEventTypes.length > 0 &&
        !subscriptionEventTypes.includes(String(event.event_type || '').toLowerCase())
      ) {
        continue
      }
      if (subscription.topic) {
        const haystack = `${event.event_type || ''} ${JSON.stringify(event.payload || {})}`
          .toLowerCase()
        if (!haystack.includes(subscription.topic.toLowerCase())) continue
      }
      const eventTime = event.timestamp ? Date.parse(event.timestamp) : null
      if (cursorTime !== null && eventTime !== null && eventTime <= cursorTime) continue
      if (eventTime !== null && (lastEventTime === null || eventTime > lastEventTime)) {
        lastEventTime = eventTime
      }
      if (seenIds.has(event.id)) continue
      seenIds.add(event.id)
      events.push({
        id: event.id,
        trace_id: event.trace_id || null,
        event_type: event.event_type,
        outcome: event.outcome || null,
        timestamp: event.timestamp,
        agent: event.agent || null,
        payload: event.payload || null,
      })
      matchedSubscriptionIds.add(subscription.id)
      if (events.length >= limit) break
    }
    if (lastEventTime !== null) {
      state[subscription.id] = new Date(lastEventTime).toISOString()
    } else if (cursor === null) {
      state[subscription.id] = digestTime
    }
    if (events.length >= limit) break
  }

  writeDigestState(state)
  return {
    project,
    agent,
    subscriptionCount: subscriptions.length,
    matchedSubscriptions: Array.from(matchedSubscriptionIds),
    count: events.length,
    events,
  }
}



function phase0Report(args = {}) {
  const project = args.project || projectName()
  const report = loadPhase0(dataDir, project)
  const format = String(args.format || 'json').trim().toLowerCase()
  if (format === 'markdown') {
    return {
      project,
      format: 'markdown',
      markdown: renderPhase0Markdown(report),
    }
  }
  return {
    project,
    ...report,
  }
}

const TOOLS = [
  {
    name: 'mio.memory.query',
    description: 'Search local Mio project memory for context, decisions, and historical problems.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question or topic to recall.' },
        project: { type: 'string', description: 'Project name filter. Defaults to current directory name.' },
        limit: { type: 'number', description: 'Maximum results, between 1 and 20. Defaults to 5.' },
        kind: { type: 'string', description: 'Only return records with this kind (decision, context, problem, note).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Only return records containing all of these tags (AND).' },
        scope: { type: 'string', description: 'Search scope: project (default), global, or all.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mio.memory.archive',
    description: 'Archive (or restore) memory records by id. Archived records are excluded from memory.query and memory.analyze.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Memory record ids to archive or restore.' },
        project: { type: 'string', description: 'Project name filter. Defaults to current repository.' },
        restore: { type: 'boolean', description: 'When true, un-archive the given ids instead.' },
        reason: { type: 'string', description: 'Optional archive reason.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'mio.memory.merge',
    description: 'Merge near-duplicate memory records into one survivor: the survivor gains a supersedes list and the others are archived. Refuses to merge records whose content differs unless keep and allowDivergent are both given, because concatenating divergent bodies corrupts them. Reversible via mio.memory.archive with restore.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Memory record ids to merge (at least 2).' },
        project: { type: 'string', description: 'Project name filter. Defaults to current repository.' },
        keep: { type: 'string', description: 'Id of the record whose content survives. Defaults to the newest record in the set.' },
        allowDivergent: { type: 'boolean', description: 'When true, allow merging records whose content differs. Requires keep so the surviving body is explicit.' },
        reason: { type: 'string', description: 'Optional merge reason.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'mio.memory.migrate',
    description: 'Migrate memory records between project and global layers (P3). Moving to global makes the record reusable across projects (project set to null); moving to project restores project scoping.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Memory record ids to migrate.' },
        scope: { type: 'string', description: 'Target layer: global or project.' },
        project: { type: 'string', description: 'Target project for project scope. Defaults to current repository.' },
        reason: { type: 'string', description: 'Optional migration reason.' },
      },
      required: ['ids', 'scope'],
    },
  },
  {
    name: 'mio.memory.record',
    description: 'Record a decision, project context, or historical problem into local Mio memory.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Memory content.' },
        kind: { type: 'string', description: 'Memory kind, such as decision, context, or problem.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        project: { type: 'string', description: 'Project name. Defaults to current directory name.' },
        scope: { type: 'string', description: 'Record scope: project (default) or global.' },
        source: { type: 'string', description: 'Recording source. Defaults to mcp.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'mio.observer.ingest',
    description: 'Ingest an Agent Trace event such as tool_call, error, retry, or task_outcome.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'Stable trace identifier.' },
        event_type: { type: 'string', description: 'Event type, such as tool_call, error, retry, task_outcome.' },
        payload: { type: 'object', description: 'Event payload.' },
        outcome: { type: 'string', description: 'Optional outcome: success, failure, error, aborted, retry.' },
        agent: { type: 'string', description: 'Agent identifier.' },
        host: { type: 'string', description: 'Host name. Defaults to mcp.' },
        project: { type: 'string', description: 'Project name. Defaults to current directory name.' },
      },
      required: ['trace_id', 'event_type'],
    },
  },
  {
    name: 'mio.trace.query',
    description: 'Query the observer trace log (traces.jsonl): task outcomes, tool errors, and ingested events. Newest first, with counts by event_type and outcome over the full filtered set.',
    inputSchema: {
      type: 'object',
      properties: {
        event_type: { type: 'string', description: 'Filter by event type (e.g. task_outcome, error, tool_call).' },
        outcome: { type: 'string', description: 'Filter by outcome (success, failure, error, aborted).' },
        project: { type: 'string', description: 'Project name filter. Defaults to current repository; pass empty string for all projects.' },
        agent: { type: 'string', description: 'Filter by agent identifier (e.g. codex, claude-code, cli).' },
        host: { type: 'string', description: 'Filter by host identifier.' },
        since: { type: 'string', description: 'Only traces at or after this time (ISO 8601 or epoch ms).' },
        until: { type: 'string', description: 'Only traces at or before this time (ISO 8601 or epoch ms).' },
        limit: { type: 'number', description: 'Maximum traces to return (1-200). Defaults to 20.' },
        include_payload: { type: 'boolean', description: 'Include full payload objects (default true). Set false for compact listings.' },
      },
    },
  },
  {
    name: 'mio.digest.generate',
    description: 'Generate an actionable digest from recent traces/memory/reuse data: task throughput and success rates per agent, project activity, error hotspots, reuse evidence, and rule-based suggestions. Returns the report object with a markdown field.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look-back window in days. Defaults to 7.' },
        project: { type: 'string', description: 'Restrict the digest to one project. Defaults to all projects.' },
      },
    },
  },
  {
    name: 'mio.observer.subscribe',
    description: 'Subscribe to observer events (project, event types, optional topic). New matching events are delivered via mio.observer.digest.',
    inputSchema: {
      type: 'object',
      properties: {
        eventTypes: { type: 'array', items: { type: 'string' }, description: 'Event types to watch, e.g. error, retry, task_outcome. Empty means all.' },
        project: { type: 'string', description: 'Project name. Defaults to current repository.' },
        topic: { type: 'string', description: 'Optional keyword; only events whose payload mentions it match.' },
        ttlDays: { type: 'number', description: 'Subscription lifetime in days. Defaults to 30.' },
      },
    },
  },
  {
    name: 'mio.observer.digest',
    description: 'Return new observer events matching active subscriptions since the last digest, and advance the cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name filter. Defaults to current repository.' },
        eventTypes: { type: 'array', items: { type: 'string' }, description: 'Optional extra event type filter.' },
        limit: { type: 'number', description: 'Maximum events to return, 1-100. Defaults to 20.' },
      },
    },
  },
  {
    name: 'mio.policy.check',
    description: 'Check historical risk for an action before executing it, returning risk level, outcome counts, and recent failure examples.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'The action or tool operation to check.' },
        project: { type: 'string', description: 'Project name filter. Defaults to current directory name.' },
        context: { type: 'string', description: 'Optional additional context.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mio.memory.analyze',
    description: 'Analyze local Mio memory quality: kind distribution, duplicate groups, and low-quality records.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name filter. Defaults to current repository.' },
        limit: { type: 'number', description: 'Maximum duplicates/low-quality examples to return, 1-20. Defaults to 5.' },
      },
    },
  },
  {
    name: 'mio.experience.reuse',
    description: 'Record Phase 0 evidence of cross-agent experience reuse.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgent: { type: 'string', description: 'Agent that produced the experience.' },
        targetAgent: { type: 'string', description: 'Agent that reused the experience.' },
        experienceId: { type: 'string', description: 'Stable experience or memory id.' },
        reuse: { type: 'boolean', description: 'True when memory.query returned historical experience and it was reused.' },
        behaviorChanged: { type: 'boolean', description: 'True when target Agent behavior changed because of the reused experience.' },
        outcomeImproved: { type: 'boolean', description: 'True when the task outcome improved.' },
        project: { type: 'string', description: 'Project name filter. Defaults to current repository.' },
        notes: { type: 'string', description: 'Optional evidence notes.' },
      },
      required: ['sourceAgent', 'targetAgent', 'experienceId', 'reuse', 'behaviorChanged', 'outcomeImproved'],
    },
  },
  {
    name: 'mio.experience.confirm',
    description: 'Confirm an auto-claimed reuse record as verified reuse evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the auto-claimed reuse record returned by mio.observer.ingest.' },
        confirmedBy: { type: 'string', description: 'Who confirmed the reuse: agent or human. Defaults to agent.' },
        outcomeImproved: { type: 'boolean', description: 'Override: true when the reused experience improved the task outcome. Defaults to the auto-claim value.' },
        notes: { type: 'string', description: 'Optional confirmation notes.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mio.experience.list',
    description: 'List Phase 0 experience reuse evidence, optionally filtered by status or target agent.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name filter. Defaults to current repository.' },
        status: { type: 'string', description: 'Filter: pending (auto-claim awaiting confirmation), confirmed, verified, auto_claim, agent_report, all. Defaults to all.' },
        targetAgent: { type: 'string', description: 'Filter records by target agent.' },
        limit: { type: 'number', description: 'Maximum records to return, 1-100. Defaults to 20.' },
      },
    },
  },
  {
    name: 'mio.phase0.report',
    description: 'Generate the current Phase 0 cross-agent validation report, as JSON or rendered Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name filter. Defaults to current repository.' },
        format: { type: 'string', description: 'Output format: json or markdown. Defaults to json.' },
      },
    },
  },
  {
    name: 'mio.task.route',
    description: 'Route an incoming task to the most relevant verified experiences and related memories, and include an agent-health signal (from the latest digest) saying which agents to prefer or avoid. Turns recall plus observed performance into decision influence (P1).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description to route, e.g. \'fix IPC communication bug\'.' },
        project: { type: 'string', description: 'Project name filter. Defaults to current repository.' },
        scope: { type: 'string', description: 'Search scope: project (default), global, or all.' },
        limit: { type: 'number', description: 'Maximum routes, between 1 and 10. Defaults to 5.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'mio.agent.register',
    description: 'Register or update an agent in the Mio Agent Registry. Upserts by agentId+project; updates lastSeenAt and sessionCount.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Unique agent identifier (e.g. codex, opencode).' },
        hostType: { type: 'string', description: 'Host type: mcp, observer, or plugin. Defaults to mcp.' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Agent capabilities.' },
        project: { type: 'string', description: 'Project name. Defaults to current directory name.' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'mio.agent.list',
    description: 'List all registered agents, optionally filtered by project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name filter. Omit for all agents.' },
      },
    },
  },
  {
    name: 'mio.agent.report',
    description: 'Performance report for one or all agents, aggregating task outcomes, memory, and experience reuse.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent to report on. Omit for all agents.' },
        project: { type: 'string', description: 'Project name filter. Defaults to current repository.' },
      },
    },
  },
  {
    name: 'mio.evolution.report',
    description: 'Generate cross-agent evolution report: ecosystem summary, agent performance comparison, cross-agent patterns, memory health, and optimization suggestions (ADR-017 Evolution plane).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name filter. Defaults to current repository.' },
        period: { type: 'string', description: 'Time window: 24h, 7d, 30d, or all (default).' },
      },
    },
  },
  {
    name: 'mio.evolution.status',
    description: 'Report composed mio-agent-runtime module health from the canonical runtime module registry.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'mio.host.capabilities',
    description: 'List installed desktop host adapters and the safe capability surface they expose to runtime modules.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'mio.evolution.shadow.record',
    description: 'Record a shadow comparison between legacy and modular runtime outputs without changing authority.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Human-readable comparison label.' },
        project: { type: 'string', description: 'Project name. Defaults to current repository.' },
        legacy: { type: 'object', description: 'Legacy path output snapshot.' },
        modular: { type: 'object', description: 'Modular path output snapshot.' },
        input: { type: 'object', description: 'Optional sanitized input snapshot.' },
      },
      required: ['legacy', 'modular'],
    },
  },
  {
    name: 'mio.evolution.dual_write.record',
    description: 'Record a dual-write sample result for legacy and modular state paths without switching authority.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Human-readable dual-write label.' },
        project: { type: 'string', description: 'Project name. Defaults to current repository.' },
        authoritative: { type: 'string', description: 'Authoritative path: legacy or modular. Defaults to legacy.' },
        legacyResult: { type: 'object', description: 'Legacy write result snapshot.' },
        modularResult: { type: 'object', description: 'Modular write result snapshot.' },
        record: { type: 'object', description: 'Optional sanitized record metadata.' },
      },
      required: ['legacyResult', 'modularResult'],
    },
  },
  {
    name: 'mio.evolution.cutover.readiness',
    description: 'Assess whether shadow and dual-write samples are sufficient to consider modular runtime cutover.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name. Defaults to current repository.' },
        minShadowRuns: { type: 'number', description: 'Minimum shadow comparison samples required. Defaults to 5.' },
        maxMismatchRate: { type: 'number', description: 'Allowed shadow mismatch rate. Defaults to 0.' },
      },
    },
  },
  {
    name: 'mio.evolution.migration.plan',
    description: 'Preview a state migration plan between legacy and modular records without writing state.',
    inputSchema: {
      type: 'object',
      properties: {
        legacyRecords: { type: 'array', items: { type: 'object' }, description: 'Legacy state records.' },
        modularRecords: { type: 'array', items: { type: 'object' }, description: 'Existing modular state records.' },
      },
    },
  },
  {
    name: 'mio.evolution.authority.plan',
    description: 'Create a gated authority switch plan from legacy to modular runtime without applying it.',
    inputSchema: {
      type: 'object',
      properties: {
        readiness: { type: 'object', description: 'Result from mio.evolution.cutover.readiness.' },
        from: { type: 'string', description: 'Current authoritative path. Defaults to legacy.' },
        to: { type: 'string', description: 'Target authoritative path. Defaults to modular.' },
      },
      required: ['readiness'],
    },
  },
  {
    name: 'mio.evolution.cutover.apply',
    description: 'Dry-run an authority switch plan. This stage refuses real cutover and never mutates authority state.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: 'Must be true. Real cutover is intentionally gated.' },
        project: { type: 'string', description: 'Project name. Defaults to current repository.' },
        plan: { type: 'object', description: 'Authority switch plan from mio.evolution.authority.plan.' },
      },
      required: ['dryRun', 'plan'],
    },
  },
  {
    name: 'mio.task.record_outcome',
    description: 'Record task outcome with agent registry update and auto-claim experience reuse in one atomic call. Combines observer.ingest + agent stats + auto-claim for a complete task lifecycle closure.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', description: 'Task outcome: success, failure, or aborted.' },
        task: { type: 'string', description: 'Brief task description.' },
        summary: { type: 'string', description: 'Optional task summary.' },
        verification: { type: 'string', description: 'Optional verification details.' },
        agentId: { type: 'string', description: 'Agent identifier. Defaults to MIO_CONTEXT agentId.' },
        project: { type: 'string', description: 'Project name. Defaults to current repository.' },
        traceId: { type: 'string', description: 'Optional custom trace ID. Auto-generated if omitted.' },
      },
      required: ['outcome'],
    },
  },
  {
    name: 'mio.creativity.status',
    description: 'Show creativity engine status: hypothesis counts, active/validated/rejected, recent top ideas.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mio.creativity.list',
    description: 'List creativity hypotheses with optional status filter.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: active, validated, rejected, draft.' },
        limit: { type: 'number', description: 'Max results. Default 20.' },
      },
    },
  },
  {
    name: 'mio.creativity.generate',
    description: 'Generate new creative hypotheses by combining concept sources via LLM. Returns ideas with novelty/feasibility/impact scores.',
    inputSchema: {
      type: 'object',
      properties: {
        sources: {
          type: 'array',
          description: 'Concept sources to combine. Each has name, content, type (knowledge/behavior/insight/failure), weight.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              content: { type: 'string' },
              type: { type: 'string' },
              weight: { type: 'number' },
            },
            required: ['name', 'content'],
          },
        },
        strategy: { type: 'string', description: 'Generation strategy: explore (cross-domain), signal (provocative), stable (conservative). Auto-selected if omitted.' },
      },
      required: ['sources'],
    },
  },
  {
    name: 'mio.creativity.ferment',
    description: 'Ferment (review and refine) active hypotheses. Updates scores, can promote/reject ideas.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max hypotheses to ferment. Default 5.' },
      },
    },
  },

  // ═══ Observer Research Pipeline ═══

  // ═══ Insight Self-Observation ═══

  ...(isInsightAvailable() ? [{
    name: 'mio.insight.status',
    description: 'Get insight engine status: total insights, unreported count, cooldown.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mio.insight.list',
    description: 'List stored insights with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        unreported: { type: 'boolean', description: 'Only unreported insights' },
        minScore: { type: 'number', description: 'Minimum score filter' },
        detector: { type: 'string', description: 'Filter by detector name' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'mio.insight.mark_reported',
    description: 'Mark insights as reported (acknowledged).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Insight IDs to mark' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'mio.insight.generate',
    description: 'Run LLM-based insight generation from provided context data.',
    inputSchema: {
      type: 'object',
      properties: {
        memories: { type: 'array', items: { type: 'object' }, description: 'Memory entries to analyze' },
        summaries: { type: 'array', items: { type: 'string' }, description: 'Recent summaries' },
        plans: { type: 'array', items: { type: 'object' }, description: 'Active plans' },
      },
    },
  }] : []),

  // ═══ Observer Research Pipeline ═══

  ...(isObserverAvailable() ? [{
    name: 'mio.observer.world_model',
    description: 'Query the Observer world model: entities, events, trends, narratives, uncertainties, and relations.',
    inputSchema: {
      type: 'object',
      properties: {
        baseDir: { type: 'string', description: 'Observer data directory (default: .local/observer)' },
      },
    },
  },
  {
    name: 'mio.observer.trends',
    description: 'Get recent trend reports from the Observer pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Specific date (YYYY-MM-DD) or null for latest' },
        limit: { type: 'number', description: 'Max reports to return (default 7)' },
        baseDir: { type: 'string', description: 'Observer data directory' },
      },
    },
  },
  {
    name: 'mio.observer.research',
    description: 'List recent deep research results from the Observer pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 10)' },
        baseDir: { type: 'string', description: 'Observer data directory' },
      },
    },
  },
  {
    name: 'mio.observer.insights',
    description: 'List Observer-generated insights (5-section structured articles).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max insights (default 20)' },
        baseDir: { type: 'string', description: 'Observer data directory' },
      },
    },
  },
  {
    name: 'mio.observer.status',
    description: 'Get Observer pipeline status: counts of observations, trends, topics, research, insights, essays, and world model entities.',
    inputSchema: {
      type: 'object',
      properties: {
        baseDir: { type: 'string', description: 'Observer data directory' },
      },
    },
  },
  {
    name: 'mio.observer.collect',
    description: 'Force data collection from all configured sources (RSS, Bilibili, HackerNews, GitHub, Douyin). Returns collected observations.',
    inputSchema: {
      type: 'object',
      properties: {
        sources: { type: 'array', items: { type: 'string' }, description: 'Specific sources to collect (default: all)' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keyword filter (OR match)' },
        limit: { type: 'number', description: 'Max items per source (default 20)' },
        baseDir: { type: 'string', description: 'Observer data directory' },
      },
    },
  },
  {
    name: 'mio.observer.ferment',
    description: 'Run fermentation engine: find recurring themes across recent observations and optionally write an essay.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session label: morning/afternoon/night (default: afternoon)' },
        baseDir: { type: 'string', description: 'Observer data directory' },
      },
    },
  },
  {
    name: 'mio.observer.essays',
    description: 'List published or draft essays from the Observer.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'published or draft (default: published)' },
        limit: { type: 'number', description: 'Max essays (default 10)' },
        baseDir: { type: 'string', description: 'Observer data directory' },
      },
    },
  },
  {
    name: 'mio.observer.dag',
    description: 'Get DAG state machine status: today\'s task, recent summaries, retryable tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Days to look back (default 7)' },
        baseDir: { type: 'string', description: 'Observer data directory' },
      },
    },
  }] : []),
]

// ═══ Insight Self-Observation Handlers ═══
// Thin delegates to ../insight-store.js: the store owns the implementation so
// `mio insight` (CLI) and mio.insight.* (MCP) cannot drift.

function insightStatus() {
  return insightStore.status()
}

function insightList(args = {}) {
  return insightStore.list(args)
}

function insightMarkReported(args = {}) {
  return insightStore.markReported(args)
}

async function insightGenerate(args = {}) {
  return insightStore.generate(args)
}

// ═══ Observer Research Pipeline Handlers ═══
// Thin delegates to ../observer-store.js (same rationale as above).
// readJsonSafe / readJsonlSafe / getObserverBaseDir used to live here; they now
// live with the store, which is their only consumer.

function observerWorldModel(args = {}) {
  return observerStore.worldModel(args)
}

function observerTrends(args = {}) {
  return observerStore.trends(args)
}

function observerResearch(args = {}) {
  return observerStore.research(args)
}

function observerInsights(args = {}) {
  return observerStore.insights(args)
}

function observerStatus(args = {}) {
  return observerStore.status(args)
}

function observerCollect(args = {}) {
  return observerStore.collect(args)
}

function observerFerment(args = {}) {
  return observerStore.ferment(args)
}

function observerEssays(args = {}) {
  return observerStore.essays(args)
}

function observerDag(args = {}) {
  return observerStore.dag(args)
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'mio.memory.query':
      return queryMemory(args)
    case 'mio.memory.record':
      return recordMemory(args)
    case 'mio.memory.archive':
      return archiveMemory(args)
    case 'mio.memory.merge':
      return mergeMemory(args)
    case 'mio.memory.migrate':
      return migrateMemory(args)
    case 'mio.observer.ingest':
      return ingestObservation(args)
    case 'mio.observer.subscribe':
      return subscribeObserver(args)
    case 'mio.observer.digest':
      return observerDigest(args)
    case 'mio.digest.generate':
      return digestEngine.generate({ days: args.days, project: args.project })
    case 'mio.trace.query':
      return queryTraces(args)
    case 'mio.policy.check':
      return policyCheck(args)
    case 'mio.memory.analyze':
      return analyzeMemory(args)
    case 'mio.experience.reuse':
      return recordExperienceReuse(args)
    case 'mio.experience.confirm':
      return confirmExperienceReuse(args)
    case 'mio.experience.list':
      return listExperienceReuse(args)
    case 'mio.phase0.report':
      return phase0Report(args)
    case 'mio.task.route':
      return routeTask(args)
    case 'mio.agent.register':
      return registerAgent(args)
    case 'mio.agent.list':
      return listAgents(args)
    case 'mio.agent.report':
      return reportAgent(args)
    case 'mio.evolution.report':
      return evolutionReport(args)
    case 'mio.evolution.status':
      return getEvolutionStatus()
    case 'mio.host.capabilities':
      return listHostCapabilities()
    case 'mio.evolution.shadow.record':
      return evolutionCutover.recordShadowComparison(args)
    case 'mio.evolution.dual_write.record':
      return evolutionCutover.recordDualWrite(args)
    case 'mio.evolution.cutover.readiness':
      return evolutionCutover.cutoverReadiness(args)
    case 'mio.evolution.migration.plan':
      return evolutionCutover.migrationPlan(args)
    case 'mio.evolution.authority.plan':
      return evolutionCutover.authorityPlan(args)
    case 'mio.evolution.cutover.apply':
      return evolutionCutover.applyCutover(args)
    case 'mio.task.record_outcome':
      return recordTaskOutcome(args)
    case 'mio.creativity.status':
      return creativityEngine.status()
    case 'mio.creativity.list':
      return creativityEngine.list(args)
    case 'mio.creativity.generate':
      return creativityEngine.generate(args.sources, args.strategy)
    case 'mio.creativity.ferment':
      return creativityEngine.ferment(args.limit)
    case 'mio.insight.status':
      return insightStatus()
    case 'mio.insight.list':
      return insightList(args)
    case 'mio.insight.mark_reported':
      return insightMarkReported(args)
    case 'mio.insight.generate':
      return insightGenerate(args)
    case 'mio.observer.world_model':
      return observerWorldModel(args)
    case 'mio.observer.trends':
      return observerTrends(args)
    case 'mio.observer.research':
      return observerResearch(args)
    case 'mio.observer.insights':
      return observerInsights(args)
    case 'mio.observer.status':
      return observerStatus(args)
    case 'mio.observer.collect':
      return observerCollect(args)
    case 'mio.observer.ferment':
      return observerFerment(args)
    case 'mio.observer.essays':
      return observerEssays(args)
    case 'mio.observer.dag':
      return observerDag(args)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id, error }
}

function send(message) {
  if (message) process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return
  if (message.method && message.method.startsWith('notifications/')) return
  if (message.id === undefined) return

  try {
    if (message.method === 'initialize') {
      send(
        jsonRpcResult(message.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        })
      )
      return
    }
    if (message.method === 'ping') {
      send(jsonRpcResult(message.id, {}))
      return
    }
    if (message.method === 'tools/list') {
      send(jsonRpcResult(message.id, { tools: TOOLS }))
      return
    }
    if (message.method === 'tools/call') {
      const name = message.params && message.params.name
      const args = (message.params && message.params.arguments) || {}
      const result = await callTool(name, args)
      send(
        jsonRpcResult(message.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        })
      )
      return
    }
    send(jsonRpcError(message.id, -32601, `Method not found: ${message.method}`))
  } catch (error) {
    send(jsonRpcError(message.id, -32603, error.message || String(error)))
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch (_) {
    return
  }
  handleMessage(message).catch((error) => {
    send(jsonRpcError(message && message.id, -32603, error.message || String(error)))
  })
})

rl.on('close', () => {
  if (require.main === module) {
    process.exit(0)
  }
})


function evolutionReport(args = {}) {
  const project = args.project || projectName()
  const period = String(args.period || 'all').trim()
  const now = Date.now()
  const periodMs = period === '24h' ? 86400000 : period === '7d' ? 604800000 : period === '30d' ? 2592000000 : Infinity
  const cutoff = periodMs === Infinity ? 0 : now - periodMs

  const memories = readJsonl(memoryPath).filter((m) => !project || m.project === project || !m.project)
  const traces = readJsonl(tracePath).filter((t) => !project || t.project === project)
  const reuses = readJsonl(experienceReusePath).filter((r) => !project || r.project === project)
  const agents = readJsonl(agentsPath).filter((a) => !project || a.project === project)
  const queries = readJsonl(queryPath).filter((q) => !project || q.project === project)

  const filteredTraces = cutoff ? traces.filter((t) => new Date(t.timestamp).getTime() >= cutoff) : traces
  const filteredMemories = cutoff ? memories.filter((m) => new Date(m.timestamp).getTime() >= cutoff) : memories

  // Ecosystem summary
  const agentIds = new Set()
  filteredTraces.forEach((t) => { if (t.agent) agentIds.add(t.agent) })
  agents.forEach((a) => agentIds.add(a.agentId))
  const outcomes = filteredTraces.filter((t) => t.event_type === 'task_outcome')
  const successes = outcomes.filter((t) => t.outcome === 'success').length
  const failures = outcomes.filter((t) => t.outcome === 'failure').length
  const verifiedReuses = reuses.filter((r) => r.confirmed && r.reuse && r.behaviorChanged && r.outcomeImproved)
  const pendingReuses = reuses.filter((r) => r.source === 'auto_claim' && !r.confirmed)

  const ecosystem = {
    agents: agentIds.size,
    totalTasks: outcomes.length,
    successRate: outcomes.length > 0 ? Math.round((successes / outcomes.length) * 100) : 0,
    totalMemories: filteredMemories.length,
    totalReuses: reuses.length,
    verifiedReuses: verifiedReuses.length,
    pendingReuses: pendingReuses.length,
  }

  // Agent performance comparison
  const agentPerf = []
  for (const agentId of agentIds) {
    const agentTraces = filteredTraces.filter((t) => t.agent === agentId)
    const agentOutcomes = agentTraces.filter((t) => t.event_type === 'task_outcome')
    const agentSuccesses = agentOutcomes.filter((t) => t.outcome === 'success').length
    const agentFailures = agentOutcomes.filter((t) => t.outcome === 'failure').length
    const agentMemories = filteredMemories.filter((m) => m.source === agentId)
    const agentVerified = reuses.filter((r) =>
      (r.sourceAgent === agentId || r.targetAgent === agentId) && r.confirmed && r.reuse && r.behaviorChanged && r.outcomeImproved
    )
    const reg = agents.find((a) => a.agentId === agentId)
    agentPerf.push({
      agentId,
      tasks: {
        total: agentOutcomes.length,
        success: agentSuccesses,
        failure: agentFailures,
        successRate: agentOutcomes.length > 0 ? Math.round((agentSuccesses / agentOutcomes.length) * 100) : 0,
      },
      memories: agentMemories.length,
      verifiedReuses: agentVerified.length,
      registered: !!reg,
      lastActive: reg ? reg.lastSeenAt : (agentTraces.length > 0 ? agentTraces[agentTraces.length - 1].timestamp : null),
    })
  }
  agentPerf.sort((a, b) => b.tasks.successRate - a.tasks.successRate || b.tasks.total - a.tasks.total)

  // Cross-agent patterns
  const crossPatterns = []
  const reuseByPair = {}
  for (const r of reuses) {
    const key = r.sourceAgent + '->' + r.targetAgent
    if (!reuseByPair[key]) reuseByPair[key] = { source: r.sourceAgent, target: r.targetAgent, total: 0, verified: 0, improved: 0 }
    reuseByPair[key].total++
    if (r.confirmed) reuseByPair[key].verified++
    if (r.outcomeImproved) reuseByPair[key].improved++
  }
  for (const [key, pair] of Object.entries(reuseByPair)) {
    if (pair.source !== pair.target) {
      crossPatterns.push({
        type: 'reuse_path',
        from: pair.source,
        to: pair.target,
        total: pair.total,
        verified: pair.verified,
        improved: pair.improved,
      })
    }
  }
  crossPatterns.sort((a, b) => b.verified - a.verified || b.total - a.total)

  // Memory health
  const byKind = {}
  let shortContent = 0
  let missingKind = 0
  for (const m of filteredMemories) {
    const kind = m.kind || 'unknown'
    byKind[kind] = (byKind[kind] || 0) + 1
    const content = String(m.content || '').trim()
    if (content.length < 20) shortContent++
    if (!m.kind) missingKind++
  }
  const memoryHealth = {
    total: filteredMemories.length,
    byKind,
    shortContent,
    missingKind,
    qualityScore: filteredMemories.length > 0
      ? Math.round(((filteredMemories.length - shortContent - missingKind) / filteredMemories.length) * 100)
      : 100,
  }

  // Suggestions engine
  const suggestions = []

  // Routing suggestion: compare agent success rates
  if (agentPerf.length >= 2) {
    const best = agentPerf[0]
    const worst = agentPerf[agentPerf.length - 1]
    if (best.tasks.total >= 5 && worst.tasks.total >= 5 && best.tasks.successRate - worst.tasks.successRate >= 15) {
      suggestions.push({
        category: 'routing',
        priority: 'high',
        description: best.agentId + ' has ' + best.tasks.successRate + '% success rate vs ' + worst.agentId + ' at ' + worst.tasks.successRate + '%; prefer routing to ' + best.agentId,
        basedOn: 'task_outcome comparison',
      })
    }
  }

  // Pending auto-claim suggestion
  if (pendingReuses.length >= 10) {
    suggestions.push({
      category: 'evidence',
      priority: 'medium',
      description: pendingReuses.length + ' pending auto-claims awaiting confirmation; review cross-agent claims to increase verified reuse count',
      basedOn: 'experience_reuse.jsonl',
    })
  }

  // Memory quality suggestion
  if (memoryHealth.qualityScore < 80 && filteredMemories.length > 10) {
    suggestions.push({
      category: 'memory',
      priority: 'medium',
      description: 'Memory quality score is ' + memoryHealth.qualityScore + '%; ' + shortContent + ' short records and ' + missingKind + ' missing kind fields found',
      basedOn: 'memory.jsonl quality analysis',
    })
  }

  // Cross-agent value suggestion
  if (crossPatterns.length === 0 && agentIds.size >= 2) {
    suggestions.push({
      category: 'interop',
      priority: 'high',
      description: 'Multiple agents registered but no cross-agent reuse patterns detected; ensure agents query shared memory',
      basedOn: 'experience_reuse.jsonl',
    })
  }

  // Active agent suggestion
  const inactiveAgents = agentPerf.filter((a) => {
    if (!a.lastActive) return false
    return (now - new Date(a.lastActive).getTime()) > 7 * 86400000
  })
  if (inactiveAgents.length > 0) {
    suggestions.push({
      category: 'coverage',
      priority: 'low',
      description: inactiveAgents.map((a) => a.agentId).join(', ') + ' inactive for >7 days; consider removal or reactivation',
      basedOn: 'agent registry lastSeenAt',
    })
  }

  suggestions.sort((a, b) => {
    const p = { high: 0, medium: 1, low: 2 }
    return (p[a.priority] || 2) - (p[b.priority] || 2)
  })

  return {
    project,
    generatedAt: new Date().toISOString(),
    period,
    ecosystem,
    agentPerformance: agentPerf,
    crossAgentPatterns: crossPatterns,
    memoryHealth,
    suggestions,
  }
}



module.exports = { TOOLS, callTool, handleMessage, readJsonl, appendJsonl, rl }
