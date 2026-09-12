'use strict'

// Shared memory store: the single implementation of memory.query / memory.record
// ranking and persistence, consumed by both the MCP server (index.js) and the
// CLI (`mio recall` / `mio remember`). Scoring must stay byte-compatible with
// the original inlined logic so MCP behavior does not change.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
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

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean)
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
  }
  return []
}

function tokenize(text) {
  const normalized = String(text || '').toLowerCase()
  const latin = normalized.match(/[a-z0-9]+/g) || []
  const cjk = (normalized.match(/[\u4e00-\u9fff]/g) || []).map((char) => `cjk:${char}`)
  return [...latin, ...cjk]
}

function normalizeScope(value) {
  const s = String(value || 'project').trim().toLowerCase()
  if (s === 'global' || s === 'all') return s
  return 'project'
}

function isGlobalRecord(record) {
  return String(record.scope || '').trim().toLowerCase() === 'global'
}

function matchesProjectScope(record, project, scope) {
  const s = normalizeScope(scope)
  if (s === 'global') return isGlobalRecord(record)
  if (s === 'all') {
    if (isGlobalRecord(record)) return true
    return !project || record.project === project
  }
  // project (default): project-scoped records matching the project only
  if (isGlobalRecord(record)) return false
  return !project || record.project === project
}

function latinTokens(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []
}

function cjkBigrams(text) {
  const chars = String(text || '').toLowerCase().match(/[\u4e00-\u9fff]/g) || []
  const bigrams = new Set()
  for (let i = 0; i + 1 < chars.length; i += 1) {
    bigrams.add(`${chars[i]}${chars[i + 1]}`)
  }
  return bigrams
}

function scoreRecord(record, queryText, project, evidence) {
  if (project && record.project && record.project !== project) return 0
  const content = `${record.content || ''} ${(record.tags || []).join(' ')} ${record.kind || ''}`
  const haystackTokens = tokenize(content)
  const haystackLatin = latinTokens(content)
  const queryTokens = tokenize(queryText)
  let score = 0
  for (const token of queryTokens) {
    if (haystackTokens.includes(token)) score += 2
  }
  const queryLatin = queryTokens.filter((token) => !token.startsWith('cjk:'))
  for (const token of queryLatin) {
    if (
      token.length >= 3 &&
      haystackLatin.some((item) => item.startsWith(token) || token.startsWith(item))
    ) {
      score += 1
    }
  }
  const queryBigrams = cjkBigrams(queryText)
  const haystackBigrams = cjkBigrams(content)
  if (queryBigrams.size > 0 && haystackBigrams.size > 0) {
    let matched = 0
    for (const bigram of queryBigrams) {
      if (haystackBigrams.has(bigram)) matched += 1
    }
    score += matched * 1.5
  }
  // Recency only boosts ranking among actual matches; it must not enable recall.
  if (score > 0 && record.timestamp) {
    const ageDays = Math.max(0, (Date.now() - Date.parse(record.timestamp)) / 86400000)
    score += Math.max(0, 0.5 - ageDays * 0.05)
  }
  // Evidence weighting (P2): memories successfully reused rank higher; never enables recall.
  if (score > 0 && evidence && evidence.has(record.id)) {
    const ev = evidence.get(record.id)
    score += Math.min(2, ev.reuseCount * 0.6 + (ev.confirmedCount > 0 ? 1 : 0))
  }
  return score
}

function matchesMemoryFilters(record, kind, tags) {
  if (kind) {
    const recordKind = String(record.kind || '').trim().toLowerCase()
    if (recordKind !== kind) return false
  }
  if (tags.length > 0) {
    const recordTags = new Set(
      (record.tags || []).map((tag) => String(tag).trim().toLowerCase()),
    )
    for (const tag of tags) {
      if (!recordTags.has(tag)) return false
    }
  }
  return true
}

function defaultVerifiedFilter(record) {
  return (
    (record.reuse === true || record.reuse === 'true') &&
    (record.behaviorChanged === true || record.behaviorChanged === 'true') &&
    (record.outcomeImproved === true || record.outcomeImproved === 'true')
  )
}

