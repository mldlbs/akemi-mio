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
const { createDigest } = require('../digest.js')

const { CreativityEngine } = require('../creativity-engine.js')

// Observer research pipeline (optional — installed via @akemi-mio/observer)
let ObserverStore = null
let ObserverService = null
try {
  const obs = require('@akemi-mio/observer')
  ObserverStore = obs.ObserverStore
  ObserverService = obs.ObserverService
} catch {}

// Insight self-observation engine (optional — installed via @akemi-mio/insight)
let InsightStore = null
let InsightGenerator = null
let PresenceService = null
try {
  const insight = require('@akemi-mio/insight')
  InsightStore = insight.InsightStore
  InsightGenerator = insight.InsightGenerator
  PresenceService = insight.PresenceService
} catch {}

const SERVER_INFO = { name: 'mio-intelligence-mcp', version: '0.1.0' }
const PROTOCOL_VERSION = '2024-11-05'

// ═══════════════════════════════════════════════
//  LLM chatJson — used by creativity engine
// ═══════════════════════════════════════════════

async function chatJson(userText, opts = {}) {
  const apiUrl = process.env.LLM_API_URL || 'https://opencode.ai/zen/go/v1/chat/completions'
  const apiKey = process.env.LLM_KEY || ''
  const model = process.env.LLM_CHAT_MODEL || process.env.LLM_MODEL || 'deepseek-v4-flash'
  const system = opts.system || 'You are a creative AI assistant. Output JSON.'
  const temperature = opts.temperature ?? 0.3

  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userText },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 30000),
    })

    if (!resp.ok) return { error: `HTTP ${resp.status}` }
    const json = await resp.json()
    const text = json.choices?.[0]?.message?.content || ''
    try {
      return { data: JSON.parse(text) }
    } catch {
      return { data: text }
    }
  } catch (err) {
    return { error: String(err) }
  }
}

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
const insightStore = InsightStore ? new InsightStore(path.join(dataDir, 'insights', 'insights.json')) : null

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
const REUSE_STATUS_FILTERS = Object.freeze({
  pending: (record) => record.source === 'auto_claim' && record.confirmed !== true,
  confirmed: (record) => record.confirmed === true,
  verified: (record) =>
    (record.reuse === true || record.reuse === 'true') &&
    (record.behaviorChanged === true || record.behaviorChanged === 'true') &&
    (record.outcomeImproved === true || record.outcomeImproved === 'true'),
  auto_claim: (record) => record.source === 'auto_claim',
  agent_report: (record) => record.source !== 'auto_claim',
})

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
  loadEvidenceWeights,
} = memoryStore

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

function buildAutoClaim(entry, event, targetAgent) {
  const crossSourceIndex = entry.resultSources.findIndex(
    (source) => source && String(source).toLowerCase() !== targetAgent.toLowerCase()
  )
  const sourceAgent =
    crossSourceIndex >= 0
      ? String(entry.resultSources[crossSourceIndex])
      : targetAgent
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

function contentTokens(value) {
  const text = String(value || '').toLowerCase()
  const latin = text.match(/[a-z0-9]+/g) || []
  const chars = text.match(/[\u4e00-\u9fff]/g) || []
  const bigrams = []
  for (let i = 0; i < chars.length - 1; i++) {
    bigrams.push(`${chars[i]}${chars[i + 1]}`)
  }
  return [...latin, ...bigrams]
}

function jaccardSimilarity(a, b) {
  const setA = new Set(contentTokens(a))
  const setB = new Set(contentTokens(b))
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection += 1
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

function findDuplicateGroups(records, limit) {
  const parent = new Map()
  for (const record of records) parent.set(record.id, record.id)
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)))
      id = parent.get(id)
    }
    return id
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      if (
        jaccardSimilarity(records[i].content, records[j].content) >= MEMORY_DUPLICATE_SIMILARITY
      ) {
        union(records[i].id, records[j].id)
      }
    }
  }
  const byRoot = new Map()
  for (const record of records) {
    const root = find(record.id)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root).push(record)
  }
  return Array.from(byRoot.values())
    .filter((group) => group.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, limit)
}

