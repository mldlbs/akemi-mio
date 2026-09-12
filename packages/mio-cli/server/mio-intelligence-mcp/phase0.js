'use strict'

const fs = require('fs')
const path = require('path')

const PHASE0_THRESHOLDS = Object.freeze({
  minHosts: 2,
  minTaskOutcomes: 20,
  minVerifiedReuse: 5,
  minImprovementEvidence: 1,
})

const GENERIC_AGENT_IDS = new Set(['mcp'])
const TASK_OUTCOME_EVENT = 'task_outcome'
const HOST_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function asRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value
}

function readString(record, key) {
  const value = record[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number') return String(value)
  return null
}

function readBoolean(record, key) {
  const value = record[key]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function readTimestamp(record) {
  const raw = record && record.timestamp
  if (typeof raw === 'string' || typeof raw === 'number') {
    const time = new Date(raw).getTime()
    if (Number.isFinite(time)) return time
  }
  return null
}

function normalizeIdentity(value) {
  const identity = typeof value === 'string' ? value.trim().toLowerCase() : null
  if (!identity || GENERIC_AGENT_IDS.has(identity)) return null
  return identity
}

function normalizeEventType(value) {
  if (typeof value !== 'string') return null
  const eventType = value.trim().toLowerCase()
  return eventType || null
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
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

function filterByProject(records, project) {
  if (!project) return records
  return records.filter((record) => readString(record, 'project') === project)
}

function createOutcomeSummary() {
  return { success: 0, failure: 0, error: 0, aborted: 0, retry: 0, other: 0 }
}

function bumpOutcome(summary, outcome) {
  switch (outcome) {
    case 'success':
      summary.success += 1
      break
    case 'failure':
      summary.failure += 1
      break
    case 'error':
      summary.error += 1
      break
    case 'aborted':
      summary.aborted += 1
      break
    case 'retry':
      summary.retry += 1
      break
    default:
      summary.other += 1
  }
}

function isVerifiedReuse(record) {
  return (
    readBoolean(record, 'reuse') === true &&
    readBoolean(record, 'behaviorChanged') === true &&
    readBoolean(record, 'outcomeImproved') === true
  )
}

function analyzePhase0(dataset) {
  const memories = dataset.memories || []
  const traces = dataset.traces || []
  const reuseRecords = dataset.reuseRecords || []

  const hosts = new Set()
  const addHost = (value) => {
    const identity = normalizeIdentity(value)
    if (identity) hosts.add(identity)
  }

  for (const record of memories) addHost(record.source)
  for (const record of traces) {
    addHost(record.agent)
    addHost(record.host)
  }
  for (const record of reuseRecords) {
    addHost(record.sourceAgent)
    addHost(record.targetAgent)
  }

  const hostList = Array.from(hosts).sort()
  const outcomeByStatus = createOutcomeSummary()
  let taskOutcomes = 0

  for (const record of traces) {
    const outcome = readString(record, 'outcome')
    bumpOutcome(outcomeByStatus, outcome ? outcome.toLowerCase() : null)
    if (normalizeEventType(record.event_type) === TASK_OUTCOME_EVENT) {
      taskOutcomes += 1
    }
  }

  const crossAgentPairs = new Set()
  let claimedReuse = 0
  let behaviorChangedReuse = 0
  let outcomeImprovedReuse = 0
  let verifiedReuse = 0
  let autoClaimedReuse = 0
  let confirmedReuse = 0
  let pendingAutoClaims = 0

  for (const record of reuseRecords) {
    const sourceAgent = normalizeIdentity(record.sourceAgent)
    const targetAgent = normalizeIdentity(record.targetAgent)
    const reuse = readBoolean(record, 'reuse') === true
    const behaviorChanged = readBoolean(record, 'behaviorChanged') === true
    const outcomeImproved = readBoolean(record, 'outcomeImproved') === true

    if (reuse) claimedReuse += 1
    if (reuse && behaviorChanged) behaviorChangedReuse += 1
    if (reuse && outcomeImproved) outcomeImprovedReuse += 1
    if (reuse && behaviorChanged && outcomeImproved) verifiedReuse += 1
    if (readString(record, 'source') === 'auto_claim') {
      autoClaimedReuse += 1
      if (readBoolean(record, 'confirmed') !== true) pendingAutoClaims += 1
    }
    if (readBoolean(record, 'confirmed') === true) confirmedReuse += 1

    if (sourceAgent && targetAgent && sourceAgent !== targetAgent) {
      crossAgentPairs.add(`${sourceAgent}->${targetAgent}`)
    }
  }

  const agentCoverage = hostList.map((agent) => {
    const hostMemories = memories.filter((record) => normalizeIdentity(record.source) === agent)
    const hostTraces = traces.filter((record) => normalizeIdentity(record.agent) === agent)
    const hostReuse = reuseRecords.filter(
      (record) =>
        normalizeIdentity(record.sourceAgent) === agent ||
        normalizeIdentity(record.targetAgent) === agent,
    )
    const lastActiveTs = [...hostMemories, ...hostTraces, ...hostReuse]
      .map(readTimestamp)
      .filter(Boolean)
      .reduce((max, value) => Math.max(max, value), null)
    const dataSources = []
    if (hostMemories.length > 0) dataSources.push('memory')
    if (hostTraces.length > 0) dataSources.push('trace')
    if (hostReuse.length > 0) dataSources.push('reuse')
    return {
      agent,
      memoryRecords: hostMemories.length,
      traceEvents: hostTraces.length,
      taskOutcomes: hostTraces.filter(
        (record) => normalizeEventType(record.event_type) === TASK_OUTCOME_EVENT,
      ).length,
      verifiedReuseAsTarget: hostReuse.filter(
        (record) => normalizeIdentity(record.targetAgent) === agent && isVerifiedReuse(record),
      ).length,
      lastActiveAt: lastActiveTs === null ? null : new Date(lastActiveTs).toISOString(),
      lastActiveHoursAgo:
        lastActiveTs === null
          ? null
          : Number(((Date.now() - lastActiveTs) / 3600000).toFixed(1)),
      active: lastActiveTs !== null && Date.now() - lastActiveTs <= HOST_ACTIVE_WINDOW_MS,
      dataSources,
    }
  })

  const metrics = {
    memoryRecords: memories.length,
    traceEvents: traces.length,
    taskOutcomes,
    experienceReuseRecords: reuseRecords.length,
    autoClaimedReuse,
    confirmedReuse,
    pendingAutoClaims,
    claimedReuse,
    behaviorChangedReuse,
    outcomeImprovedReuse,
    verifiedReuse,
    hostCount: hostList.length,
    activeHostCount: agentCoverage.filter((coverage) => coverage.active).length,
    hosts: hostList,
    crossAgentPairs: Array.from(crossAgentPairs).sort(),
    outcomeByStatus,
    agentCoverage,
  }

  const criteria = [
    {
      key: 'hosts',
      label: 'Distinct agent hosts',
      current: metrics.hostCount,
      required: PHASE0_THRESHOLDS.minHosts,
      passed: metrics.hostCount >= PHASE0_THRESHOLDS.minHosts,
    },
    {
      key: 'tasks',
      label: 'Task outcomes',
      current: metrics.taskOutcomes,
      required: PHASE0_THRESHOLDS.minTaskOutcomes,
      passed: metrics.taskOutcomes >= PHASE0_THRESHOLDS.minTaskOutcomes,
    },
    {
      key: 'verified_reuse',
      label: 'Verified cross-agent reuses',
      current: metrics.verifiedReuse,
      required: PHASE0_THRESHOLDS.minVerifiedReuse,
      passed: metrics.verifiedReuse >= PHASE0_THRESHOLDS.minVerifiedReuse,
    },
    {
      key: 'measurable_improvement',
      label: 'Reuse events with improved outcome',
      current: metrics.outcomeImprovedReuse,
      required: PHASE0_THRESHOLDS.minImprovementEvidence,
      passed: metrics.outcomeImprovedReuse >= PHASE0_THRESHOLDS.minImprovementEvidence,
    },
  ]

  const totalEvidence =
    metrics.memoryRecords + metrics.traceEvents + metrics.experienceReuseRecords
  const status = criteria.every((criterion) => criterion.passed)
    ? 'passed'
    : totalEvidence === 0
      ? 'not_started'
      : 'in_progress'

  return {
    generatedAt: new Date().toISOString(),
    status,
    criteria,
    metrics,
  }
}

function loadPhase0(dataDir, project) {
  const normalizedProject = project && project.trim() ? project.trim() : undefined
  const memories = readJsonl(path.join(dataDir, 'memory.jsonl')).map(asRecord).filter(Boolean)
  const traces = readJsonl(path.join(dataDir, 'traces.jsonl')).map(asRecord).filter(Boolean)
  const reuseRecords = readJsonl(path.join(dataDir, 'experience_reuse.jsonl'))
    .map(asRecord)
    .filter(Boolean)

  return analyzePhase0({
    memories: filterByProject(memories, normalizedProject),
    traces: filterByProject(traces, normalizedProject),
    reuseRecords: filterByProject(reuseRecords, normalizedProject),
  })
}

function renderPhase0Markdown(report) {
  const lines = []
  lines.push('# Mio Phase 0 Validation Report')
  lines.push('')
  lines.push(`- Generated: ${report.generatedAt}`)
  lines.push(`- Status: **${report.status}**`)
  lines.push('')
  lines.push('## Gate Status')
  for (const criterion of report.criteria) {
    const mark = criterion.passed ? '✅' : '❌'
    lines.push(`- ${mark} ${criterion.label}: ${criterion.current}/${criterion.required}`)
  }
  lines.push('')
  lines.push('## Evidence Volume')
  lines.push(`- Memory records: ${report.metrics.memoryRecords}`)
  lines.push(`- Trace events: ${report.metrics.traceEvents}`)
  lines.push(`- Task outcomes: ${report.metrics.taskOutcomes}`)
  lines.push(`- Experience reuse records: ${report.metrics.experienceReuseRecords}`)
  lines.push(`- Active hosts: ${report.metrics.activeHostCount}/${report.metrics.hostCount}`)
  lines.push('')
  lines.push('## Reuse Funnel')
  lines.push(`- Auto-claimed reuse: ${report.metrics.autoClaimedReuse}`)
  lines.push(`- Pending auto-claims (awaiting confirmation): ${report.metrics.pendingAutoClaims}`)
  lines.push(`- Confirmed reuse: ${report.metrics.confirmedReuse}`)
  lines.push(`- Claimed reuse: ${report.metrics.claimedReuse}`)
  lines.push(`- Behavior changed: ${report.metrics.behaviorChangedReuse}`)
  lines.push(`- Outcome improved: ${report.metrics.outcomeImprovedReuse}`)
  lines.push(`- Verified reuse: ${report.metrics.verifiedReuse}`)
  lines.push('')
  lines.push('## Agent Coverage')
  if (report.metrics.agentCoverage.length === 0) {
    lines.push('- No agent identities found.')
  } else {
    for (const coverage of report.metrics.agentCoverage) {
      const activeLabel =
        coverage.active && coverage.lastActiveHoursAgo !== null
          ? `yes (${coverage.lastActiveHoursAgo}h ago)`
          : 'no'
      lines.push(
        `- ${coverage.agent}: ${coverage.memoryRecords} memories, ${coverage.traceEvents} traces, ${coverage.taskOutcomes} task outcomes, ${coverage.verifiedReuseAsTarget} verified reuse | active: ${activeLabel} | sources: ${coverage.dataSources.join(', ') || 'none'}`,
      )
    }
  }
  lines.push('')
  lines.push('## Cross-Agent Pairs')
  if (report.metrics.crossAgentPairs.length === 0) {
    lines.push('- No cross-agent reuse pairs found.')
  } else {
    for (const pair of report.metrics.crossAgentPairs) {
      lines.push(`- ${pair}`)
    }
  }
  lines.push('')
  lines.push('## Trace Outcomes')
  const outcome = report.metrics.outcomeByStatus
  lines.push(
    `- success: ${outcome.success}, failure: ${outcome.failure}, error: ${outcome.error}, aborted: ${outcome.aborted}, retry: ${outcome.retry}, other: ${outcome.other}`,
  )
  lines.push('')
  return lines.join('\n')
}

function summarizePhase0(report) {
  const remaining = (report.criteria || [])
    .filter((criterion) => !criterion.passed)
    .map((criterion) => ({
      key: criterion.key,
      label: criterion.label,
      current: criterion.current,
      required: criterion.required,
      gap: Math.max(0, criterion.required - criterion.current),
    }))

  return {
    status: report.status,
    passed: remaining.length === 0,
    remaining,
  }
}

module.exports = {
  PHASE0_THRESHOLDS,
  analyzePhase0,
  loadPhase0,
  renderPhase0Markdown,
  summarizePhase0,
}
