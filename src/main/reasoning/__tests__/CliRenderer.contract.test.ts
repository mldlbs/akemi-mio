/**
 * CLI Renderer Contract Tests (P2)
 *
 * C-1: Same input -> same output (determinism)
 * C-2: Non-empty for reasonable report
 * C-3: Content coverage — output contains passRate, status, total
 * C-4: No-failures edge case — failed=0 -> no failures section
 * C-5: All-failures edge case — passed=0 still renders
 * C-6: Empty edge case — total=0 does not crash
 * C-7: Output contains box-drawing characters
 */
import { describe, it, expect } from 'vitest'
import { render } from '../golden/CliRenderer'
import { ReportGenerator } from '../golden/ReportGenerator'
import type { ReplayResult, ReplayFailure, ReasoningDirective } from '../golden/types'

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

describe('CLI Renderer Contract', () => {
  describe('C-1: Determinism', () => {
    it('same report produces identical CLI output', () => {
      const r = gen.generate(mockResult())
      expect(render(r)).toBe(render(r))
    })
  })

  describe('C-2: Non-empty', () => {
    it('reasonable report produces non-empty string', () => {
      const r = gen.generate(mockResult())
      expect(render(r).length).toBeGreaterThan(0)
    })
  })

  describe('C-3: Content coverage', () => {
    it('output contains pass rate', () => {
      const r = gen.generate(mockResult())
      const cli = render(r)
      expect(cli).toContain('95.45%')
    })

    it('output contains status', () => {
      const r = gen.generate(mockResult())
      const cli = render(r)
      expect(cli).toContain('FAIL')
    })

    it('output contains total', () => {
      const r = gen.generate(mockResult())
      const cli = render(r)
      expect(cli).toContain('44')
    })
  })

  describe('C-4: No-failures edge case', () => {
    it('failed=0 shows no regressions', () => {
      const r = gen.generate(mockResult({ failed: 0, failures: [] }))
      const cli = render(r)
      expect(cli).toContain('no regressions')
    })
  })

  describe('C-5: All-failures edge case', () => {
    it('passed=0 with failures still renders', () => {
      const r = gen.generate(mockResult({ passed: 0, failed: 44, failures: Array.from({ length: 44 }, (_, i) => mockFailure({ caseId: `Q${String(i + 1).padStart(2, '0')}` })) }))
      const cli = render(r)
      expect(cli.length).toBeGreaterThan(0)
      expect(cli).toContain('0')
    })
  })

  describe('C-6: Empty edge case', () => {
    it('total=0 does not crash', () => {
      const r = gen.generate(mockResult({ total: 0, passed: 0, failed: 0, skipped: 0, failures: [] }))
      const cli = render(r)
      expect(cli.length).toBeGreaterThan(0)
    })
  })

  describe('C-7: CLI structure', () => {
    it('output contains box-drawing characters', () => {
      const r = gen.generate(mockResult())
      const cli = render(r)
      expect(cli).toContain('╔')
      expect(cli).toContain('╗')
      expect(cli).toContain('╚')
      expect(cli).toContain('╝')
    })

    it('output contains capability markers', () => {
      const r = gen.generate(mockResult())
      const cli = render(r)
      expect(cli).toContain('✗')
    })
  })
})
