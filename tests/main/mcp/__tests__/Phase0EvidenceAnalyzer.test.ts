import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  Phase0EvidenceAnalyzer,
  PHASE0_THRESHOLDS,
  type Phase0MemoryRecord,
  type Phase0TraceRecord,
  type Phase0ExperienceReuseRecord,
} from '@akemi-mio/intelligence/mcp/Phase0EvidenceAnalyzer'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mio-phase0-'))
  tempDirs.push(dir)
  return dir
}

function memory(overrides: Record<string, unknown> = {}): Phase0MemoryRecord {
  return {
    id: 'mem-1',
    timestamp: '2026-08-15T00:00:00.000Z',
    kind: 'decision',
    content: 'decided to use shared memory',
    project: 'akemi-mio',
    source: 'codex',
    ...overrides,
  }
}

function trace(overrides: Record<string, unknown> = {}): Phase0TraceRecord {
  return {
    id: 'trace-1',
    timestamp: '2026-08-15T00:00:00.000Z',
    trace_id: 'task-1',
    event_type: 'task_outcome',
    outcome: 'success',
    agent: 'codex',
    host: 'mcp',
    project: 'akemi-mio',
    ...overrides,
  }
}

function reuse(overrides: Record<string, unknown> = {}): Phase0ExperienceReuseRecord {
  return {
    id: 'xfer-1',
    timestamp: '2026-08-15T00:00:00.000Z',
    sourceAgent: 'codex',
    targetAgent: 'opencode',
    experienceId: 'mem-1',
    reuse: true,
    behaviorChanged: true,
    outcomeImproved: true,
    project: 'akemi-mio',
    ...overrides,
  }
}

function passingDataset() {
  const memories: Phase0MemoryRecord[] = [memory(), memory({ id: 'mem-2', source: 'opencode' })]
  const traces: Phase0TraceRecord[] = Array.from({ length: 20 }, (_, index) =>
    trace({
      id: `trace-${index}`,
      trace_id: `task-${index}`,
      agent: index % 2 === 0 ? 'codex' : 'opencode',
    }),
  )
  const reuseRecords: Phase0ExperienceReuseRecord[] = Array.from({ length: 5 }, (_, index) =>
    reuse({ id: `xfer-${index}`, experienceId: `mem-${index}` }),
  )
  return { memories, traces, reuseRecords }
}

