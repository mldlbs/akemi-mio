/**
 * JSON Renderer Contract Tests (P1.4.1)
 *
 * J-1: Same input → same output (determinism)
 * J-2: JSON.parse(render(r)) round-trips to identical RegressionReport
 * J-3: Renderer does not mutate input
 * J-4: Output contains only Contract fields, no derived fields
 * J-5: Field order is canonical (consistent JSON key ordering)
 */
import { describe, it, expect } from 'vitest'
import { render } from '@akemi-mio/reasoning/golden/JsonRenderer'
import { ReportGenerator } from '@akemi-mio/reasoning/golden/ReportGenerator'
import type { ReplayResult, ReplayFailure, ReasoningDirective, RegressionReport } from '@akemi-mio/reasoning/golden/types'

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

describe('JSON Renderer Contract', () => {
  describe('J-1: Determinism', () => {
    it('same report produces identical JSON output', () => {
      const r = gen.generate(mockResult())
      expect(render(r)).toBe(render(r))
    })
  })

  describe('J-2: Round-trip recovery', () => {
    it('JSON.parse(render(r)) recovers all top-level fields', () => {
      const r = gen.generate(mockResult())
      const parsed: RegressionReport = JSON.parse(render(r))
      expect(parsed.reportSchemaVersion).toBe(r.reportSchemaVersion)
      expect(parsed.summary.passed).toBe(r.summary.passed)
      expect(parsed.summary.failed).toBe(r.summary.failed)
      expect(parsed.capability.regressed.length).toBe(r.capability.regressed.length)
      expect(parsed.regression.count).toBe(r.regression.count)
      expect(parsed.evidence.entries.length).toBe(r.evidence.entries.length)
      expect(parsed.trend).toBeNull()
      expect(parsed.metadata.runnerVersion).toBe(r.metadata.runnerVersion)
    })

    it('round-trip preserves nested object structure', () => {
      const r = gen.generate(
        mockResult({ failed: 3, failures: [mockFailure({ caseId: 'A' }), mockFailure({ caseId: 'B' }), mockFailure({ caseId: 'C' })] }),
      )
      const parsed: RegressionReport = JSON.parse(render(r))
      expect(parsed.regression.entries.length).toBe(3)
      expect(parsed.regression.entries[0].caseId).toBe('A')
      expect(parsed.regression.entries[0].fieldDiff.patternChanged).toBe(true)
      expect(parsed.regression.entries[0].fieldDiff.expectedPattern).toBe('cause_effect')
      expect(parsed.regression.entries[1].caseId).toBe('B')
      expect(parsed.regression.entries[2].caseId).toBe('C')
    })
  })

  describe('J-3: Immutability', () => {
    it('render() does not mutate input RegressionReport', () => {
      const r = gen.generate(mockResult())
      const frozen = JSON.stringify(r)
      render(r)
      expect(JSON.stringify(r)).toBe(frozen)
    })
  })

  describe('J-4: No derived fields', () => {
    it('output contains no extra top-level fields beyond Contract', () => {
      const r = gen.generate(mockResult())
      const parsed = JSON.parse(render(r))
      const topKeys = new Set(Object.keys(parsed))
      expect(topKeys.size).toBe(7)
      expect(topKeys.has('reportSchemaVersion')).toBe(true)
      expect(topKeys.has('summary')).toBe(true)
      expect(topKeys.has('capability')).toBe(true)
      expect(topKeys.has('regression')).toBe(true)
      expect(topKeys.has('evidence')).toBe(true)
      expect(topKeys.has('trend')).toBe(true)
      expect(topKeys.has('metadata')).toBe(true)
    })

    it('summary contains only the 7 Contract fields', () => {
      const r = gen.generate(mockResult())
      const parsed: RegressionReport = JSON.parse(render(r))
      const summaryKeys = new Set(Object.keys(parsed.summary))
      expect(summaryKeys.size).toBe(7)
      expect(summaryKeys.has('total')).toBe(true)
      expect(summaryKeys.has('passed')).toBe(true)
      expect(summaryKeys.has('failed')).toBe(true)
      expect(summaryKeys.has('skipped')).toBe(true)
      expect(summaryKeys.has('durationMs')).toBe(true)
      expect(summaryKeys.has('passRate')).toBe(true)
      expect(summaryKeys.has('status')).toBe(true)
    })
  })

  describe('J-5: Canonical JSON field order', () => {
    it('same object always produces byte-identical output', () => {
      const r = gen.generate(mockResult())
      const s1 = render(r)
      const s2 = render(r)
      expect(s1).toBe(s2)
    })

    it('two deep-equal reports produce canonical-identical output', () => {
      const r1 = gen.generate(mockResult())
      const r2 = gen.generate(mockResult())
      expect(render(r1)).toBe(render(r2))
    })
  })
})