function analyzeMemory(args = {}) {
  const project = args.project || projectName()
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20)
  const records = readJsonl(memoryPath).filter(
    (record) => !project || record.project === project || !record.project,
  )
  const archived = records.filter((record) => record.archived === true).length
  const activeRecords = records.filter((record) => record.archived !== true)
  const total = activeRecords.length
  const layerCounts = { project: 0, global: 0 }
  for (const record of activeRecords) {
    if (record.scope === 'global' || !record.project) layerCounts.global += 1
    else layerCounts.project += 1
  }

  const byKind = {}
  const lowQuality = []
  for (const record of activeRecords) {
    const kind = String(record.kind || '').trim() || 'unknown'
    byKind[kind] = (byKind[kind] || 0) + 1
    const content = String(record.content || '').trim()
    const issues = []
    if (!content) issues.push('missing content')
    else if (content.length < MEMORY_SHORT_CONTENT_MIN) issues.push('content too short')
    if (!record.kind || !String(record.kind).trim()) issues.push('missing kind')
    if (issues.length > 0) {
      lowQuality.push({
        id: record.id,
        timestamp: record.timestamp,
        kind: record.kind || null,
        content: content.slice(0, 200) || null,
        issues,
      })
    }
  }

  let duplicateGroups = []
  let duplicatesSkipped = false
  if (activeRecords.length > MAX_PAIRWISE_MEMORY) {
    duplicatesSkipped = true
  } else {
    duplicateGroups = findDuplicateGroups(activeRecords, limit).map((group) => ({
      size: group.length,
      records: group.map((record) => ({
        id: record.id,
        timestamp: record.timestamp,
        kind: record.kind || null,
        content: String(record.content || '').slice(0, 200),
      })),
    }))
  }

  const issues = {
    lowQuality: lowQuality.length,
    duplicateGroups: duplicateGroups.length,
    duplicatesSkipped,
  }

  const suggestions = []
  if (duplicateGroups.length > 0) {
    suggestions.push(
      `Found ${duplicateGroups.length} duplicate group(s); consider archiving or merging duplicates to keep recall precise.`,
    )
  }
  if (lowQuality.length > 0) {
    suggestions.push(
      `${lowQuality.length} low-quality record(s) (missing kind/content or too short); consider fixing or removing them.`,
    )
  }
  if (total === 0) {
    suggestions.push('No memory records for this project yet.')
  } else if (duplicateGroups.length === 0 && lowQuality.length === 0) {
    suggestions.push('Memory looks healthy; no dedup or quality fixes needed.')
  }

  return {
    project: project || null,
    total,
    archived,
    layers: layerCounts,
    byKind,
    issues,
    duplicates: duplicateGroups,
    lowQuality: lowQuality.slice(0, limit),
    suggestions,
  }
}