describe('Phase0EvidenceAnalyzer', () => {
  it('returns not_started and empty metrics for an empty dataset', () => {
    const report = Phase0EvidenceAnalyzer.analyze({
      memories: [],
      traces: [],
      reuseRecords: [],
    })

    expect(report.status).toBe('not_started')
    expect(report.metrics.memoryRecords).toBe(0)
    expect(report.metrics.traceEvents).toBe(0)
    expect(report.metrics.taskOutcomes).toBe(0)
    expect(report.metrics.experienceReuseRecords).toBe(0)
    expect(report.metrics.confirmedReuse).toBe(0)
    expect(report.metrics.pendingAutoClaims).toBe(0)
    expect(report.metrics.hostCount).toBe(0)
    expect(report.criteria.every((criterion) => criterion.passed)).toBe(false)
  })

  it('derives host coverage from memory source, trace agent, and reuse endpoints', () => {
    const report = Phase0EvidenceAnalyzer.analyze({
      memories: [memory({ source: 'codex' }), memory({ id: 'mem-2', source: 'mcp' }), memory({ id: 'mem-3', source: 'WorkBuddy' })],
      traces: [trace({ agent: 'opencode', host: 'mcp' })],
      reuseRecords: [reuse({ sourceAgent: 'codex', targetAgent: 'opencode' })],
    })

    expect(report.metrics.hosts).toEqual(['codex', 'opencode', 'workbuddy'])
    expect(report.metrics.hostCount).toBe(3)
    expect(report.metrics.crossAgentPairs).toContain('codex->opencode')
  })

  it('counts task_outcome events and aggregates outcome statuses', () => {
    const report = Phase0EvidenceAnalyzer.analyze({
      memories: [],
      traces: [
        trace({ id: 't1', event_type: 'tool_call', outcome: 'success' }),
        trace({ id: 't2', event_type: 'task_outcome', outcome: 'success' }),
        trace({ id: 't3', event_type: 'task_outcome', outcome: 'failure' }),
        trace({ id: 't4', event_type: 'retry', outcome: 'retry' }),
        trace({ id: 't5', event_type: 'task_outcome', outcome: 'aborted' }),
      ],
      reuseRecords: [],
    })

    expect(report.metrics.traceEvents).toBe(5)
    expect(report.metrics.taskOutcomes).toBe(3)
    expect(report.metrics.outcomeByStatus).toMatchObject({
      success: 2,
      failure: 1,
      retry: 1,
      aborted: 1,
    })
  })

  it('uses a reuse funnel and only counts verified reuse when all evidence flags are true', () => {
    const report = Phase0EvidenceAnalyzer.analyze({
      memories: [],
      traces: [],
      reuseRecords: [
        reuse({ id: 'r1', reuse: true, behaviorChanged: false, outcomeImproved: false }),
        reuse({ id: 'r2', reuse: true, behaviorChanged: true, outcomeImproved: false }),
        reuse({ id: 'r3', reuse: true, behaviorChanged: true, outcomeImproved: true }),
        reuse({ id: 'r4', reuse: false, behaviorChanged: true, outcomeImproved: true }),
        reuse({ id: 'r5', reuse: 'true', behaviorChanged: 'true', outcomeImproved: 'true' }),
      ],
    })

    expect(report.metrics.claimedReuse).toBe(4)
    expect(report.metrics.behaviorChangedReuse).toBe(3)
    expect(report.metrics.outcomeImprovedReuse).toBe(2)
    expect(report.metrics.verifiedReuse).toBe(2)
  })

  it('marks the Phase 0 gate passed when all thresholds are met', () => {
    const report = Phase0EvidenceAnalyzer.analyze(passingDataset())

    expect(report.status).toBe('passed')
    expect(report.metrics.hostCount).toBe(2)
    expect(report.metrics.taskOutcomes).toBe(20)
    expect(report.metrics.verifiedReuse).toBe(5)
    expect(report.criteria).toEqual([
      {
        key: 'hosts',
        label: 'Distinct agent hosts',
        current: 2,
        required: PHASE0_THRESHOLDS.minHosts,
        passed: true,
      },
      {
        key: 'tasks',
        label: 'Task outcomes',
        current: 20,
        required: PHASE0_THRESHOLDS.minTaskOutcomes,
        passed: true,
      },
      {
        key: 'verified_reuse',
        label: 'Verified cross-agent reuses',
        current: 5,
        required: PHASE0_THRESHOLDS.minVerifiedReuse,
        passed: true,
      },
      {
        key: 'measurable_improvement',
        label: 'Reuse events with improved outcome',
        current: 5,
        required: PHASE0_THRESHOLDS.minImprovementEvidence,
        passed: true,
      },
    ])
  })

  it('loads JSONL from a data directory and applies project filtering', () => {
    const dir = makeTempDataDir()
    writeFileSync(
      join(dir, 'memory.jsonl'),
      [JSON.stringify(memory()), JSON.stringify(memory({ id: 'mem-2', project: 'other-repo' })), 'not-json'].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(dir, 'traces.jsonl'),
      [JSON.stringify(trace()), JSON.stringify(trace({ id: 't2', project: 'other-repo' }))].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(dir, 'experience_reuse.jsonl'),
      [JSON.stringify(reuse()), JSON.stringify(reuse({ id: 'r2', project: 'other-repo' }))].join('\n'),
      'utf8',
    )

    const filtered = Phase0EvidenceAnalyzer.loadFromDataDir(dir, 'akemi-mio')
    expect(filtered.metrics.memoryRecords).toBe(1)
    expect(filtered.metrics.traceEvents).toBe(1)
    expect(filtered.metrics.experienceReuseRecords).toBe(1)

    const unfiltered = Phase0EvidenceAnalyzer.loadFromDataDir(dir)
    expect(unfiltered.metrics.memoryRecords).toBe(2)
    expect(unfiltered.metrics.traceEvents).toBe(2)
    expect(unfiltered.metrics.experienceReuseRecords).toBe(2)
  })

  it('counts auto-claimed reuse records separately from verified reuse', () => {
    const report = Phase0EvidenceAnalyzer.analyze({
      memories: [],
      traces: [],
      reuseRecords: [reuse({ id: 'r1', source: 'auto_claim', behaviorChanged: false }), reuse({ id: 'r2', source: 'agent_report' })],
    })

    expect(report.metrics.autoClaimedReuse).toBe(1)
    expect(report.metrics.claimedReuse).toBe(2)
    expect(report.metrics.verifiedReuse).toBe(1)
  })

  it('counts confirmed auto-claims and includes them in verified reuse', () => {
    const report = Phase0EvidenceAnalyzer.analyze({
      memories: [],
      traces: [],
      reuseRecords: [
        reuse({ id: 'r1', source: 'auto_claim', behaviorChanged: false, outcomeImproved: true }),
        reuse({
          id: 'r2',
          source: 'auto_claim',
          behaviorChanged: true,
          outcomeImproved: true,
          confirmed: true,
          confirmedBy: 'agent',
        }),
        reuse({ id: 'r3', source: 'agent_report' }),
      ],
    })

    expect(report.metrics.autoClaimedReuse).toBe(2)
    expect(report.metrics.confirmedReuse).toBe(1)
    expect(report.metrics.pendingAutoClaims).toBe(1)
    expect(report.metrics.claimedReuse).toBe(3)
    expect(report.metrics.verifiedReuse).toBe(2)
  })

  it('reports per-host health with last activity and data sources', () => {
    const now = Date.now()
    const activeTs = new Date(now - 2 * 60 * 60 * 1000).toISOString()
    const staleTs = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    const report = Phase0EvidenceAnalyzer.analyze({
      memories: [memory({ source: 'codex', timestamp: activeTs }), memory({ source: 'workbuddy-observer', timestamp: staleTs })],
      traces: [
        trace({ agent: 'codex', timestamp: activeTs }),
        trace({ id: 't2', agent: 'codex', event_type: 'tool_call', timestamp: activeTs }),
      ],
      reuseRecords: [],
    })

    const codex = report.metrics.agentCoverage.find((coverage) => coverage.agent === 'codex')
    expect(codex).toBeDefined()
    expect(codex?.active).toBe(true)
    expect(codex?.taskOutcomes).toBe(1)
    expect(codex?.dataSources).toEqual(['memory', 'trace'])
    expect(codex?.lastActiveHoursAgo).toBeLessThan(24)
    expect(codex?.lastActiveAt).toBeTruthy()

    const workbuddy = report.metrics.agentCoverage.find((coverage) => coverage.agent === 'workbuddy-observer')
    expect(workbuddy).toBeDefined()
    expect(workbuddy?.active).toBe(false)
    expect(workbuddy?.lastActiveAt).toBe(staleTs)
    expect(workbuddy?.dataSources).toEqual(['memory'])

    expect(report.metrics.activeHostCount).toBe(1)
  })

  it('renders a markdown report containing gate status and metrics', () => {
    const report = Phase0EvidenceAnalyzer.analyze(passingDataset())
    const markdown = Phase0EvidenceAnalyzer.renderMarkdown(report)

    expect(markdown).toContain('# Mio Phase 0 Validation Report')
    expect(markdown).toContain('Status: **passed**')
    expect(markdown).toContain('Verified cross-agent reuses: 5/5')
    expect(markdown).toContain('codex->opencode')
  })
})
