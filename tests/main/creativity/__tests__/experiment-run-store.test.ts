import { describe, expect, it } from 'vitest'
import {
  parseStoppingRule,
  evaluateStoppingRule,
  checkPromotionGate,
  assignExperimentMode,
  routeExperimentMemoryPath,
  isExperimentMode,
  DEFAULT_STOPPING_RULE,
} from '@akemi-mio/creativity/ExperimentRunStore'
import type { ExperimentRun, StoppingRuleConfig } from '@akemi-mio/creativity/ExperimentRunStore'

function makeRun(overrides: Partial<ExperimentRun> = {}): ExperimentRun {
  return {
    id: `run_${Math.random().toString(36).slice(2, 8)}`,
    assignment: 'candidate',
    outcome: 'success',
    metrics: {},
    evidenceIds: [],
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('ExperimentRunStore — parseStoppingRule (R6)', () => {
  it('parses valid config', () => {
    const c = parseStoppingRule({ minSamples: 5, maxSamples: 100, minSuccessRate: 0.8 })
    expect(c).toEqual({ minSamples: 5, maxSamples: 100, minSuccessRate: 0.8 })
  })

  it('rejects null / non-object', () => {
    expect(parseStoppingRule(null)).toBeNull()
    expect(parseStoppingRule('foo')).toBeNull()
    expect(parseStoppingRule(42)).toBeNull()
  })

  it('rejects missing / invalid minSamples', () => {
    expect(parseStoppingRule({})).toBeNull()
    expect(parseStoppingRule({ minSamples: 0 })).toBeNull()
    expect(parseStoppingRule({ minSamples: -1 })).toBeNull()
    expect(parseStoppingRule({ minSamples: '30' })).toBeNull()
    expect(parseStoppingRule({ minSamples: NaN })).toBeNull()
  })

  it('ignores unknown fields', () => {
    const c = parseStoppingRule({ minSamples: 5, foo: 'bar' })
    expect(c).toEqual({ minSamples: 5 })
  })

  it('default is minSamples=30', () => {
    expect(DEFAULT_STOPPING_RULE.minSamples).toBe(30)
  })
})

describe('ExperimentRunStore — evaluateStoppingRule', () => {
  const config: StoppingRuleConfig = { minSamples: 5 }

  it('n < minSamples → inconclusive, shouldStop=false', () => {
    const runs = [makeRun(), makeRun(), makeRun()] // n=3 < 5
    const d = evaluateStoppingRule(config, runs)
    expect(d.shouldStop).toBe(false)
    expect(d.recommended).toBeNull()
    expect(d.reason).toBe('below_min_samples')
  })

  it('n >= minSamples, no thresholds → continue', () => {
    const runs = Array.from({ length: 5 }, () => makeRun())
    const d = evaluateStoppingRule(config, runs)
    expect(d.shouldStop).toBe(false)
    expect(d.reason).toBe('continue')
  })

  it('failure rate exceeds maxFailureRate → stop + failure', () => {
    const cfg: StoppingRuleConfig = { minSamples: 5, maxFailureRate: 0.3 }
    const runs = [
      makeRun({ outcome: 'failure' }),
      makeRun({ outcome: 'failure' }),
      makeRun({ outcome: 'failure' }),
      makeRun({ outcome: 'success' }),
      makeRun({ outcome: 'success' }),
    ]
    const d = evaluateStoppingRule(cfg, runs)
    expect(d.shouldStop).toBe(true)
    expect(d.recommended).toBe('failure')
    expect(d.reason).toBe('failure_rate_exceeded')
  })

  it('success rate meets minSuccessRate → stop + success', () => {
    const cfg: StoppingRuleConfig = { minSamples: 4, minSuccessRate: 0.75 }
    const runs = [
      makeRun({ outcome: 'success' }),
      makeRun({ outcome: 'success' }),
      makeRun({ outcome: 'success' }),
      makeRun({ outcome: 'failure' }),
    ]
    const d = evaluateStoppingRule(cfg, runs)
    expect(d.shouldStop).toBe(true)
    expect(d.recommended).toBe('success')
    expect(d.reason).toBe('success_rate_met')
  })

  it('maxSamples reached → stop', () => {
    const cfg: StoppingRuleConfig = { minSamples: 3, maxSamples: 3 }
    const runs = [makeRun(), makeRun(), makeRun()]
    const d = evaluateStoppingRule(cfg, runs)
    expect(d.shouldStop).toBe(true)
    expect(d.reason).toBe('max_samples')
  })
})

describe('ExperimentRunStore — checkPromotionGate (A3+A4)', () => {
  const config: StoppingRuleConfig = { minSamples: 5 }

  it('n < minSamples → deny (A3)', () => {
    const runs = [makeRun(), makeRun()]
    const g = checkPromotionGate(config, runs)
    expect(g.allowed).toBe(false)
    expect(g.reason).toBe('below_min_samples')
  })

  it('stale run → deny (A4)', () => {
    const runs = Array.from({ length: 5 }, () => makeRun({ stale: true }))
    const g = checkPromotionGate(config, runs)
    expect(g.allowed).toBe(false)
    expect(g.reason).toBe('stale_snapshot')
  })

  it('snapshot mismatch → deny (A4)', () => {
    const runs = Array.from({ length: 5 }, () => makeRun({ baseSnapshotId: 'snap_old' }))
    const g = checkPromotionGate(config, runs, 'snap_current')
    expect(g.allowed).toBe(false)
    expect(g.reason).toBe('snapshot_mismatch')
  })

  it('all match + n >= minSamples → allow', () => {
    const runs = Array.from({ length: 5 }, () => makeRun({ baseSnapshotId: 'snap_a' }))
    const g = checkPromotionGate(config, runs, 'snap_a')
    expect(g.allowed).toBe(true)
    expect(g.reason).toBe('ok')
  })
})

describe('ExperimentRunStore — assignExperimentMode', () => {
  it('baseline only → baseline', () => {
    expect(assignExperimentMode({ baselineId: 'b' }).assignment).toBe('baseline')
  })

  it('candidate + baseline → candidate', () => {
    expect(assignExperimentMode({ candidateId: 'c', baselineId: 'b' }).assignment).toBe('candidate')
  })

  it('ablation + both sides → ablation', () => {
    expect(assignExperimentMode({ candidateId: 'c', baselineId: 'b', ablationId: 'a' }).assignment).toBe('ablation')
  })

  it('ablation missing side → inconclusive', () => {
    const r = assignExperimentMode({ ablationId: 'a' })
    expect(r.assignment).toBe('ablation')
    expect(r.reason).toBe('inconclusive_missing_side')
  })
})

describe('ExperimentRunStore — Memory 机制性隔离 (A1)', () => {
  it('routes experiment memory path', () => {
    expect(routeExperimentMemoryPath('/data/memory.jsonl', true)).toBe('/data/experiment-memory.jsonl')
    expect(routeExperimentMemoryPath('/data/memory.jsonl', false)).toBe('/data/memory.jsonl')
  })

  it('detects MIO_EXPERIMENT flag', () => {
    expect(isExperimentMode({ MIO_EXPERIMENT: '1' })).toBe(true)
    expect(isExperimentMode({ MIO_EXPERIMENT: 'true' })).toBe(true)
    expect(isExperimentMode({})).toBe(false)
  })
})
