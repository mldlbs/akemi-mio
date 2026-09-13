'use strict'

// Shared experience-reuse store: the single implementation behind
// mio.experience.list / confirm / reuse, consumed by both the MCP server and
// the CLI (`mio experience`). Kept separate from memory-store.js because it
// owns a different file (experience_reuse.jsonl) and a different concern —
// whether a past experience actually helped when reused, not recall ranking.
//
// The status vocabulary here is load-bearing: `verified` is the only status
// that feeds memory ranking and task routing, and an unconfirmed `auto_claim`
// never qualifies. That is why the CLI exposes pending claims explicitly —
// unconfirmed auto-claims are otherwise invisible dead weight.

const path = require('path')
const { createId, readJsonl, appendJsonl, writeJsonl } = require('./memory-store.js')

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

const REUSE_STATUSES = Object.freeze(Object.keys(REUSE_STATUS_FILTERS))

function toBool(value) {
  return value === true || value === 'true'
}

function visibleRecord(record) {
  return {
    id: record.id,
    source: record.source,
    sourceAgent: record.sourceAgent,
    targetAgent: record.targetAgent,
    experienceId: record.experienceId,
    reuse: toBool(record.reuse),
    behaviorChanged: toBool(record.behaviorChanged),
    outcomeImproved: toBool(record.outcomeImproved),
    confirmed: record.confirmed === true,
    confirmedBy: record.confirmedBy || null,
    traceId: record.traceId || null,
    timestamp: record.timestamp,
    project: record.project,
    notes: typeof record.notes === 'string' && record.notes ? record.notes.slice(0, 300) : null,
  }
}

function createExperienceStore(options = {}) {
  const dataDir = options.dataDir
  const projectName = options.projectName || (() => null)
  // Optional hook returning a phase-0 summary for the affected project. The MCP
  // server wires it so its response shape stays unchanged; the CLI may omit it.
  const phase0Summary = options.phase0Summary || null
  const experiencePath = path.join(dataDir, 'experience_reuse.jsonl')

  function listReuse(args = {}) {
    const project = args.project || projectName()
    const status = String(args.status || 'all').trim().toLowerCase()
    const targetAgent = String(args.targetAgent || '').trim().toLowerCase()
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)

    let records = readJsonl(experiencePath)
    if (project) records = records.filter((record) => record.project === project)
    if (targetAgent) {
      records = records.filter(
        (record) => String(record.targetAgent || '').toLowerCase() === targetAgent
      )
    }
    const matcher = REUSE_STATUS_FILTERS[status]
    if (matcher) records = records.filter(matcher)
    records.sort((a, b) => {
      const at = new Date(a.timestamp || 0).getTime()
      const bt = new Date(b.timestamp || 0).getTime()
      return bt - at
    })

    const visible = records.slice(0, limit).map(visibleRecord)

    return {
      project: project || null,
      status,
      count: visible.length,
      total: records.length,
      records: visible,
    }
  }

  // Confirms one record (legacy `id`) or many (`ids`).
  //
  // Single-id calls keep strict semantics: an unknown id or a non-auto_claim
  // record throws, so a caller that named one record always learns when it was
  // wrong. Bulk calls are best-effort — with dozens of pending auto-claims a
  // single bad id must not abort the whole batch — and report `notFound` /
  // `rejected` instead.
  function confirmReuse(args = {}) {
    const bulk = Array.isArray(args.ids)
    const ids = (
      bulk ? args.ids : args.id ? [args.id] : []
    )
      .map((value) => String(value).trim())
      .filter(Boolean)

    if (ids.length === 0) {
      throw new Error('experience.confirm requires id of an auto-claimed reuse record')
    }

    const outcomeImprovedArg =
      args.outcomeImproved === undefined || args.outcomeImproved === null
        ? null
        : toBool(args.outcomeImproved)
    const confirmedBy = String(args.confirmedBy || 'agent').trim() || 'agent'
    const notes = args.notes ? String(args.notes).trim() : null

    const records = readJsonl(experiencePath)
    const confirmedIds = []
    const confirmedRecords = []
    const notFound = []
    const rejected = []
    const alreadyConfirmed = []
    const confirmedAt = new Date().toISOString()

    for (const id of ids) {
      const index = records.findIndex((record) => record && record.id === id)
      if (index < 0) {
        if (!bulk) throw new Error(`No experience reuse record found with id ${id}`)
        notFound.push(id)
        continue
      }
      const record = records[index]
      if (record.source !== 'auto_claim') {
        if (!bulk) throw new Error('experience.confirm only applies to source=auto_claim reuse records')
        rejected.push(id)
        continue
      }
      if (record.confirmed === true && !args.force) {
        alreadyConfirmed.push(id)
        continue
      }
      const updated = {
        ...record,
        behaviorChanged: true,
        outcomeImproved: outcomeImprovedArg === null ? record.outcomeImproved === true : outcomeImprovedArg,
        confirmed: true,
        confirmedAt,
        confirmedBy,
        notes: notes || record.notes || null,
      }
      records[index] = updated
      confirmedIds.push(id)
      confirmedRecords.push(updated)
    }

    if (confirmedRecords.length > 0) writeJsonl(experiencePath, records)

    const result = {
      confirmed: confirmedRecords.length > 0,
      // `evidence` stays a single record for back-compat with single-id callers
      // (including the MCP tests); bulk callers should use confirmedIds.
      evidence: confirmedRecords.length === 1 ? confirmedRecords[0] : confirmedRecords[0] || null,
      confirmedCount: confirmedRecords.length,
      confirmedIds,
      notFound,
      rejected,
      alreadyConfirmed,
    }
    if (phase0Summary && confirmedRecords.length > 0) {
      result.phase0 = phase0Summary(confirmedRecords[0].project)
    }
    return result
  }

  function recordReuse(args = {}) {
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
      reuse: toBool(args.reuse),
      behaviorChanged: toBool(args.behaviorChanged),
      outcomeImproved: toBool(args.outcomeImproved),
      project,
      source: args.source || 'agent_report',
      notes: args.notes || null,
    }
    appendJsonl(experiencePath, evidence)

    const result = { recorded: true, evidence }
    if (phase0Summary) result.phase0 = phase0Summary(project)
    return result
  }

  return { experiencePath, listReuse, confirmReuse, recordReuse }
}

module.exports = {
  createExperienceStore,
  REUSE_STATUS_FILTERS,
  REUSE_STATUSES,
  visibleRecord,
}