function migrateMemory(args = {}) {
  const idsInput = Array.isArray(args.ids) ? args.ids : []
  const ids = idsInput.map((value) => String(value).trim()).filter(Boolean)
  if (ids.length === 0) throw new Error('memory.migrate requires ids (array of memory record ids)')
  const targetScope = normalizeScope(args.scope)
  if (targetScope === 'all') throw new Error('memory.migrate scope must be project or global')
  const project = args.project || projectName()
  const reason = args.reason ? String(args.reason).trim().slice(0, 200) : null

  const records = readJsonl(memoryPath)
  const idSet = new Set(ids)
  const updated = []
  const unchanged = []
  const notFound = [...ids]
  for (const record of records) {
    if (!idSet.has(record.id)) continue
    const fromScope = record.scope || 'project'
    const fromProject = record.project || null
    if (fromScope === targetScope) {
      unchanged.push(record.id)
    } else {
      record.scope = targetScope
      record.project = targetScope === 'global' ? null : project
      record.migratedAt = new Date().toISOString()
      record.migratedFrom = fromScope === 'global' ? 'global' : fromProject || 'project'
      if (reason) record.migrateReason = reason
      updated.push(record.id)
    }
    const index = notFound.indexOf(record.id)
    if (index >= 0) notFound.splice(index, 1)
  }
  writeJsonl(memoryPath, records)

  return {
    project: project || null,
    scope: targetScope,
    updated,
    updatedCount: updated.length,
    unchanged,
    notFound,
  }
}
function archiveMemory(args = {}) {
  const idsInput = Array.isArray(args.ids) ? args.ids : []
  const ids = idsInput.map((value) => String(value).trim()).filter(Boolean)
  if (ids.length === 0) throw new Error('memory.archive requires ids (array of memory record ids)')
  const project = args.project || projectName()
  const restore = args.restore === true || args.restore === 'true'
  const reason = args.reason ? String(args.reason).trim().slice(0, 200) : null

  const records = readJsonl(memoryPath)
  const idSet = new Set(ids)
  const archived = []
  const notFound = [...ids]
  for (const record of records) {
    if (!idSet.has(record.id)) continue
    if (project && record.project && record.project !== project) continue
    if (restore) {
      if (record.archived === true) {
        delete record.archived
        delete record.archivedAt
        delete record.archiveReason
        archived.push(record.id)
      }
    } else if (record.archived !== true) {
      record.archived = true
      record.archivedAt = new Date().toISOString()
      if (reason) record.archiveReason = reason
      archived.push(record.id)
    }
    const index = notFound.indexOf(record.id)
    if (index >= 0) notFound.splice(index, 1)
  }
  writeJsonl(memoryPath, records)

  return {
    project: project || null,
    restored: restore,
    archived,
    archivedCount: archived.length,
    notFound,
  }
}

const FAILURE_OUTCOMES = new Set(['failure', 'error', 'aborted', 'retry'])
const MEMORY_DUPLICATE_SIMILARITY = 0.75
const MEMORY_SHORT_CONTENT_MIN = 20
const MAX_PAIRWISE_MEMORY = 1500

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

function policyCheck(args = {}) {
  const action = String(args.action || '').trim()
  if (!action) throw new Error('policy.check requires action')
  const project = args.project || projectName()
  const actionTokens = tokenize(action)
  const traces = readJsonl(tracePath).filter((event) => {
    if (project && event.project && event.project !== project) return false
    const haystack = tokenize(
      `${event.event_type || ''} ${JSON.stringify(event.payload || {})}`
    )
    return actionTokens.some((token) => haystack.includes(token))
  })
  const total = traces.length
  const failures = traces.filter((event) => isFailureOutcome(event.outcome)).length
  const risk = total > 0 ? failures / total : null
  const riskLevel = total === 0 ? 'unknown' : risk >= 0.4 ? 'high' : risk >= 0.2 ? 'moderate' : 'low'
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
  } else if (risk >= 0.4) {
    suggestion = 'Historically risky. Prefer an alternative approach or add rollback/verification.'
  } else if (risk >= 0.2) {
    suggestion = 'Moderate risk. Add verification before proceeding.'
  } else {
    suggestion = 'Low historical risk. Proceed with normal checks.'
  }
  const evidence = loadEvidenceWeights()
  const relatedMemories = readJsonl(memoryPath)
    .filter((record) => scoreRecord(record, action, project, evidence) > 0)
    .sort((a, b) => scoreRecord(b, action, project, evidence) - scoreRecord(a, action, project, evidence))
    .slice(0, 3)
    .map((record) => {
      const ev = evidence.get(record.id)
      return {
        id: record.id,
        timestamp: record.timestamp,
        kind: record.kind,
        content: record.content,
        tags: record.tags,
        evidence: ev
          ? { reuseCount: ev.reuseCount, confirmedCount: ev.confirmedCount }
          : null,
      }
    })
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
  }
}

