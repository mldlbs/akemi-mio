/**
 * Regression Report Contract Tests (ADR-007)
 *
 * These tests freeze the RegressionReport contract BEFORE the ReportGenerator
 * is implemented. Structural invariants are tested with manually constructed data;
 * Generator-specific tests are skeletons that will be activated in P1.3.
 *
 * Gate: P1.3 may only start when all non-skipped tests in this file pass.
 */
import { describe, it, expect } from 'vitest'
import type {
  ReplayResult,
  ReplayFailure,
  CommitContext,
  RegressionReport,
  SummarySection,
  CapabilitySection,
  RegressionSection,
  EvidenceSection,
  TrendSection,
  MetadataSection,
} from '../golden/types'

// ── Test helpers ──

function mockFailure(overrides?: Partial<ReplayFailure>): ReplayFailure {
  return {
    caseId: 'Q01',
    expected: { pattern: 'cause_effect', goals: ['g1'], constraints: [], outputStyle: 'json' },
    actual: { pattern: 'hypothesis_verification', goals: ['g1'], constraints: [], outputStyle: 'json' },
    diff: 'p: cause_effect vs hypothesis_verification',
    ...overrides,
  }
}

function mockResult(overrides?: Partial<ReplayResult>): ReplayResult {
  return {
    total: 44,
    passed: 42,
    failed: 2,
    skipped: 0,
    durationMs: 1523,
    failures: [mockFailure({ caseId: 'Q01' }), mockFailure({ caseId: 'Q02' })],
    runnerVersion: '0.1',
    executedAt: '2026-07-15T19:00:00.000Z',
    ...overrides,
  }
}

function buildReport(result: ReplayResult, commit?: CommitContext): RegressionReport {
  // Manual construction — mirrors what the future ReportGenerator will produce
  const failed = result.failed
  const passed = result.passed
  const total = result.total
  const passRate = total > 0 ? passed / total : 0

  const status: SummarySection['status'] =
    failed > 0 ? 'fail' : passed > 0 ? 'pass' : 'inconclusive'

  const summary: SummarySection = {
    total,
    passed,
    failed,
    skipped: result.skipped,
    durationMs: result.durationMs,
    passRate,
    status,
  }

  // Group failures by pattern for capability section
  const capMap = new Map<string, { failedCount: number; totalCount: number; ids: string[] }>()
  for (const f of result.failures) {
    const pat = f.expected.pattern || 'unknown'
    const e = capMap.get(pat) || { failedCount: 0, totalCount: 0, ids: [] }
    e.failedCount++
    e.totalCount++
    e.ids.push(f.caseId)
    capMap.set(pat, e)
  }

  const capability: CapabilitySection = {
    regressed: [...capMap.entries()].map(([cap, d]) => ({
      capability: cap,
      failedCount: d.failedCount,
      totalCount: d.totalCount,
      affectedCaseIds: d.ids,
    })),
    intact: [],
  }

  const regression: RegressionSection = {
    count: result.failures.length,
    entries: result.failures.map((f) => {
      const ep = f.expected.pattern
      const ap = f.actual.pattern
      return {
        caseId: f.caseId,
        category: 'analysis',
        diffSummary: f.diff,
        fieldDiff: {
          patternChanged: ep !== ap,
          expectedPattern: ep,
          actualPattern: ap,
          goalsChanged: JSON.stringify(f.expected.goals) !== JSON.stringify(f.actual.goals),
          constraintsChanged: JSON.stringify(f.expected.constraints) !== JSON.stringify(f.actual.constraints),
          outputStyleChanged: f.expected.outputStyle !== f.actual.outputStyle,
        },
      }
    }),
  }

  const evidence: EvidenceSection = {
    entries: result.failures.map((f) => ({
      caseId: f.caseId,
      category: 'analysis',
      inputText: 'benchmark input text',
      expected: f.expected,
      actual: f.actual,
      diff: f.diff,
    })),
  }

  const metadata: MetadataSection = {
    runnerVersion: result.runnerVersion,
    reportSchemaVersion: '0.1',
    goldenVersion: '0.1',
    goldenSchemaVersion: '0.1',
    datasetInfo: { totalCases: total, categories: { analysis: 12, decision: 12, planning: 10, creation: 10 } },
    commit: { sha: commit?.sha || 'unknown', branch: commit?.branch || 'unknown', dirty: commit?.dirty ?? false },
    executedAt: result.executedAt,
  }

  return {
    reportSchemaVersion: '0.1',
    summary,
    capability,
    regression,
    evidence,
    trend: null,
    metadata,
  }
}

// ── Tests ──

