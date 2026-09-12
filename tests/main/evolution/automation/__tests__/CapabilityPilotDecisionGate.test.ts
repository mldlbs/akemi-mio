import { describe, expect, it } from 'vitest'

import { evaluatePilotDecisionEligibility } from '@akemi-mio/evolution/automation/CapabilityPilotDecisionGate'
import type { CapabilityEvolutionShadowRun, Problem } from '@akemi-mio/evolution/automation/types'

function makeProblem(overrides: {
  id: string
  toolName: string
  capability: string
  operation: string
  issueType: string
  source?: Problem['source']
  occurrenceCount?: number
  severity?: Problem['severity']
}): Problem {
  const { id, toolName, capability, operation, issueType, source = 'tool', occurrenceCount = 1, severity = 'warning' } = overrides

  return {
    id,
    source,
    severity,
    title: `${toolName} ${capability} ${operation}`,
    description: `${toolName} -> ${capability} ${operation} (${issueType})`,
    estimatedCostChars: 10,
    lastSeen: Date.now(),
    occurrenceCount,
    context: {
      raw: 'raw',
      metadata: { toolName, operation, issueType, provider: '@builtin/core' },
    },
    affectedCapability: capability,
  }
}

function makeShadowRun(
  observations: Array<{
    capability: string
    operation: string
    tools: string[]
    count: number
    errorRate: number
  }>,
): CapabilityEvolutionShadowRun {
  return {
    runId: 'cap_shadow_pilot_test',
    collectorName: 'capability-evolution-shadow-collector',
    generatedAt: Date.now(),
    observations: observations.map((observation) => ({
      legacyIdentity: { tools: observation.tools },
      capabilityIdentity: {
        capability: observation.capability,
        operation: observation.operation,
        provider: '@builtin/core',
      },
      metrics: {
        count: observation.count,
        successRate: 1 - observation.errorRate,
        errorRate: observation.errorRate,
        avgLatencyMs: 100,
      },
      legacyMetrics: {
        count: observation.count,
        successRate: 1 - observation.errorRate,
        errorRate: observation.errorRate,
        avgLatencyMs: 100,
      },
    })),
    summary: {
      totalToolEvents: 20,
      capabilityEvents: 20,
      coverageRate: 1,
      legacyBucketCount: 2,
      capabilityBucketCount: 2,
      aggregationGain: 0,
      aggregationGainRate: 0,
      trendSampleCount: 2,
      trendCorrelation: null,
    },
  }
}

describe('evaluatePilotDecisionEligibility', () => {
  it('marks decisions eligible when the shadow window agrees at the same rank', () => {
    const record = evaluatePilotDecisionEligibility({
      runId: 'pilot-test',
      generatedAt: 1_722_345_600_000,
      authoritativeProblems: [
        makeProblem({
          id: 'tool:read_file:error_rate',
          toolName: 'read_file',
          capability: 'file.management',
          operation: 'read',
          issueType: 'error_rate',
          occurrenceCount: 10,
          severity: 'error',
        }),
        makeProblem({
          id: 'tool:grep:general',
          toolName: 'grep',
          capability: 'search.retrieval',
          operation: 'query',
          issueType: 'general',
          occurrenceCount: 1,
        }),
      ],
      shadowRuns: [
        makeShadowRun([
          {
            capability: 'file.management',
            operation: 'read',
            tools: ['read_file'],
            count: 10,
            errorRate: 0.5,
          },
          {
            capability: 'search.retrieval',
            operation: 'query',
            tools: ['grep'],
            count: 10,
            errorRate: 0,
          },
        ]),
      ],
    })

    expect(record.decisionCount).toBe(2)
    expect(record.eligibleCount).toBe(2)
    expect(record.eligibilityRate).toBe(1)
    expect(record.decisions.map((decision) => decision.eligible)).toEqual([true, true])
    expect(record.decisions[0].capabilityKey).toContain('capability:file.management')
    expect(record.guardrails).toEqual({
      executorAuthorityUnchanged: true,
      problemQueueUnchanged: true,
      shadowGateActive: true,
    })
  })

  it('marks a decision ineligible when the shadow window does not agree at the same rank', () => {
    const record = evaluatePilotDecisionEligibility({
      runId: 'pilot-test-mismatch',
      generatedAt: 1_722_345_600_000,
      authoritativeProblems: [
        makeProblem({
          id: 'tool:read_file:error_rate',
          toolName: 'read_file',
          capability: 'file.management',
          operation: 'read',
          issueType: 'error_rate',
          occurrenceCount: 10,
          severity: 'error',
        }),
        makeProblem({
          id: 'tool:grep:general',
          toolName: 'grep',
          capability: 'search.retrieval',
          operation: 'query',
          issueType: 'general',
          occurrenceCount: 1,
        }),
      ],
      shadowRuns: [
        makeShadowRun([
          {
            capability: 'file.management',
            operation: 'read',
            tools: ['read_file'],
            count: 10,
            errorRate: 0.5,
          },
        ]),
      ],
    })

    expect(record.decisionCount).toBe(2)
    expect(record.eligibleCount).toBe(1)
    expect(record.eligibilityRate).toBe(0.5)
    expect(record.decisions[0].eligible).toBe(true)
    expect(record.decisions[1].eligible).toBe(false)
  })

  it('excludes non-tool problems from the pilot domain', () => {
    const record = evaluatePilotDecisionEligibility({
      runId: 'pilot-test-domain',
      generatedAt: 1_722_345_600_000,
      authoritativeProblems: [
        makeProblem({
          id: 'tool:read_file:error_rate',
          toolName: 'read_file',
          capability: 'file.management',
          operation: 'read',
          issueType: 'error_rate',
          occurrenceCount: 10,
          severity: 'error',
        }),
        makeProblem({
          id: 'behavior:user:general',
          toolName: 'behavior_tool',
          capability: 'system.execution',
          operation: 'run',
          issueType: 'general',
          source: 'behavior',
          occurrenceCount: 99,
          severity: 'error',
        }),
      ],
      shadowRuns: [],
    })

    expect(record.decisionCount).toBe(1)
    expect(record.decisions[0].capabilityKey).toContain('capability:file.management')
    expect(record.shadowRunCount).toBe(0)
  })

  it('returns an empty record when there are no capability-eligible tool problems', () => {
    const record = evaluatePilotDecisionEligibility({
      runId: 'pilot-test-empty',
      generatedAt: 1_722_345_600_000,
      authoritativeProblems: [
        makeProblem({
          id: 'tool:legacy_only:general',
          toolName: 'legacy_tool',
          capability: '',
          operation: 'run',
          issueType: 'general',
          occurrenceCount: 1,
        }),
      ],
      shadowRuns: [makeShadowRun([])],
    })

    expect(record.decisionCount).toBe(0)
    expect(record.eligibleCount).toBe(0)
    expect(record.eligibilityRate).toBe(0)
  })
})