function recordExperienceReuse(args = {}) {
  const sourceAgent = String(args.sourceAgent || '').trim()
  const targetAgent = String(args.targetAgent || '').trim()
  const experienceId = String(args.experienceId || '').trim()
  if (!sourceAgent) throw new Error('experience.reuse requires sourceAgent')
  if (!targetAgent) throw new Error('experience.reuse requires targetAgent')
  if (!experienceId) throw new Error('experience.reuse requires experienceId')

  const project = args.project || projectName()
  const evidence = {
    id: createId('xfer'),
    timestamp: new Date().toISOString(),
    sourceAgent,
    targetAgent,
    experienceId,
    reuse: args.reuse === true || args.reuse === 'true',
    behaviorChanged: args.behaviorChanged === true || args.behaviorChanged === 'true',
    outcomeImproved: args.outcomeImproved === true || args.outcomeImproved === 'true',
    project,
    source: args.source || 'agent_report',
    notes: args.notes || null,
  }
  appendJsonl(experienceReusePath, evidence)

  const report = loadPhase0(dataDir, project)
  return {
    recorded: true,
    evidence,
    phase0: summarizePhase0(report),
  }
}

function confirmExperienceReuse(args = {}) {
  const id = String(args.id || '').trim()
  if (!id) throw new Error('experience.confirm requires id of an auto-claimed reuse record')
  const records = readJsonl(experienceReusePath)
  const index = records.findIndex((record) => record && record.id === id)
  if (index < 0) {
    throw new Error(`No experience reuse record found with id ${id}`)
  }
  const record = records[index]
  if (record.source !== 'auto_claim') {
    throw new Error('experience.confirm only applies to source=auto_claim reuse records')
  }
  const outcomeImproved =
    args.outcomeImproved === undefined || args.outcomeImproved === null
      ? record.outcomeImproved === true
      : args.outcomeImproved === true || args.outcomeImproved === 'true'
  const updated = {
    ...record,
    behaviorChanged: true,
    outcomeImproved,
    confirmed: true,
    confirmedAt: new Date().toISOString(),
    confirmedBy: String(args.confirmedBy || 'agent').trim() || 'agent',
    notes: args.notes ? String(args.notes).trim() : record.notes || null,
  }
  records[index] = updated
  writeJsonl(experienceReusePath, records)

  const report = loadPhase0(dataDir, updated.project)
  return {
    confirmed: true,
    evidence: updated,
    phase0: summarizePhase0(report),
  }
}

function listExperienceReuse(args = {}) {
  const project = args.project || projectName()
  const status = String(args.status || 'all').trim().toLowerCase()
  const targetAgent = String(args.targetAgent || '').trim().toLowerCase()
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)

  let records = readJsonl(experienceReusePath)
  if (project) records = records.filter((record) => record.project === project)
  if (targetAgent) {
    records = records.filter(
      (record) => String(record.targetAgent || '').toLowerCase() === targetAgent,
    )
  }
  const matcher = REUSE_STATUS_FILTERS[status]
  if (matcher) records = records.filter(matcher)
  records.sort((a, b) => {
    const at = new Date(a.timestamp || 0).getTime()
    const bt = new Date(b.timestamp || 0).getTime()
    return bt - at
  })

  const visible = records.slice(0, limit).map((record) => ({
    id: record.id,
    source: record.source,
    sourceAgent: record.sourceAgent,
    targetAgent: record.targetAgent,
    experienceId: record.experienceId,
    reuse: record.reuse === true || record.reuse === 'true',
    behaviorChanged: record.behaviorChanged === true || record.behaviorChanged === 'true',
    outcomeImproved: record.outcomeImproved === true || record.outcomeImproved === 'true',
    confirmed: record.confirmed === true,
    confirmedBy: record.confirmedBy || null,
    traceId: record.traceId || null,
    timestamp: record.timestamp,
    project: record.project,
    notes:
      typeof record.notes === 'string' && record.notes ? record.notes.slice(0, 300) : null,
  }))

  return {
    project: project || null,
    status,
    count: visible.length,
    total: records.length,
    records: visible,
  }
}

