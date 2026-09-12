import { describe, expect, it } from 'vitest'

import type { ToolCallRecord } from '@akemi-mio/capabilities/tool/ToolCallLogStore'
import type { CapabilityEvolutionShadowRun } from '@akemi-mio/evolution/automation/types'
import { resolveCapabilityEvolutionShadowRun } from '@akemi-mio/evolution/automation/CapabilityEvolutionShadowObservationSource'

function makeRecord(overrides: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'rec-1',
    toolName: 'list_files',
    args: {},
    result: 'ok',
    error: null,
    durationMs: 12,
    timestamp: 1,
    success: true,
    errorType: null,
    capability: 'file.management',
    operation: 'read',
    provider: '@builtin/core',
    ...overrides,
  }
}

function makeStoredRun(generatedAt: number): CapabilityEvolutionShadowRun {
  return {
    runId: `stored-${generatedAt}`,
    collectorName: 'capability-evolution-shadow-collector',
    generatedAt,
    observations: [],
    summary: {
      totalToolEvents: 10,
      capabilityEvents: 0,
      coverageRate: 0,
      legacyBucketCount: 0,
      capabilityBucketCount: 0,
      aggregationGain: 0,
      aggregationGainRate: 0,
      trendSampleCount: 0,
      trendCorrelation: null,
    },
  }
}

describe('resolveCapabilityEvolutionShadowRun', () => {
  it('prefers stored run when it is at least as fresh as the latest tool log entry', () => {
    const stored = makeStoredRun(200)
    const records = [makeRecord({ timestamp: 150 })]

    const resolved = resolveCapabilityEvolutionShadowRun({
      latestStoredRun: stored,
      records,
      collectorName: 'capability-evolution-shadow-collector',
      now: 999,
    })

    expect(resolved.source).toBe('stored-run')
    expect(resolved.run).toBe(stored)
  })

  it('rebuilds from live tool logs when the stored run is stale', () => {
    const stored = makeStoredRun(100)
    const records = [
      makeRecord({
        id: 'rec-2',
        timestamp: 250,
        toolName: 'list_files',
        capability: 'file.management',
        operation: 'read',
      }),
      makeRecord({
        id: 'rec-3',
        timestamp: 260,
        toolName: 'run_command',
        capability: 'system.execution',
        operation: 'run',
      }),
    ]

    const resolved = resolveCapabilityEvolutionShadowRun({
      latestStoredRun: stored,
      records,
      collectorName: 'capability-evolution-shadow-collector',
      now: 500,
    })

    expect(resolved.source).toBe('live-tool-log')
    expect(resolved.run.generatedAt).toBe(500)
    expect(resolved.run.summary.totalToolEvents).toBe(2)
    expect(resolved.run.summary.capabilityEvents).toBe(2)
    expect(resolved.run.summary.coverageRate).toBe(1)
    expect(resolved.run.observations.map((item) => item.capabilityIdentity.capability)).toEqual(['file.management', 'system.execution'])
  })
})
