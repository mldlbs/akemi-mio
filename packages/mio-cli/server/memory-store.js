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

function writeJsonl(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    values.length > 0 ? values.map((value) => JSON.stringify(value)).join('\n') + '\n' : '',
    'utf8'
  )
}

// --- Duplicate / quality analysis (mio.memory.analyze) ---------------------
// Threshold is intentionally conservative: two records are "duplicates" only
// when their token sets are nearly identical, because a false positive here
// suggests archiving a record the user still needs.
const MEMORY_DUPLICATE_SIMILARITY = 0.75
const MEMORY_SHORT_CONTENT_MIN = 20
// Pairwise Jaccard is O(n^2); beyond this many active records we skip the
// duplicate scan and report `duplicatesSkipped` instead of hanging.
const MAX_PAIRWISE_MEMORY = 1500

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

// Union-find over pairs above the similarity threshold, so "A~B, B~C" collapses
// into one group of three rather than three overlapping pairs.
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
      if (jaccardSimilarity(records[i].content, records[j].content) >= MEMORY_DUPLICATE_SIMILARITY) {
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
  //
  // Prefer passing `queryLog` (a createQueryLog instance) so memory and task
  // stores share one implementation of queries.jsonl; `recordQuery` remains
  // supported as a plain callback for callers that do not have a queryLog.
  const queryLog = options.queryLog || null
  const recordQuery =
    options.recordQuery || (queryLog ? (entry) => queryLog.record(entry) : null)
  const reuseMatchWindowMs =
    options.reuseMatchWindowMs || (queryLog ? queryLog.windowMs : 60 * 60 * 1000)
  const verifiedFilter = options.verifiedFilter || defaultVerifiedFilter

  const memoryPath = path.join(dataDir, 'memory.jsonl')
  const experienceReusePath = path.join(dataDir, 'experience_reuse.jsonl')
  const tracePath = path.join(dataDir, 'traces.jsonl')
  const forgetAuditPath = path.join(dataDir, 'memory-forget-audit.jsonl')

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
    // Score every candidate exactly once, then sort the scored pairs. Calling
    // scoreFor() inside the comparator re-ran the whole tokenizer + CJK bigram
    // scan O(n log n) times instead of O(n): measured on the real 1094-record
    // store, one query invoked the scorer 6214 times (5.7x) and spent 84 ms of
    // its 111 ms there. Sorting precomputed pairs is behaviour-identical --
    // Array#sort is stable, so ties keep their original file order either way.
    const scored = []
    for (const record of readJsonl(memoryPath)) {
      if (record.archived === true) continue
      if (!matchesMemoryFilters(record, kind, tags)) continue
      if (!matchesProjectScope(record, project, scope)) continue
      const score = scoreFor(record)
      if (score > 0) scored.push({ record, score })
    }
    const results = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ record }) => {
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
        expiresAt: timestamp + reuseMatchWindowMs,
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

  // Quality report over the active (non-archived) records for a project:
  // kind histogram, low-quality records, and near-duplicate groups. This is the
  // diagnostic half of memory hygiene — `archiveMemory` is the fix.
  function analyzeMemory(args = {}) {
    const project = args.project || projectName()
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20)
    const records = readJsonl(memoryPath).filter(
      (record) => !project || record.project === project || !record.project
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
        `Found ${duplicateGroups.length} duplicate group(s); consider archiving or merging duplicates to keep recall precise.`
      )
    }
    if (lowQuality.length > 0) {
      suggestions.push(
        `${lowQuality.length} low-quality record(s) (missing kind/content or too short); consider fixing or removing them.`
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

  // Merge near-duplicate records into one survivor.
  //
  // Safety stance (measured, not assumed): of 22 duplicate groups in a real
  // 860-record store, 19 held byte-identical content and 3 held *divergent*
  // content. Concatenating divergent bodies is actively harmful -- a real
  // example produced a record carrying both `Token 来源` and `凭证来源` for the
  // same field plus a duplicated header. So by default this only merges groups
  // whose members are byte-identical, and reports the rest as `divergent`
  // for the caller to inspect. Nothing is ever silently concatenated.
  //
  // Merging is archive-based, so it is reversible with archiveMemory({restore}).
  function mergeMemory(args = {}) {
    const idsInput = Array.isArray(args.ids) ? args.ids : []
    const ids = idsInput.map((value) => String(value).trim()).filter(Boolean)
    if (ids.length < 2) throw new Error('memory.merge requires at least 2 ids')
    const project = args.project || projectName()
    const reason = args.reason ? String(args.reason).trim().slice(0, 200) : null
    // keep: explicit survivor id. When absent, the newest record wins.
    const keep = args.keep ? String(args.keep).trim() : null
    // allowDivergent: opt-in escape hatch. Still refuses if no keep is named,
    // because "which divergence wins" is then undefined.
    const allowDivergent = args.allowDivergent === true || args.allowDivergent === 'true'

    const records = readJsonl(memoryPath)
    const idSet = new Set(ids)
    // The project filter must be applied once, up front. Applying it only in the
    // archive loop let a mismatched project still rewrite the survivor's
    // `supersedes` list, recording an absorption of records that were never
    // archived -- audit metadata pointing at nothing.
    const allMembers = records.filter((record) => idSet.has(record.id))
    const members = project
      ? allMembers.filter((record) => !record.project || record.project === project)
      : allMembers
    const notFound = ids.filter((id) => !allMembers.some((record) => record.id === id))
    const outOfScope = allMembers
      .filter((record) => !members.some((member) => member.id === record.id))
      .map((record) => record.id)

    if (members.length < 2) {
      return {
        project: project || null,
        merged: false,
        reason:
          outOfScope.length > 0
            ? 'fewer than 2 ids are in this project; records belong to another project'
            : 'fewer than 2 ids resolved to records',
        survivor: null,
        archived: [],
        archivedCount: 0,
        skipped: [],
        divergent: [],
        outOfScope,
        notFound,
      }
    }

    const contents = new Set(members.map((record) => String(record.content || '')))
    const divergentFrom = contents.size > 1

    if (divergentFrom && !allowDivergent) {
      return {
        project: project || null,
        merged: false,
        reason: 'content differs across records; refusing to concatenate',
        survivor: null,
        archived: [],
        archivedCount: 0,
        skipped: [],
        divergent: members.map((record) => ({
          id: record.id,
          timestamp: record.timestamp || null,
          contentLength: String(record.content || '').length,
          content: String(record.content || '').slice(0, 200),
        })),
        outOfScope,
        notFound,
        hint: 'Re-run with --keep <id> --allow-divergent to choose the surviving body explicitly.',
      }
    }

    if (divergentFrom && allowDivergent && !keep) {
      throw new Error('memory.merge with divergent content requires keep (the id whose body survives)')
    }

    // Survivor selection: explicit keep, else newest by timestamp.
    let survivor = null
    if (keep) {
      survivor = members.find((record) => record.id === keep)
      if (!survivor) throw new Error(`memory.merge keep id not in the merge set: ${keep}`)
    } else {
      survivor = members.reduce((best, record) => {
        const a = Date.parse(record.timestamp || 0) || 0
        const b = Date.parse(best.timestamp || 0) || 0
        return a > b ? record : best
      })
    }

    const superseded = members
      .filter((record) => record.id !== survivor.id)
      .map((record) => record.id)
    const mergedAt = new Date().toISOString()

    // Union tags so a merge never loses retrieval keywords.
    const tagSet = new Set(normalizeTags(survivor.tags))
    for (const record of members) {
      for (const tag of normalizeTags(record.tags)) tagSet.add(tag)
    }
    survivor.tags = Array.from(tagSet)

    // Audit trail: which records this one absorbed, and when.
    const priorSuperseded = Array.isArray(survivor.supersedes) ? survivor.supersedes : []
    survivor.supersedes = Array.from(new Set([...priorSuperseded, ...superseded]))
    survivor.mergedAt = mergedAt
    survivor.mergedCount = survivor.supersedes.length
    if (divergentFrom) survivor.mergeDivergent = true
    if (reason) survivor.mergeReason = reason

    const archived = []
    const skipped = []
    const memberIds = new Set(members.map((member) => member.id))
    for (const record of records) {
      if (record.id === survivor.id) continue
      // members already passed the project filter, so no re-check is needed here.
      if (!memberIds.has(record.id)) continue
      if (record.archived === true) {
        skipped.push(record.id)
        continue
      }
      record.archived = true
      record.archivedAt = mergedAt
      record.archiveReason = `merged-into:${survivor.id}`
      record.mergedInto = survivor.id
      archived.push(record.id)
    }
    writeJsonl(memoryPath, records)

    return {
      project: project || null,
      merged: true,
      divergentContent: divergentFrom,
      survivor: {
        id: survivor.id,
        timestamp: survivor.timestamp || null,
        contentLength: String(survivor.content || '').length,
        supersedes: survivor.supersedes,
        tags: survivor.tags,
      },
      archived,
      archivedCount: archived.length,
      skipped,
      divergent: [],
      outOfScope,
      notFound,
    }
  }

  // Soft delete: archived records stay on disk but drop out of memory.query and
  // memory.analyze. Reversible via `restore: true`.
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
    // Ids that exist but are already in the requested state. Reported separately
    // from `notFound` so callers can tell "already done" from "bad id".
    const skipped = []
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
        } else {
          skipped.push(record.id)
        }
      } else if (record.archived !== true) {
        record.archived = true
        record.archivedAt = new Date().toISOString()
        if (reason) record.archiveReason = reason
        archived.push(record.id)
      } else {
        skipped.push(record.id)
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
      skipped,
      notFound,
    }
  }

  // forget is the only hard delete in the memory surface: archive is reversible
  // (archived: true), merge is archive-based, and prune --memory is age-based.
  // Because the record is gone afterwards, an audit entry is written FIRST and
  // the delete only proceeds once that succeeded -- otherwise a "forgotten"
  // record would leave no trace of what it said.
  //
  // The audit keeps an excerpt rather than the full body: enough to answer
  // "what was removed" later, without quietly retaining everything the user
  // asked to delete.
  function forgetMemory(args = {}) {
    const idsInput = Array.isArray(args.ids) ? args.ids : []
    const ids = idsInput.map((value) => String(value).trim()).filter(Boolean)
    if (ids.length === 0) throw new Error('memory.forget requires ids (array of memory record ids)')
    const project = args.project || projectName()
    const reason = args.reason ? String(args.reason).trim().slice(0, 200) : null
    const by = args.by ? String(args.by).trim().slice(0, 80) : null

    const records = readJsonl(memoryPath)
    const idSet = new Set(ids)
    const forgotten = []
    const notFound = [...ids]
    const kept = []
    for (const record of records) {
      if (!idSet.has(record.id)) {
        kept.push(record)
        continue
      }
      // Out-of-project ids stay on file and are reported as notFound, matching
      // how archiveMemory scopes by project.
      if (project && record.project && record.project !== project) {
        kept.push(record)
        continue
      }
      const index = notFound.indexOf(record.id)
      if (index >= 0) notFound.splice(index, 1)
      const content = String(record.content || '')
      appendJsonl(forgetAuditPath, {
        id: createId('forget'),
        forgottenId: record.id,
        project: record.project || null,
        timestamp: new Date().toISOString(),
        reason,
        by,
        kind: record.kind || null,
        contentLength: content.length,
        excerpt: content.replace(/\s+/g, ' ').slice(0, 120),
      })
      forgotten.push(record.id)
    }

    if (forgotten.length > 0) writeJsonl(memoryPath, kept)

    return {
      project: project || null,
      forgotten,
      forgottenCount: forgotten.length,
      notFound,
      auditPath: forgetAuditPath,
    }
  }

  return {
    memoryPath,
    experienceReusePath,
    tracePath,
    forgetAuditPath,
    queryMemory,
    recordMemory,
    queryTraces,
    analyzeMemory,
    archiveMemory,
    forgetMemory,
    mergeMemory,
    migrateMemory,
    loadEvidenceWeights,
    // pure helpers, exported for tests and other consumers
    createId,
    readJsonl,
    appendJsonl,
    writeJsonl,
    contentTokens,
    jaccardSimilarity,
    findDuplicateGroups,
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

// Module-level exports let sibling stores (e.g. experience-store.js) reuse the
// same JSONL primitives instead of duplicating them and drifting apart.
module.exports = { createMemoryStore, createId, readJsonl, appendJsonl, writeJsonl }
