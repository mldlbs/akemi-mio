import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { CapabilityMigrationArtifactStore } from '@akemi-mio/evolution/automation/CapabilityMigrationArtifactStore'
import type { CapabilityDecisionCandidate, CapabilityMigrationComparisonReport, CapabilityProblemCandidate, Problem } from '@akemi-mio/evolution/automation/types'

describe('CapabilityMigrationArtifactStore', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'm56-migration-artifacts-'))
  })

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('writes and reads the required migration artifact json files for one shadow run', () => {
    const store = new CapabilityMigrationArtifactStore(tmpDir)
    const capabilityCandidates: CapabilityProblemCandidate[] = [
      {
        identity: {
          capability: 'browser.automation',
          operation: 'navigate',
          issueType: 'timeout',
          version: 'm56.v1',
        },
        title: 'browser navigate timeout',
        description: 'navigation timeout',
        severity: 'error',
        source: 'tool',
        affectedTools: ['browser_navigate'],
        providers: ['@browser/core'],
        legacyProblemIds: ['tool:browser_navigate:timeout'],
        legacyToolNames: ['browser_navigate'],
        occurrenceCount: 2,
        lastSeen: 1_722_345_600_000,
      },
      {
        identity: {
          capability: 'file.management',
          operation: 'write',
          issueType: 'error_rate',
          version: 'm56.v1',
        },
        title: 'file write error rate',
        description: 'write failure trend',
        severity: 'warning',
        source: 'tool',
        affectedTools: ['edit_file', 'write_file'],
        providers: ['@core/fs'],
        legacyProblemIds: ['tool:edit_file:error_rate', 'tool:write_file:error_rate'],
        legacyToolNames: ['edit_file', 'write_file'],
        occurrenceCount: 3,
        lastSeen: 1_722_345_600_100,
      },
    ]
    const legacyProblems: Problem[] = [
      makeProblem('tool:browser_navigate:timeout', 'browser_navigate'),
      makeProblem('tool:edit_file:error_rate', 'edit_file'),
      makeProblem('tool:write_file:error_rate', 'write_file'),
    ]
    const comparisonReport: CapabilityMigrationComparisonReport = {
      runId: 'm56-shadow-001',
      generatedAt: 1_722_345_600_000,
      eligibleLegacyCount: 3,
      capabilityCandidateCount: 2,
      legacyOnlyProblemCount: 0,
      matchedProblemCount: 3,
      decisionConsistencyRate: 0.5,
    }
    const decisions: CapabilityDecisionCandidate[] = capabilityCandidates.map((candidate, index) => ({
      identity: candidate.identity,
      capabilityKey: `candidate:${index + 1}`,
      score: index + 1,
      affectedTools: candidate.affectedTools,
      supportingProblemIds: candidate.legacyProblemIds,
    }))

    store.saveRunArtifacts({
      runId: 'm56-shadow-001',
      generatedAt: 1_722_345_600_000,
      legacyProblemCandidates: legacyProblems,
      capabilityProblemCandidates: capabilityCandidates,
      comparisonReport,
      legacyDecisions: decisions,
      capabilityDecisions: decisions,
      decisionDiffReport: { matchedKeys: ['candidate:1'], consistencyRate: 0.5 },
      migrationGateReport: { status: 'below_gate' },
      rollbackReadinessReport: { ready: false },
    })

    expect(store.readJson('latest/legacy_problem_candidates.json')).toHaveLength(3)
    expect(store.readJson('latest/capability_problem_candidates.json')).toHaveLength(2)
    expect(store.readJson('latest/comparison_report.json')).toMatchObject({
      runId: 'm56-shadow-001',
      eligibleLegacyCount: 3,
    })
    expect(store.readJson('latest/migration_gate_report.json')).toMatchObject({
      status: 'below_gate',
    })
    expect(store.readJson('m56-shadow-001/capability_decisions.json')).toEqual(decisions)
  })

  it('rejects artifact paths that escape the store root', () => {
    const store = new CapabilityMigrationArtifactStore(tmpDir)

    expect(() => store.readJson('../outside.json')).toThrow(/outside rootDir/i)
    expect(() =>
      store.saveRunArtifacts({
        runId: '../outside',
        generatedAt: 1_722_345_600_000,
        legacyProblemCandidates: [],
        capabilityProblemCandidates: [],
        comparisonReport: {
          runId: 'm56-shadow-escape',
          generatedAt: 1_722_345_600_000,
          eligibleLegacyCount: 0,
          capabilityCandidateCount: 0,
          legacyOnlyProblemCount: 0,
          matchedProblemCount: 0,
          decisionConsistencyRate: 0,
        },
        legacyDecisions: [],
        capabilityDecisions: [],
        decisionDiffReport: {},
        migrationGateReport: {},
        rollbackReadinessReport: {},
      }),
    ).toThrow(/outside rootDir/i)
  })
})

function makeProblem(id: string, toolName: string): Problem {
  return {
    id,
    source: 'tool',
    severity: 'warning',
    title: `${toolName} issue`,
    description: `${toolName} issue`,
    estimatedCostChars: 100,
    lastSeen: 1_722_345_600_000,
    occurrenceCount: 1,
    context: {
      raw: `${toolName} issue`,
      metadata: {
        toolName,
      },
    },
  }
}