function registerAgent(args = {}) {
  const agentId = String(args.agentId || '').trim()
  if (!agentId) throw new Error('agent.register requires a non-empty agentId')
  const project = args.project || projectName()
  const hostType = args.hostType || 'mcp'
  const capabilities = Array.isArray(args.capabilities) ? args.capabilities : []
  const now = new Date().toISOString()
  const agents = readJsonl(agentsPath)
  const existing = agents.find((a) => a.agentId === agentId && a.project === project)
  let result
  if (existing) {
    existing.lastSeenAt = now
    existing.sessionCount = (existing.sessionCount || 1) + 1
    existing.hostType = hostType
    if (capabilities.length > 0) existing.capabilities = capabilities
    result = existing
  } else {
    result = {
      id: createId('agent'),
      agentId,
      hostType,
      capabilities,
      registeredAt: now,
      lastSeenAt: now,
      sessionCount: 1,
      project,
    }
    agents.push(result)
  }
  writeJsonl(agentsPath, agents)
  return { id: result.id, agentId: result.agentId, registered: !existing, sessionCount: result.sessionCount, hostType: result.hostType, capabilities: result.capabilities }
}

function listAgents(args = {}) {
  const project = args.project || null
  let agents = readJsonl(agentsPath)
  if (project) agents = agents.filter((a) => a.project === project)
  return {
    count: agents.length,
    agents: agents.map((a) => ({
      id: a.id, agentId: a.agentId, hostType: a.hostType,
      capabilities: a.capabilities, registeredAt: a.registeredAt,
      lastSeenAt: a.lastSeenAt, sessionCount: a.sessionCount,
      taskCount: a.taskCount || 0, successCount: a.successCount || 0, failureCount: a.failureCount || 0,
      project: a.project,
    })),
  }
}

function reportAgent(args = {}) {
  const targetAgent = args.agentId || null
  const project = args.project || projectName()
  const agents = readJsonl(agentsPath)
  const filtered = agents.filter((a) =>
    (!targetAgent || a.agentId === targetAgent) && (!project || a.project === project)
  )
  const traces = readJsonl(tracePath)
  const memories = readJsonl(memoryPath)
  const reuses = readJsonl(experienceReusePath)
  const reports = filtered.map((agent) => {
    const agentTraces = traces.filter((t) => t.agent === agent.agentId)
    const outcomes = agentTraces.filter((t) => t.event_type === 'task_outcome')
    const successes = outcomes.filter((t) => t.outcome === 'success').length
    const failures = outcomes.filter((t) => t.outcome === 'failure').length
    const agentMemories = memories.filter((m) => m.source === agent.agentId)
    const agentReuses = reuses.filter((r) => r.sourceAgent === agent.agentId || r.targetAgent === agent.agentId)
    const verified = agentReuses.filter((r) => r.confirmed && r.reuse && r.behaviorChanged && r.outcomeImproved)
    const regTasks = agent.taskCount || 0
    const regSuccess = agent.successCount || 0
    const regFail = agent.failureCount || 0
    const taskTotal = regTasks > 0 ? regTasks : outcomes.length
    const taskSuccess = regTasks > 0 ? regSuccess : successes
    const taskFail = regTasks > 0 ? regFail : failures
    return {
      agentId: agent.agentId,
      hostType: agent.hostType,
      sessionCount: agent.sessionCount,
      registeredAt: agent.registeredAt,
      lastSeenAt: agent.lastSeenAt,
      taskOutcomes: { total: taskTotal, success: taskSuccess, failure: taskFail, successRate: taskTotal > 0 ? Math.round((taskSuccess / taskTotal) * 100) : 0 },
      memories: agentMemories.length,
      experienceReuses: { total: agentReuses.length, verified: verified.length },
      active: (Date.now() - new Date(agent.lastSeenAt).getTime()) < 24 * 60 * 60 * 1000,
    }
  })
  return { project, count: reports.length, reports }
}

