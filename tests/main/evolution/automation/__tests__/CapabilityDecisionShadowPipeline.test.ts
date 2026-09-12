import { describe, expect, it } from 'vitest'

import {
  buildCapabilityDecisionCandidates,
  buildDecisionDiffReport,
  buildLegacyDecisionCandidates,
} from '@akemi-mio/evolution/automation/CapabilityDecisionShadowPipeline'
import type { CapabilityProblemCandidate, Problem } from '@akemi-mio/evolution/automation/types'

describe('CapabilityDecisionShadowPipeline', () => {
  it('projects legacy and capability candidates into comparable decision views', () => {
    const legacyProblems: Problem[] = [
      makeProblem('tool:write_file:error_rate', 'write_file', 'file.management', 'write', 'error_rate', {
        occurrenceCount: 3,
        severity: 'error',
      }),
      makeProblem('tool:edit_file:error_rate', 'edit_file', 'file.management', 'write', 'error_rate', {
        occurrenceCount: 2,
        severity: 'warning',
      }),
      makeProblem('tool:browser_navigate:timeout', 'browser_navigate', 'browser.automation', 'navigate', 'timeout', {
        occurrenceCount: 1,
        severity: 'warning',
      }),
    ]
    const capabilityCandidates: CapabilityProblemCandidate[] = [
      {
        identity: {
          capability: 'browser.automation',
          operation: 'navigate',
          issueType: 'timeout',
          version: 'm56.v1',
        },
        title: 'browser timeout',
        description: 'timeout',
        severity: 'warning',
        source: 'tool',
        affectedTools: ['browser_navigate'],
        providers: ['@builtin/browser'],
        legacyProblemIds: ['tool:browser_navigate:timeout'],
        legacyToolNames: ['browser_navigate'],
        legacyEvidence: [
          {
            legacyProblemId: 'tool:browser_navigate:timeout',
            toolName: 'browser_navigate',
            provider: '@builtin/browser',
            raw: 'browser timeout',
          },
        ],
        occurrenceCount: 1,
        lastSeen: 1_722_345_601_000,
      },
      {
        identity: {
          capability: 'file.management',
          operation: 'write',
          issueType: 'error_rate',
          version: 'm56.v1',
        },
        title: 'file write error rate',
        description: 'write failures',
        severity: 'error',
        source: 'tool',
        affectedTools: ['edit_file', 'write_file'],
        providers: ['@builtin/core'],
        legacyProblemIds: ['tool:edit_file:error_rate', 'tool:write_file:error_rate'],
        legacyToolNames: ['edit_file', 'write_file'],
        legacyEvidence: [
          {
            legacyProblemId: 'tool:edit_file:error_rate',
            toolName: 'edit_file',
            provider: '@builtin/core',
            raw: 'edit_file:error_rate',
          },
          {
            legacyProblemId: 'tool:write_file:error_rate',
            toolName: 'write_file',
            provider: '@builtin/core',
            raw: 'write_file:error_rate',
          },
        ],
        occurrenceCount: 5,
        lastSeen: 1_722_345_602_000,
      },
    ]

    const legacyDecisions = buildLegacyDecisionCandidates(legacyProblems)
    const capabilityDecisions = buildCapabilityDecisionCandidates(capabilityCandidates)

    expect(legacyDecisions).toHaveLength(3)
    expect(legacyDecisions[0]).toMatchObject({
      capabilityKey: 'capability:file.management|operation:write|issue:error_rate|version:m56.v1',
      score: 6,
      affectedTools: ['write_file'],
      supportingProblemIds: ['tool:write_file:error_rate'],
    })
    expect(capabilityDecisions).toEqual([
      expect.objectContaining({
        capabilityKey: 'capability:file.management|operation:write|issue:error_rate|version:m56.v1',
        score: 10,
        affectedTools: ['edit_file', 'write_file'],
      }),
      expect.objectContaining({
        capabilityKey: 'capability:browser.automation|operation:navigate|issue:timeout|version:m56.v1',
        score: 1,
        affectedTools: ['browser_navigate'],
      }),
    ])
  })

  it('computes decision consistency using the legacy decision key set as denominator', () => {
    const diff = buildDecisionDiffReport({
      legacyDecisions: [
        {
          identity: {
            capability: 'file.management',
            operation: 'write',
            issueType: 'error_rate',
            version: 'm56.v1',
          },
          capabilityKey: 'capability:file.management|operation:write|issue:error_rate|version:m56.v1',
          score: 4,
          affectedTools: ['write_file'],
          supportingProblemIds: ['tool:write_file:error_rate'],
        },
        {
          identity: {
            capability: 'browser.automation',
            operation: 'navigate',
            issueType: 'timeout',
            version: 'm56.v1',
          },
          capabilityKey: 'capability:browser.automation|operation:navigate|issue:timeout|version:m56.v1',
          score: 2,
          affectedTools: ['browser_navigate'],
          supportingProblemIds: ['tool:browser_navigate:timeout'],
        },
      ],
      capabilityDecisions: [
        {
          identity: {
            capability: 'file.management',
            operation: 'write',
            issueType: 'error_rate',
            version: 'm56.v1',
          },
          capabilityKey: 'capability:file.management|operation:write|issue:error_rate|version:m56.v1',
          score: 5,
          affectedTools: ['edit_file', 'write_file'],
          supportingProblemIds: ['tool:edit_file:error_rate', 'tool:write_file:error_rate'],
        },
      ],
    })

    expect(diff).toEqual({
      matchedKeys: ['capability:file.management|operation:write|issue:error_rate|version:m56.v1'],
      legacyOnlyKeys: ['capability:browser.automation|operation:navigate|issue:timeout|version:m56.v1'],
      capabilityOnlyKeys: [],
      consistencyRate: 0.5,
    })
  })
})

function makeProblem(
  id: string,
  toolName: string,
  affectedCapability: string,
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
    lastSeen: overrides?.lastSeen ?? 1_722_345_600_000,
    occurrenceCount: overrides?.occurrenceCount ?? 1,
    context: {
      raw: `${toolName}:${issueType}`,
      metadata: {
        toolName,
        provider: toolName.startsWith('browser') ? '@builtin/browser' : '@builtin/core',
        operation,
        issueType,
      },
    },
    affectedCapability,
  }
}
