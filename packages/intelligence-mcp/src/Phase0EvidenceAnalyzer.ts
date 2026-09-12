import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export const PHASE0_THRESHOLDS = {
  minHosts: 2,
  minTaskOutcomes: 20,
  minVerifiedReuse: 5,
  minImprovementEvidence: 1,
} as const

export type Phase0MemoryRecord = Record<string, unknown>
export type Phase0TraceRecord = Record<string, unknown>
export type Phase0ExperienceReuseRecord = Record<string, unknown>

export interface Phase0EvidenceDataset {
  memories: Phase0MemoryRecord[]
  traces: Phase0TraceRecord[]
  reuseRecords: Phase0ExperienceReuseRecord[]
}

export interface Phase0OutcomeSummary {
  success: number
  failure: number
  error: number
  aborted: number
  retry: number
  other: number
}

export interface Phase0AgentCoverage {
  agent: string
  memoryRecords: number
  traceEvents: number
  taskOutcomes: number
  verifiedReuseAsTarget: number
  lastActiveAt: string | null
  lastActiveHoursAgo: number | null
  active: boolean
  dataSources: string[]
}

export interface Phase0Metrics {
  memoryRecords: number
  traceEvents: number
  taskOutcomes: number
  experienceReuseRecords: number
  autoClaimedReuse: number
  confirmedReuse: number
  pendingAutoClaims: number
  claimedReuse: number
  behaviorChangedReuse: number
  outcomeImprovedReuse: number
  verifiedReuse: number
  hostCount: number
  activeHostCount: number
  hosts: string[]
  crossAgentPairs: string[]
  outcomeByStatus: Phase0OutcomeSummary
  agentCoverage: Phase0AgentCoverage[]
}

export type Phase0GateStatus = 'passed' | 'in_progress' | 'not_started'
export type Phase0GateKey = 'hosts' | 'tasks' | 'verified_reuse' | 'measurable_improvement'

export interface Phase0GateCriterion {
  key: Phase0GateKey
  label: string
  current: number
  required: number
  passed: boolean
}

export interface Phase0Report {
  generatedAt: string
  status: Phase0GateStatus
  criteria: Phase0GateCriterion[]
  metrics: Phase0Metrics
}

const GENERIC_AGENT_IDS = new Set(['mcp'])
const TASK_OUTCOME_EVENT = 'task_outcome'
const HOST_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number') return String(value)
  return null
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function readTimestamp(record: Record<string, unknown>): number | null {
  const raw = record.timestamp
  if (typeof raw === 'string' || typeof raw === 'number') {
    const time = new Date(raw).getTime()
    if (Number.isFinite(time)) return time
  }
  return null
}

function normalizeIdentity(value: unknown): string | null {
  const identity = typeof value === 'string' ? value.trim().toLowerCase() : null
  if (!identity || GENERIC_AGENT_IDS.has(identity)) return null
  return identity
}

function normalizeEventType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const eventType = value.trim().toLowerCase()
  return eventType || null
}

function readJsonl(filePath: string): unknown[] {
  if (!existsSync(filePath)) return []
  const text = readFileSync(filePath, 'utf8')
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((value): value is unknown => value !== null)
}

function toRecords(values: unknown[]): Array<Record<string, unknown>> {
  return values.map(asRecord).filter((value): value is Record<string, unknown> => value !== null)
}

function filterByProject(records: Array<Record<string, unknown>>, project: string | undefined): Array<Record<string, unknown>> {
  if (!project) return records
  return records.filter((record) => readString(record, 'project') === project)
}

function createOutcomeSummary(): Phase0OutcomeSummary {
  return { success: 0, failure: 0, error: 0, aborted: 0, retry: 0, other: 0 }
}

function bumpOutcome(summary: Phase0OutcomeSummary, outcome: string | null): void {
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

function isVerifiedReuse(record: Record<string, unknown>): boolean {
  return (
    readBoolean(record, 'reuse') === true &&
    readBoolean(record, 'behaviorChanged') === true &&
    readBoolean(record, 'outcomeImproved') === true
  )
}

export class Phase0EvidenceAnalyzer {
  static analyze(dataset: Phase0EvidenceDataset): Phase0Report {
    const memories = dataset.memories ?? []
    const traces = dataset.traces ?? []
    const reuseRecords = dataset.reuseRecords ?? []

    const hosts = new Set<string>()
    const addHost = (value: unknown): void => {
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
      const outcome = readString(record, 'outcome')?.toLowerCase() ?? null
      bumpOutcome(outcomeByStatus, outcome)
      if (normalizeEventType(record.event_type) === TASK_OUTCOME_EVENT) {
        taskOutcomes += 1
      }
    }

    const crossAgentPairs = new Set<string>()
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
        (record) => normalizeIdentity(record.sourceAgent) === agent || normalizeIdentity(record.targetAgent) === agent,
      )
      const timestamps = [...hostMemories, ...hostTraces, ...hostReuse]
        .map(readTimestamp)
        .filter((value): value is number => value !== null)
      const lastActiveTs = timestamps.length > 0 ? Math.max(...timestamps) : null
      const dataSources: string[] = []
      if (hostMemories.length > 0) dataSources.push('memory')
      if (hostTraces.length > 0) dataSources.push('trace')
      if (hostReuse.length > 0) dataSources.push('reuse')
      return {
        agent,
        memoryRecords: hostMemories.length,
        traceEvents: hostTraces.length,
        taskOutcomes: hostTraces.filter((record) => normalizeEventType(record.event_type) === TASK_OUTCOME_EVENT).length,
        verifiedReuseAsTarget: hostReuse.filter((record) => normalizeIdentity(record.targetAgent) === agent && isVerifiedReuse(record))
          .length,
        lastActiveAt: lastActiveTs === null ? null : new Date(lastActiveTs).toISOString(),
        lastActiveHoursAgo: lastActiveTs === null ? null : Number(((Date.now() - lastActiveTs) / 3600000).toFixed(1)),
        active: lastActiveTs !== null && Date.now() - lastActiveTs <= HOST_ACTIVE_WINDOW_MS,
        dataSources,
      }
    })

    const metrics: Phase0Metrics = {
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

    const criteria: Phase0GateCriterion[] = [
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

    const totalEvidence = metrics.memoryRecords + metrics.traceEvents + metrics.experienceReuseRecords
    const status: Phase0GateStatus = criteria.every((criterion) => criterion.passed)
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

  static loadFromDataDir(dataDir: string, project?: string): Phase0Report {
    const normalizedProject = project?.trim() || undefined
    const memories = toRecords(readJsonl(join(dataDir, 'memory.jsonl')))
    const traces = toRecords(readJsonl(join(dataDir, 'traces.jsonl')))
    const reuseRecords = toRecords(readJsonl(join(dataDir, 'experience_reuse.jsonl')))

    return this.analyze({
      memories: filterByProject(memories, normalizedProject),
      traces: filterByProject(traces, normalizedProject),
      reuseRecords: filterByProject(reuseRecords, normalizedProject),
    })
  }

  static renderMarkdown(report: Phase0Report): string {
    const lines: string[] = []
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
        const activeLabel = coverage.active && coverage.lastActiveHoursAgo !== null ? `yes (${coverage.lastActiveHoursAgo}h ago)` : 'no'
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
}