const AGENT_HEALTH_FRESH_MS = 48 * 3600000

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

  // Feed the query log so a later task_outcome can auto-claim route-driven reuse.
  if (routes.length > 0 || relatedMemories.length > 0) {
    const now = Date.now()
    const entries = loadRecentQueries()
    entries.push({
      agent: runtimeAgentId() || 'mcp',
      project,
      query: task,
      resultIds: [...routedIds, ...relatedMemories.map((record) => record.id)].filter(Boolean),
      resultSources: [...routes.map(() => 'experience'), ...relatedMemories.map((record) => record.source || null)],
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

  ...(insightStore ? [{
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

  ...(ObserverStore ? [{
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

function insightStatus() {
  if (!insightStore) throw new Error('@akemi-mio/insight not installed')
  const all = insightStore.getAll()
  const unreported = insightStore.getUnreported()
  return {
    total: all.length,
    unreported: unreported.length,
    reported: all.length - unreported.length,
    highValue: insightStore.getHighValueUnreported(50, 0.7).length,
  }
}

function insightList(args = {}) {
  if (!insightStore) throw new Error('@akemi-mio/insight not installed')
  let insights = insightStore.getAll()
  if (args.unreported) insights = insightStore.getUnreported()
  if (args.minScore) insights = insights.filter(i => i.score >= args.minScore)
  if (args.detector) insights = insights.filter(i => i.detector === args.detector)
  if (args.limit) insights = insights.slice(-args.limit)
  return insights
}

function insightMarkReported(args = {}) {
  if (!insightStore) throw new Error('@akemi-mio/insight not installed')
  if (!args.ids || !Array.isArray(args.ids)) throw new Error('ids array required')
  for (const id of args.ids) insightStore.markReported(id)
  return { marked: args.ids.length }
}

async function insightGenerate(args = {}) {
  if (!InsightGenerator) throw new Error('@akemi-mio/insight not installed')
  const generator = new InsightGenerator({ chatJson })
  const ctx = {
    memoryEntries: (args.memories || []).map(m => ({
      type: m.kind || m.type || 'note',
      content: m.content || '',
      createdAt: m.createdAt || m.timestamp || Date.now(),
    })),
    summaries: args.summaries || [],
    interactionCount: 0,
    plans: (args.plans || []).map(p => ({
      title: p.title || p.name || '',
      status: p.status || 'unknown',
      updatedAt: p.updatedAt || Date.now(),
      steps: p.steps || [],
      createdAt: p.createdAt || Date.now(),
    })),
    eventCount: 0,
  }
  const insights = await generator.generate(ctx)
  if (insightStore) {
    for (const i of insights) insightStore.addMany([i])
  }
  return { generated: insights.length, insights }
}

// ═══ Observer Research Pipeline Handlers ═══

function getObserverStore(baseDir) {
  if (!ObserverStore) throw new Error('@akemi-mio/observer not installed')
  return new ObserverStore(baseDir || path.join(process.cwd(), '.local', 'observer'))
}

function getObserverBaseDir(args) {
  return args.baseDir || path.join(process.cwd(), '.local', 'observer')
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null }
}

function readJsonlSafe(filePath) {
  if (!fs.existsSync(filePath)) return []
  try {
    return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function observerWorldModel(args = {}) {
  const baseDir = getObserverBaseDir(args)
  const wmDir = path.join(baseDir, 'world_model')
  return {
    entities: readJsonSafe(path.join(wmDir, 'entities.json')) || [],
    events: readJsonSafe(path.join(wmDir, 'events.json')) || [],
    trends: readJsonSafe(path.join(wmDir, 'trends.json')) || [],
    narratives: readJsonSafe(path.join(wmDir, 'narratives.json')) || [],
  }
}

function observerTrends(args = {}) {
  const baseDir = getObserverBaseDir(args)
  const trendsDir = path.join(baseDir, 'trends')
  if (!fs.existsSync(trendsDir)) return []
  if (args.date) {
    const report = readJsonSafe(path.join(trendsDir, `${args.date}.json`))
    return report ? [report] : []
  }
  const files = fs.readdirSync(trendsDir).filter(f => f.endsWith('.json')).sort().reverse()
  return files.slice(0, args.limit || 7).map(f => readJsonSafe(path.join(trendsDir, f))).filter(Boolean)
}

function observerResearch(args = {}) {
  const baseDir = getObserverBaseDir(args)
  const researchDir = path.join(baseDir, 'research')
  if (!fs.existsSync(researchDir)) return []
  const files = fs.readdirSync(researchDir).filter(f => f.endsWith('.json')).sort().reverse()
  return files.slice(0, args.limit || 10).map(f => readJsonSafe(path.join(researchDir, f))).filter(Boolean)
}

function observerInsights(args = {}) {
  const baseDir = getObserverBaseDir(args)
  const insightsDir = path.join(baseDir, 'insights')
  if (!fs.existsSync(insightsDir)) return []
  const files = fs.readdirSync(insightsDir).filter(f => f.endsWith('.json')).sort().reverse()
  return files.slice(0, args.limit || 20).map(f => readJsonSafe(path.join(insightsDir, f))).filter(Boolean)
}

function observerStatus(args = {}) {
  const baseDir = getObserverBaseDir(args)
  const dirs = ['observations', 'trends', 'topics', 'research', 'insights', 'world_model', 'essays']
  const status = {}
  for (const d of dirs) {
    const dir = path.join(baseDir, d)
    if (fs.existsSync(dir)) {
      status[d] = fs.readdirSync(dir).filter(f => !f.startsWith('.')).length
    } else {
      status[d] = 0
    }
  }
  return status
}

function observerCollect(args = {}) {
  if (!ObserverService) throw new Error('@akemi-mio/observer not installed')
  const baseDir = getObserverBaseDir(args)
  const service = new ObserverService({ baseDir, collectorConfig: {} })
  const sources = args.sources || ['bilibili', 'hackernews', 'github', 'douyin', 'rss']
  const allObs = []
  for (const src of sources) {
    try {
      const collectFn = service.collectBySource ? service.collectBySource : service.collect
      if (collectFn) {
        const result = collectFn.call(service, [src], args.keywords || [], args.limit || 20)
        if (Array.isArray(result)) allObs.push(...result)
        else if (result && typeof result === 'object') {
          for (const [key, items] of Object.entries(result)) allObs.push(...items)
        }
      }
    } catch (e) {
      allObs.push({ source: src, error: e.message })
    }
  }
  return { collected: allObs.length, observations: allObs }
}

function observerFerment(args = {}) {
  if (!ObserverService) throw new Error('@akemi-mio/observer not installed')
  const baseDir = getObserverBaseDir(args)
  const service = new ObserverService({ baseDir, collectorConfig: {} })
  const session = args.session || 'afternoon'
  try {
    const fermentation = service.getFermentation()
    if (fermentation && fermentation.ferment) return fermentation.ferment(session)
    return { status: 'fermentation engine available but no ferment method' }
  } catch (e) {
    return { error: e.message }
  }
}

function observerEssays(args = {}) {
  const baseDir = getObserverBaseDir(args)
  const type = args.type || 'published'
  const essaysDir = path.join(baseDir, 'essays', type)
  if (!fs.existsSync(essaysDir)) return []
  const files = fs.readdirSync(essaysDir).filter(f => f.endsWith('.md')).sort().reverse()
  return files.slice(0, args.limit || 10).map(f => {
    const content = fs.readFileSync(path.join(essaysDir, f), 'utf8')
    return { file: f, type, content, created: fs.statSync(path.join(essaysDir, f)).birthtime.toISOString() }
  })
}

function observerDag(args = {}) {
  const baseDir = getObserverBaseDir(args)
  const days = args.days || 7
  const summaries = []
  const todayDate = new Date()
  for (let i = 0; i < days; i++) {
    const d = new Date(todayDate)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)
    const filePath = path.join(baseDir, 'summaries', `${dateStr}.jsonl`)
    const items = readJsonlSafe(filePath)
    if (items.length) summaries.push({ date: dateStr, summaries: items })
  }
  return { summaries, summaryCount: summaries.reduce((a, s) => a + s.summaries.length, 0) }
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'mio.memory.query':
      return queryMemory(args)
    case 'mio.memory.record':
      return recordMemory(args)
    case 'mio.memory.archive':
      return archiveMemory(args)
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


function recordTaskOutcome(args = {}) {
  const outcome = String(args.outcome || '').trim().toLowerCase()
  if (!['success', 'failure', 'aborted'].includes(outcome)) {
    throw new Error('task.record_outcome requires outcome to be success, failure, or aborted')
  }
  const agentId = String(args.agentId || runtimeAgentId() || 'unknown').trim()
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
  const agents = readJsonl(agentsPath)
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

module.exports = { TOOLS, callTool, handleMessage, readJsonl, appendJsonl, rl }