describe('RegressionReport Contract', () => {
  describe('I-1: Summary integrity', () => {
    it('passRate = passed / total', () => {
      const r = buildReport(mockResult())
      expect(r.summary.passRate).toBe(r.summary.passed / r.summary.total)
    })

    it('passRate is 0.0–1.0 range', () => {
      const allPass = buildReport(mockResult({ failed: 0, passed: 44 }))
      expect(allPass.summary.passRate).toBe(1)

      const allFail = buildReport(mockResult({ passed: 0, failed: 44 }))
      expect(allFail.summary.passRate).toBe(0)

      const none = buildReport(mockResult({ total: 0, passed: 0, failed: 0, skipped: 0 }))
      expect(none.summary.passRate).toBe(0)
    })
  })

  describe('I-2: Status decision matrix', () => {
    it('pass when failed === 0 and passed > 0', () => {
      const r = buildReport(mockResult({ failed: 0, passed: 44 }))
      expect(r.summary.status).toBe('pass')
    })

    it('fail when failed > 0', () => {
      const r = buildReport(mockResult({ failed: 1, passed: 43 }))
      expect(r.summary.status).toBe('fail')
    })

    it('inconclusive when passed + failed === 0', () => {
      const r = buildReport(mockResult({ total: 0, passed: 0, failed: 0, skipped: 0 }))
      expect(r.summary.status).toBe('inconclusive')
    })
  })

  describe('I-3: Trend is null in v0.1', () => {
    it('trend field is null', () => {
      const r = buildReport(mockResult())
      expect(r.trend).toBeNull()
    })
  })

  describe('I-4: Evidence count matches failures', () => {
    it('evidence.entries.length === regression.entries.length', () => {
      const r = buildReport(mockResult({ failed: 3 }))
      expect(r.evidence.entries.length).toBe(r.regression.count)
    })

    it('each evidence entry has a matching regression entry by caseId', () => {
      const r = buildReport(mockResult())
      const regCaseIds = new Set(r.regression.entries.map((e) => e.caseId))
      for (const ev of r.evidence.entries) {
        expect(regCaseIds.has(ev.caseId)).toBe(true)
      }
    })
  })

  describe('I-5: Capability maps failures', () => {
    it('affectedCaseIds is subset of total failures', () => {
      const r = buildReport(mockResult())
      const allFailedIds = new Set(r.regression.entries.map((e) => e.caseId))
      for (const cap of r.capability.regressed) {
        for (const id of cap.affectedCaseIds) {
          expect(allFailedIds.has(id)).toBe(true)
        }
      }
    })

    it('capability entry exists for each distinct pattern in failures', () => {
      const f1 = mockFailure({ caseId: 'A', expected: { pattern: 'cause_effect', goals: [], constraints: [], outputStyle: 'text' } })
      const f2 = mockFailure({ caseId: 'B', expected: { pattern: 'cause_effect', goals: [], constraints: [], outputStyle: 'text' } })
      const f3 = mockFailure({ caseId: 'C', expected: { pattern: 'hypothesis_verification', goals: [], constraints: [], outputStyle: 'text' } })
      const r = buildReport(mockResult({ failures: [f1, f2, f3], failed: 3 }))
      const patterns = new Set(r.capability.regressed.map((c) => c.capability))
      expect(patterns.has('cause_effect')).toBe(true)
      expect(patterns.has('hypothesis_verification')).toBe(true)
    })
  })

  describe('I-6: Metadata integrity', () => {
    it('commit defaults to unknown when not provided', () => {
      const r = buildReport(mockResult())
      expect(r.metadata.commit.sha).toBe('unknown')
      expect(r.metadata.commit.branch).toBe('unknown')
    })

    it('commit reflects injected context', () => {
      const ctx: CommitContext = { sha: 'abc123', branch: 'feat/test', dirty: false }
      const r = buildReport(mockResult(), ctx)
      expect(r.metadata.commit.sha).toBe('abc123')
      expect(r.metadata.commit.branch).toBe('feat/test')
      expect(r.metadata.commit.dirty).toBe(false)
    })
  })

  describe('I-7: ReportGenerator is pure (P1.3 gate)', () => {
    it.skip('same ReplayResult produces identical RegressionReport', () => {
      // P1.3: activate when ReportGenerator is implemented
      const result = mockResult()
      expect(true).toBe(true) // placeholder
    })

    it.skip('generate() does not mutate input ReplayResult', () => {
      // P1.3: activate when ReportGenerator is implemented
      const result = mockResult()
      const frozen = JSON.stringify(result)
      expect(JSON.stringify(result)).toBe(frozen) // placeholder
    })
  })

  describe('Schema version', () => {
    it('reportSchemaVersion is 0.1', () => {
      const r = buildReport(mockResult())
      expect(r.reportSchemaVersion).toBe('0.1')
    })
  })
})
