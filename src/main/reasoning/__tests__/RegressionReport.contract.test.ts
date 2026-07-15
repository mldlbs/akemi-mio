/**
 * Regression Report Contract Tests (ADR-007)
 *
 * Gate: All non-skip tests must pass for P1.3 acceptance.
 */
import { describe, it, expect } from 'vitest'
import { ReportGenerator } from '../golden/ReportGenerator'
import type {
  ReplayResult,
  ReplayFailure,
  CommitContext,
  ReasoningDirective,
} from '../golden/types'

const gen = new ReportGenerator()

function mockDirective(overrides?: Partial<ReasoningDirective>): ReasoningDirective {
  return { pattern: 'cause_effect', goals: ['g1'], constraints: [], outputStyle: 'json', ...overrides }
}

function mockFailure(overrides?: Partial<ReplayFailure>): ReplayFailure {
  return {
    caseId: 'Q01',
    expected: mockDirective(),
    actual: mockDirective({ pattern: 'hypothesis_verification' }),
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

describe('RegressionReport Contract', () => {
  describe('I-1: Determinism', () => {
    it('same input produces identical output', () => {
      const r = mockResult()
      expect(JSON.stringify(gen.generate(r))).toBe(JSON.stringify(gen.generate(r)))
    })
    it('two calls on same data yield deep-equal results', () => {
      expect(JSON.stringify(gen.generate(mockResult()))).toBe(JSON.stringify(gen.generate(mockResult())))
    })
  })

  describe('I-2: Immutability', () => {
    it('generate() does not mutate input ReplayResult', () => {
      const r = mockResult()
      const frozen = JSON.stringify(r)
      gen.generate(r)
      expect(JSON.stringify(r)).toBe(frozen)
    })
    it('generate() does not mutate failure entries', () => {
      const r = mockResult()
      const frozen = JSON.stringify(r.failures)
      gen.generate(r)
      expect(JSON.stringify(r.failures)).toBe(frozen)
    })
  })

  describe('I-5: Summary passRate formula', () => {
    it('passRate = passed / total', () => {
      expect(gen.generate(mockResult()).summary.passRate).toBe(42 / 44)
    })
    it('all pass → 1', () => expect(gen.generate(mockResult({ failed: 0, passed: 44 })).summary.passRate).toBe(1))
    it('all fail → 0', () => expect(gen.generate(mockResult({ passed: 0, failed: 44 })).summary.passRate).toBe(0))
    it('empty → 0', () => expect(gen.generate(mockResult({ total: 0, passed: 0, failed: 0, skipped: 0 })).summary.passRate).toBe(0))
  })

  describe('I-6: Status decision matrix', () => {
    it('pass when failed=0 and passed>0', () => expect(gen.generate(mockResult({ failed: 0, passed: 44 })).summary.status).toBe('pass'))
    it('fail when failed>0', () => expect(gen.generate(mockResult({ failed: 1, passed: 43 })).summary.status).toBe('fail'))
    it('inconclusive when passed+failed=0', () => expect(gen.generate(mockResult({ total: 0, passed: 0, failed: 0, skipped: 0 })).summary.status).toBe('inconclusive'))
  })

  describe('I-4: Trend is null in v0.1', () => {
    it('trend is null', () => expect(gen.generate(mockResult()).trend).toBeNull())
  })

  describe('I-7: Evidence count matches failures', () => {
    it('entries.length === regression.count', () => {
      const fs = [mockFailure({ caseId: 'A' }), mockFailure({ caseId: 'B' }), mockFailure({ caseId: 'C' })]
      const r = gen.generate(mockResult({ failed: 3, failures: fs }))
      expect(r.evidence.entries.length).toBe(r.regression.count)
    })
    it('each evidence caseId has a matching regression entry', () => {
      const r = gen.generate(mockResult())
      const regIds = new Set(r.regression.entries.map((e) => e.caseId))
      for (const ev of r.evidence.entries) expect(regIds.has(ev.caseId)).toBe(true)
    })
  })

  describe('I-8: Capability maps failures', () => {
    it('affectedCaseIds is subset of failure caseIds', () => {
      const r = gen.generate(mockResult())
      const allIds = new Set(r.regression.entries.map((e) => e.caseId))
      for (const cap of r.capability.regressed)
        for (const id of cap.affectedCaseIds)
          expect(allIds.has(id)).toBe(true)
    })
    it('entry per distinct pattern in failures', () => {
      const f1 = mockFailure({ caseId: 'A', expected: mockDirective({ pattern: 'cause_effect' }) })
      const f2 = mockFailure({ caseId: 'B', expected: mockDirective({ pattern: 'cause_effect' }) })
      const f3 = mockFailure({ caseId: 'C', expected: mockDirective({ pattern: 'hypothesis_verification' }) })
      const r = gen.generate(mockResult({ failures: [f1, f2, f3], failed: 3 }))
      expect(new Set(r.capability.regressed.map((c) => c.capability)).has('hypothesis_verification')).toBe(true)
    })
  })

  describe('I-10: Metadata integrity', () => {
    it('commit defaults to unknown', () => {
      const r = gen.generate(mockResult())
      expect(r.metadata.commit.sha).toBe('unknown')
      expect(r.metadata.commit.branch).toBe('unknown')
    })
    it('commit reflects injected context', () => {
      const ctx: CommitContext = { sha: 'abc123', branch: 'feat/test', dirty: false }
      const r = gen.generate(mockResult(), ctx)
      expect(r.metadata.commit.sha).toBe('abc123')
      expect(r.metadata.commit.branch).toBe('feat/test')
      expect(r.metadata.commit.dirty).toBe(false)
    })
  })

  describe('Schema version', () => {
    it('reportSchemaVersion is 0.1', () => expect(gen.generate(mockResult()).reportSchemaVersion).toBe('0.1'))
  })
})
