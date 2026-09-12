/**
 * Markdown Renderer Contract Tests (P2)
 *
 * M-1: Same input -> same output (determinism)
 * M-2: Non-empty for reasonable report
 * M-3: Content coverage — output contains passRate, status, total
 * M-4: No-failures edge case — failed=0 -> no failures section
 * M-5: All-failures edge case — passed=0 still renders
 * M-6: Empty edge case — total=0 does not crash
 * M-7: Output contains Markdown structure markers (#, |, ---)
 */
import { describe, it, expect } from 'vitest'
import { render } from '@akemi-mio/reasoning/golden/MarkdownRenderer'
import { ReportGenerator } from '@akemi-mio/reasoning/golden/ReportGenerator'
import type { ReplayResult, ReplayFailure, ReasoningDirective } from '@akemi-mio/reasoning/golden/types'

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

describe('Markdown Renderer Contract', () => {
  describe('M-1: Determinism', () => {
    it('same report produces identical Markdown output', () => {
      const r = gen.generate(mockResult())
      expect(render(r)).toBe(render(r))
    })
  })

  describe('M-2: Non-empty', () => {
    it('reasonable report produces non-empty string', () => {
      const r = gen.generate(mockResult())
      expect(render(r).length).toBeGreaterThan(0)
    })
  })

  describe('M-3: Content coverage', () => {
    it('output contains pass rate', () => {
      const r = gen.generate(mockResult())
      const md = render(r)
      expect(md).toContain('95.45%')
    })

    it('output contains status', () => {
      const r = gen.generate(mockResult())
      const md = render(r)
      expect(md).toContain('Fail')
    })

    it('output contains total', () => {
      const r = gen.generate(mockResult())
      const md = render(r)
      expect(md).toContain('44')
    })
  })

  describe('M-4: No-failures edge case', () => {
    it('failed=0 produces no regression section', () => {
      const r = gen.generate(mockResult({ failed: 0, failures: [] }))
      const md = render(r)
      expect(md).toContain('No regressions')
    })
  })

  describe('M-5: All-failures edge case', () => {
    it('passed=0 with failures still renders', () => {
      const r = gen.generate(
        mockResult({
          passed: 0,
          failed: 44,
          failures: Array.from({ length: 44 }, (_, i) => mockFailure({ caseId: `Q${String(i + 1).padStart(2, '0')}` })),
        }),
      )
      const md = render(r)
      expect(md.length).toBeGreaterThan(0)
      expect(md).toContain('0')
    })
  })

  describe('M-6: Empty edge case', () => {
    it('total=0 does not crash', () => {
      const r = gen.generate(mockResult({ total: 0, passed: 0, failed: 0, skipped: 0, failures: [] }))
      const md = render(r)
      expect(md.length).toBeGreaterThan(0)
    })
  })

  describe('M-7: Markdown structure', () => {
    it('output contains H1 title', () => {
      const r = gen.generate(mockResult())
      expect(render(r)).toContain('# Regression Report')
    })

    it('output contains table separators', () => {
      const r = gen.generate(mockResult())
      const md = render(r)
      expect(md).toContain('|')
      expect(md).toContain('---')
    })

    it('output contains section headings', () => {
      const r = gen.generate(mockResult())
      const md = render(r)
      expect(md).toContain('## Summary')
      expect(md).toContain('## Capability Impact')
      expect(md).toContain('## Regression Details')
      expect(md).toContain('## Evidence')
    })
  })
})