function createMemoryStore(options = {}) {
  const dataDir = options.dataDir
  const projectName = options.projectName || (() => null)
  const agentId = options.agentId || (() => null)
  // Hook that persists a recent-query entry (phase 0 auto-claim input).
  // Optional: the CLI passes null because no task_outcome can follow a
  // terminal command, so recording a query there would only add noise.
  const recordQuery = options.recordQuery || null
  const verifiedFilter = options.verifiedFilter || defaultVerifiedFilter

  const memoryPath = path.join(dataDir, 'memory.jsonl')
  const experienceReusePath = path.join(dataDir, 'experience_reuse.jsonl')
  const tracePath = path.join(dataDir, 'traces.jsonl')

  function loadEvidenceWeights() {
    const weights = new Map()
    for (const record of readJsonl(experienceReusePath)) {
      if (!verifiedFilter(record)) continue
      const id = record.experienceId
      if (!id) continue
      let entry = weights.get(id)
      if (!entry) {
        entry = { reuseCount: 0, confirmedCount: 0, lastReusedAt: null }
        weights.set(id, entry)
      }
      entry.reuseCount += 1
      if (record.confirmed === true) entry.confirmedCount += 1
      if (!entry.lastReusedAt || new Date(record.timestamp || 0) > new Date(entry.lastReusedAt)) {
        entry.lastReusedAt = record.timestamp || null
      }
    }
    return weights
  }

  function queryMemory(args = {}) {
    const query = String(args.query || '')
    const project = args.project || projectName()
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20)
    const kind = args.kind ? String(args.kind).trim().toLowerCase() : null
    const tags = Array.isArray(args.tags)
      ? args.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
      : []
    const scope = normalizeScope(args.scope)
    const evidence = loadEvidenceWeights()
    const scoreFor = (record) =>
      scoreRecord(record, query, project, evidence) +
      (scope === 'all' && isGlobalRecord(record) ? 0.5 : 0)
    const results = readJsonl(memoryPath)
      .filter((record) => record.archived !== true)
      .filter((record) => matchesMemoryFilters(record, kind, tags))
      .filter((record) => matchesProjectScope(record, project, scope))
      .filter((record) => scoreFor(record) > 0)
      .sort((a, b) => {
        return scoreFor(b) - scoreFor(a)
      })
      .slice(0, limit)
      .map((record) => {
        const ev = evidence.get(record.id)
        if (!ev) return record
        return {
          ...record,
          evidence: {
            reuseCount: ev.reuseCount,
            confirmedCount: ev.confirmedCount,
            lastReusedAt: ev.lastReusedAt,
          },
        }
      })
    const layerCounts = { project: 0, global: 0 }
    for (const record of results) {
      if (record.scope === 'global' || !record.project) layerCounts.global += 1
      else layerCounts.project += 1
    }
    if (results.length > 0 && recordQuery) {
      const timestamp = Date.now()
      recordQuery({
        agent: agentId() || 'mcp',
        project,
        query,
        resultIds: results.map((record) => record.id).filter(Boolean),
        resultSources: results.map((record) => record.source || null),
        timestamp,
        expiresAt: timestamp + (options.reuseMatchWindowMs || 60 * 60 * 1000),
      })
    }
    return {
      query,
      project,
      scope,
      layers: layerCounts,
      kind: kind || null,
      tags: tags,
      count: results.length,
      results,
    }
  }

  function parseTimeArg(value) {
    if (value === undefined || value === null || value === '') return null
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const asNumber = Number(value)
    if (String(value).trim() !== '' && Number.isFinite(asNumber)) return asNumber
    const parsed = Date.parse(String(value))
    return Number.isFinite(parsed) ? parsed : null
  }

  // Query the observer trace log (traces.jsonl): task outcomes, tool errors,
  // and any event ingested via observer.ingest. Newest first. The summary
  // counts cover the whole filtered set, not just the returned page.
  function queryTraces(args = {}) {
    // project default: current project; explicit null/'' disables the filter
    const project =
      args.project === undefined || args.project === null ? projectName() || null : String(args.project) || null
    const eventType = args.event_type ? String(args.event_type).trim().toLowerCase() : null
    const outcome = args.outcome ? String(args.outcome).trim().toLowerCase() : null
    const agent = args.agent ? String(args.agent).trim() : null
    const host = args.host ? String(args.host).trim() : null
    const since = parseTimeArg(args.since)
    const until = parseTimeArg(args.until)
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200)
    const includePayload = args.include_payload !== false

    const all = readJsonl(tracePath)
    const matched = all.filter((trace) => {
      if (!trace || typeof trace !== 'object') return false
      if (project && trace.project !== project) return false
      if (eventType && String(trace.event_type || '').toLowerCase() !== eventType) return false
      if (outcome && String(trace.outcome || '').toLowerCase() !== outcome) return false
      if (agent && String(trace.agent || '') !== agent) return false
      if (host && String(trace.host || '') !== host) return false
      const ts = Date.parse(trace.timestamp || '')
      if (since !== null && !(Number.isFinite(ts) && ts >= since)) return false
      if (until !== null && !(Number.isFinite(ts) && ts <= until)) return false
      return true
    })

    const byEventType = {}
    const byOutcome = {}
    for (const trace of matched) {
      const et = String(trace.event_type || 'unknown')
      byEventType[et] = (byEventType[et] || 0) + 1
      const oc = String(trace.outcome || 'none')
      byOutcome[oc] = (byOutcome[oc] || 0) + 1
    }

    const results = []
    for (let i = matched.length - 1; i >= 0 && results.length < limit; i -= 1) {
      const trace = matched[i]
      results.push(
        includePayload
          ? trace
          : {
              ...trace,
              payload: {
                trace_id: trace.trace_id || null,
                project: trace.project || null,
              },
            }
      )
    }

    return {
      project,
      filters: {
        event_type: eventType,
        outcome: outcome,
        agent: agent,
        host: host,
        since: since !== null ? new Date(since).toISOString() : null,
        until: until !== null ? new Date(until).toISOString() : null,
      },
      total: all.length,
      matched: matched.length,
      summary: { byEventType, byOutcome },
      count: results.length,
      results,
    }
  }

  function recordMemory(args = {}) {
    const content = String(args.content || '').trim()
    if (!content) throw new Error('memory.record requires a non-empty content')
    const scope = normalizeScope(args.scope)
    const record = {
      id: createId('mem'),
      timestamp: new Date().toISOString(),
      kind: args.kind || 'note',
      content,
      tags: normalizeTags(args.tags),
      project: scope === 'global' ? null : args.project || projectName(),
      scope,
      source: args.source || agentId() || 'mcp',
    }
    appendJsonl(memoryPath, record)
    return record
  }

  return {
    memoryPath,
    experienceReusePath,
    tracePath,
    queryMemory,
    recordMemory,
    queryTraces,
    loadEvidenceWeights,
    // pure helpers, exported for tests and other consumers
    createId,
    readJsonl,
    appendJsonl,
    normalizeTags,
    tokenize,
    normalizeScope,
    isGlobalRecord,
    matchesProjectScope,
    latinTokens,
    cjkBigrams,
    scoreRecord,
    matchesMemoryFilters,
  }
}

module.exports = { createMemoryStore }
