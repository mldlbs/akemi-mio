import { describe, expect, it } from 'vitest'

import { buildCapabilityMigrationArtifacts } from '../../../../../scripts/m56-capability-migration-report'
import {
  buildLegacyProblemsFromShadowRuns,
  deriveIssueTypeFromShadowMetrics,
  loadShadowObservationRuns,
} from '@akemi-mio/evolution/automation/CapabilityShadowRunHydrator'
import { join } from 'path'
import type { Problem } from '@akemi-mio/evolution/automation/types'

describe('buildCapabilityMigrationArtifacts', () => {
  it('assembles shadow-only migration artifacts with comparison, gate, and rollback outputs', () => {
    const artifacts = buildCapabilityMigrationArtifacts({
      runId: 'm56-migration-demo',
      generatedAt: Date.UTC(2026, 6, 30, 9, 0, 0),
      legacyProblems: [
        makeProblem('tool:write_file:error_rate', 'write_file', 'file.management', 'write', 'error_rate', {
          occurrenceCount: 3,
          severity: 'error',
        }),
        makeProblem('tool:edit_file:error_rate', 'edit_file', 'file.management', 'write', 'error_rate', {
          occurrenceCount: 2,
        }),
        makeProblem('tool:grep:timeout', 'grep', 'search.retrieval', 'query', 'timeout', {
          occurrenceCount: 1,
          lastSeen: Date.UTC(2026, 6, 30, 9, 5, 0),
        }),
        makeProblem('tool:legacy_only:timeout', 'legacy_only', undefined, 'run', 'timeout'),
      ],
      observationWindow: {
        candidateCount: 4,
        observedDays: 1,
      },
    })

    expect(artifacts.comparisonReport).toMatchObject({
      runId: 'm56-migration-demo',
      eligibleLegacyCount: 3,
      capabilityCandidateCount: 2,
      legacyOnlyProblemCount: 1,
      matchedProblemCount: 3,
      fragmentationReduction: 1,
      fragmentationReductionRate: 1 / 3,
      decisionConsistencyRate: 1,
    })
    expect(artifacts.legacyDecisions).toHaveLength(3)
    expect(artifacts.capabilityDecisions).toHaveLength(2)
    expect(artifacts.decisionDiffReport).toEqual({
      matchedKeys: [
        'capability:file.management|operation:write|issue:error_rate|version:m56.v1',
        'capability:search.retrieval|operation:query|issue:timeout|version:m56.v1',
      ],
      legacyOnlyKeys: [],
      capabilityOnlyKeys: [],
      consistencyRate: 1,
    })
    expect(artifacts.migrationGateReport).toMatchObject({
      status: 'hold',
      metrics: {
        observationWindow: {
          actual: 4,
          passed: false,
        },
      },
    })
    expect(artifacts.rollbackReadinessReport).toEqual({
      capabilityAuthorityEnabled: false,
      legacyAuthorityIntact: true,
      dualWriteTelemetryActive: true,
      legacyEvolutionBehaviorUnchanged: true,
      capabilityPathShadowOnly: true,
      executorAuthorityLegacyOnly: true,
      rollbackAction: 'disable capability authority and continue shadow artifact generation',
    })
  })
})

describe('shadow run hydration', () => {
  it('derives issue type from shadow observation metrics', () => {
    expect(deriveIssueTypeFromShadowMetrics({ errorRate: 0.97, avgLatencyMs: 4 })).toBe('error_rate')
    expect(deriveIssueTypeFromShadowMetrics({ errorRate: 0.03, avgLatencyMs: 12_000 })).toBe('latency')
    expect(deriveIssueTypeFromShadowMetrics({ errorRate: 0.03, avgLatencyMs: 400 })).toBe('general')
  })

  it('converts shadow observation runs into legacy problem candidates with capability metadata', () => {
    const problems = buildLegacyProblemsFromShadowRuns([
      {
        runId: 'cap_shadow_1',
        collectorName: 'capability-evolution-shadow-collector',
        generatedAt: 1_722_345_600_000,
        observations: [
          {
            legacyIdentity: { tools: ['list_files', 'read_file'] },
            capabilityIdentity: { capability: 'file.management', operation: 'read', provider: '@builtin/core' },
            metrics: { count: 35, successRate: 0.03, errorRate: 0.97, avgLatencyMs: 4 },
            legacyMetrics: { count: 18, successRate: 0.17, errorRate: 0.83, avgLatencyMs: 4 },
          },
        ],
        summary: {
          totalToolEvents: 35,
          capabilityEvents: 35,
          coverageRate: 1,
          legacyBucketCount: 2,
          capabilityBucketCount: 1,
          aggregationGain: 1,
          aggregationGainRate: 0.5,
          trendSampleCount: 1,
          trendCorrelation: null,
        },
      },
      {
        runId: 'cap_shadow_2',
        collectorName: 'capability-evolution-shadow-collector',
        generatedAt: 1_722_352_200_000,
        observations: [
          {
            legacyIdentity: { tools: ['grep'] },
            capabilityIdentity: { capability: 'search.retrieval', operation: 'query', provider: '@builtin/core' },
            metrics: { count: 80, successRate: 1, errorRate: 0, avgLatencyMs: 1_720 },
            legacyMetrics: { count: 80, successRate: 1, errorRate: 0, avgLatencyMs: 1_720 },
          },
        ],
        summary: {
          totalToolEvents: 80,
          capabilityEvents: 80,
          coverageRate: 1,
          legacyBucketCount: 1,
          capabilityBucketCount: 1,
          aggregationGain: 1,
          aggregationGainRate: 0,
          trendSampleCount: 1,
          trendCorrelation: null,
        },
      },
    ])

    expect(problems).toHaveLength(3)
    const listFiles = problems.find((p) => p.id.includes('list_files'))!
    expect(listFiles.affectedCapability).toBe('file.management')
    expect(listFiles.context.metadata).toMatchObject({
      toolName: 'list_files',
      provider: '@builtin/core',
      operation: 'read',
      issueType: 'error_rate',
    })
    expect(listFiles.severity).toBe('error')
    expect(listFiles.occurrenceCount).toBe(35)
    expect(listFiles.lastSeen).toBe(1_722_345_600_000)
    const grep = problems.find((p) => p.id.includes('grep'))!
    expect(grep.context.metadata.issueType).toBe('general')
    expect(grep.severity).toBe('warning')
  })

  it('returns an empty array when the shadow run store is missing or malformed', () => {
    expect(loadShadowObservationRuns(join('__no_such_dir__', 'nested'))).toEqual([])
  })
})

function makeProblem(
  id: string,
  toolName: string,
  affectedCapability: string | undefined,
  operation: string,
  issueType: string,
  overrides?: Partial<Pick<Problem, 'occurrenceCount' | 'severity' | 'lastSeen'>>,
): Problem {
  return {
    id,
    source: 'tool',
    severity: overrides?.severity ?? 'warning',
    title: `${toolName} issue`,
    description: `${toolName} issue`,
    estimatedCostChars: 100,
    lastSeen: overrides?.lastSeen ?? Date.UTC(2026, 6, 30, 9, 0, 0),
    occurrenceCount: overrides?.occurrenceCount ?? 1,
    context: {
      raw: `${toolName}:${issueType}`,
      metadata: {
        toolName,
        provider: '@builtin/core',
        operation,
        issueType,
      },
    },
    affectedCapability,
  }
}
