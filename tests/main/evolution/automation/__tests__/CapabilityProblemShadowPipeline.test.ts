import { describe, expect, it } from 'vitest'

import { buildCapabilityProblemShadowArtifacts } from '@akemi-mio/evolution/automation/CapabilityProblemShadowPipeline'
import type { Problem } from '@akemi-mio/evolution/automation/types'

describe('CapabilityProblemShadowPipeline', () => {
  it('groups eligible legacy problems into capability candidates', () => {
    const result = buildCapabilityProblemShadowArtifacts({
      runId: 'm56-shadow-001',
      generatedAt: 1_722_345_600_000,
      legacyProblems: [
        makeProblem('tool:write_file:error_rate', 'write_file', 'file.management', 'write', 'error_rate'),
        makeProblem('tool:edit_file:error_rate', 'edit_file', 'file.management', 'write', 'error_rate'),
        makeProblem('tool:browser_navigate:timeout', 'browser_navigate', 'browser.automation', 'navigate', 'timeout'),
        makeProblem('tool:legacy_only:timeout', 'legacy_only', undefined, 'navigate', 'timeout'),
      ],
    })

    expect(result.legacyCandidates).toHaveLength(4)
    expect(result.capabilityCandidates).toHaveLength(2)
    expect(result.capabilityCandidates[0].identity).toEqual({
      capability: 'browser.automation',
      operation: 'navigate',
      issueType: 'timeout',
      version: 'm56.v1',
    })
    expect(result.capabilityCandidates[1]).toMatchObject({
      identity: {
        capability: 'file.management',
        operation: 'write',
        issueType: 'error_rate',
        version: 'm56.v1',
      },
      affectedTools: ['edit_file', 'write_file'],
      legacyProblemIds: ['tool:edit_file:error_rate', 'tool:write_file:error_rate'],
    })
    expect(result.comparison).toMatchObject({
      runId: 'm56-shadow-001',
      generatedAt: 1_722_345_600_000,
      eligibleLegacyCount: 3,
      capabilityCandidateCount: 2,
      legacyOnlyProblemCount: 1,
      matchedProblemCount: 3,
      fragmentationReduction: 1,
      fragmentationReductionRate: 1 / 3,
    })
    expect(result.capabilityCandidates[1].legacyEvidence).toEqual([
      expect.objectContaining({
        legacyProblemId: 'tool:edit_file:error_rate',
        toolName: 'edit_file',
        provider: '@builtin/core',
      }),
      expect.objectContaining({
        legacyProblemId: 'tool:write_file:error_rate',
        toolName: 'write_file',
        provider: '@builtin/core',
      }),
    ])
  })

  it('preserves tool evidence on grouped capability candidates', () => {
    const result = buildCapabilityProblemShadowArtifacts({
      runId: 'm56-shadow-002',
      generatedAt: 1_722_345_700_000,
      legacyProblems: [
        makeProblem('tool:write_file:error_rate', 'write_file', 'file.management', 'write', 'error_rate', '@core/fs'),
        makeProblem('tool:edit_file:error_rate', 'edit_file', 'file.management', 'write', 'error_rate', '@core/fs'),
      ],
    })

    expect(result.capabilityCandidates[0]).toMatchObject({
      affectedTools: ['edit_file', 'write_file'],
      providers: ['@core/fs'],
      legacyToolNames: ['edit_file', 'write_file'],
    })
  })

  it('merges grouped candidates deterministically regardless of input order', () => {
    const forward = buildCapabilityProblemShadowArtifacts({
      runId: 'm56-shadow-003',
      generatedAt: 1_722_345_800_000,
      legacyProblems: [
        makeProblem('tool:write_file:warning', 'write_file', 'file.management', 'write', 'error_rate', '@core/fs', {
          severity: 'warning',
          title: 'write_file warning',
          description: 'write warning',
          source: 'tool',
        }),
        makeProblem('tool:edit_file:error', 'edit_file', 'file.management', 'write', 'error_rate', '@core/fs', {
          severity: 'error',
          title: 'edit_file error',
          description: 'edit error',
          source: 'behavior',
        }),
      ],
    })
    const reverse = buildCapabilityProblemShadowArtifacts({
      runId: 'm56-shadow-004',
      generatedAt: 1_722_345_800_000,
      legacyProblems: [
        makeProblem('tool:edit_file:error', 'edit_file', 'file.management', 'write', 'error_rate', '@core/fs', {
          severity: 'error',
          title: 'edit_file error',
          description: 'edit error',
          source: 'behavior',
        }),
        makeProblem('tool:write_file:warning', 'write_file', 'file.management', 'write', 'error_rate', '@core/fs', {
          severity: 'warning',
          title: 'write_file warning',
          description: 'write warning',
          source: 'tool',
        }),
      ],
    })

    expect(forward.capabilityCandidates).toEqual(reverse.capabilityCandidates)
    expect(forward.capabilityCandidates[0]).toMatchObject({
      severity: 'error',
      source: 'behavior',
      title: 'edit_file error',
      description: 'edit error',
      affectedTools: ['edit_file', 'write_file'],
    })
  })
})

function makeProblem(
  id: string,
  toolName: string,
  affectedCapability: string | undefined,
  operation: string,
  issueType: string,
  provider: string = '@builtin/core',
  overrides?: Partial<Pick<Problem, 'severity' | 'title' | 'description' | 'source' | 'lastSeen' | 'occurrenceCount'>>,
): Problem {
  return {
    id,
    source: overrides?.source ?? 'tool',
    severity: overrides?.severity ?? 'warning',
    title: overrides?.title ?? `${toolName} needs attention`,
    description: overrides?.description ?? `${toolName} has ${issueType}`,
    estimatedCostChars: 120,
    lastSeen: overrides?.lastSeen ?? 1_722_345_600_000,
    occurrenceCount: overrides?.occurrenceCount ?? 1,
    context: {
      raw: `${toolName}:${issueType}`,
      metadata: {
        operation,
        issueType,
        toolName,
        provider,
      },
    },
    affectedCapability,
  }
}
