import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FEEDBACK_METRICS_CONFIG,
  parseFeedbackMetricsConfig,
  resolveFeedbackMetricsConfig,
  computeFeedbackGenerationMetrics,
} from '@akemi-mio/creativity/FeedbackMetrics'
import { conceptPairKey } from '@akemi-mio/creativity/types'
import type {
  ConceptPairWeight,
  DimensionEstimate,
  FeedbackSnapshot,
} from '@akemi-mio/creativity/FeedbackLearning'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

function est(posteriorMean: number, confidence = 1): DimensionEstimate {
  return { positiveCount: 0, negativeCount: 0, evidenceCount: 1, posteriorMean, confidence, lastEvidenceAt: NOW }
}

function pairWeight(pairKey: string, posMean: number, negMean = 0): ConceptPairWeight {
  const [a, b] = pairKey.split('|')
  return {
    conceptAId: a,
    conceptBId: b,
    pairKey,
    attribution: 'pair',
    selection: est(posMean),
    quality: est(posMean),
    landing: est(posMean),
    negative: est(negMean),
    lastEvidenceAt: NOW,
  }
}

function snapshotOf(pairs: ConceptPairWeight[]): FeedbackSnapshot {
  return {
    version: 'vtest',
    configHash: 'ctest',
    generatedAt: NOW,
    eventCount: 1,
    attributionCoverage: 1,
    duplicateApplicationRate: 0,
    dedupedEventCount: 0,
    pairs,
  }
}

const K_AB = conceptPairKey('origin:a', 'origin:b')
const K_CD = conceptPairKey('origin:c', 'origin:d')
const K_EF = conceptPairKey('origin:e', 'origin:f')
const K_HYP = 'hypothesis:h9'
const K_LABEL = conceptPairKey('name:x', 'name:y')

describe('FeedbackMetrics config (R6: parse + validate + fail-closed)', () => {
  it('parse returns null for missing/empty/non-object input so callers fall back to defaults', () => {
    expect(parseFeedbackMetricsConfig(null)).toBeNull()
    expect(parseFeedbackMetricsConfig(undefined)).toBeNull()
    expect(parseFeedbackMetricsConfig({})).toBeNull()
    expect(parseFeedbackMetricsConfig('x')).toBeNull()
  })

  it('parse clamps out-of-range and non-numeric values into safe bounds', () => {
    expect(parseFeedbackMetricsConfig({ precisionK: 0 })).toEqual({ precisionK: 1, windowDays: 30 })
    expect(parseFeedbackMetricsConfig({ precisionK: 99_999 })).toEqual({ precisionK: 1000, windowDays: 30 })
    expect(parseFeedbackMetricsConfig({ precisionK: '7' })).toEqual({ precisionK: 7, windowDays: 30 })
    expect(parseFeedbackMetricsConfig({ precisionK: 'abc' })).toEqual({ precisionK: 10, windowDays: 30 })
    expect(parseFeedbackMetricsConfig({ windowDays: 0.5 })).toEqual({ precisionK: 10, windowDays: 1 })
    expect(parseFeedbackMetricsConfig({ windowDays: 99_999 })).toEqual({ precisionK: 10, windowDays: 3650 })
    expect(parseFeedbackMetricsConfig({ windowDays: NaN })).toEqual({ precisionK: 10, windowDays: 30 })
  })

  it('resolve reads env vars and falls back to defaults when env is absent or invalid', () => {
    expect(resolveFeedbackMetricsConfig({})).toEqual(DEFAULT_FEEDBACK_METRICS_CONFIG)
    expect(resolveFeedbackMetricsConfig({ MIO_FEEDBACK_PRECISION_K: '3', MIO_FEEDBACK_WINDOW_DAYS: '7' })).toEqual({
      precisionK: 3,
      windowDays: 7,
    })
    expect(resolveFeedbackMetricsConfig({ MIO_FEEDBACK_PRECISION_K: 'nope' })).toEqual(DEFAULT_FEEDBACK_METRICS_CONFIG)
  })
})

describe('computeFeedbackGenerationMetrics — empty data means "no samples", not 0', () => {
  it('returns null rates for every metric on an empty world', () => {
    const m = computeFeedbackGenerationMetrics({ now: NOW })
    expect(m.pairPrecisionAtK).toBeNull()
    expect(m.noveltyAtK).toBeNull()
    expect(m.validationPassRate).toBeNull()
    expect(m.evaluatedPairs).toBe(0)
    expect(m.terminalHypotheses).toBe(0)
    expect(m.snapshotVersion).toBeNull()
    expect(m.ingestion).toEqual({ rawLines: 0, validRows: 0, droppedRows: 0, completeness: null })
    expect(m.topPairs).toEqual([])
    expect(m.precisionK).toBe(DEFAULT_FEEDBACK_METRICS_CONFIG.precisionK)
    expect(m.windowDays).toBe(DEFAULT_FEEDBACK_METRICS_CONFIG.windowDays)
  })

  it('pair precision stays null when top-K pairs have no terminal hypotheses (evaluated=0)', () => {
    const m = computeFeedbackGenerationMetrics({
      snapshot: snapshotOf([pairWeight(K_AB, 0.9)]),
      hypotheses: [{ id: 'h1', status: 'active', createdAt: NOW }],
      ingestion: { rawLines: 1, validRows: 1 },
      now: NOW,
    })
    expect(m.pairPrecisionAtK).toBeNull()
    expect(m.evaluatedPairs).toBe(0)
    expect(m.topPairs[0].precision).toBeNull()
  })
})

describe('pair precision@K / novelty@K ranking', () => {
  const config = { precisionK: 2, windowDays: 30 }

  it('ranks by |clampedAdjustment| desc, excludes hypothesis: keys, tie-breaks on pairKey', () => {
    const m = computeFeedbackGenerationMetrics({
      snapshot: snapshotOf([
        pairWeight(K_AB, 0.9), // |adj| = 0.8
        pairWeight(K_CD, 0.8), // |adj| = 0.6, tie with EF → key order decides
        pairWeight(K_EF, 0.8),
        pairWeight(K_HYP, 1.0), // largest adjustment but hypothesis_only → excluded
      ]),
      hypotheses: [
        { id: 'h_ab', status: 'validated', createdAt: NOW, provenance: { sources: [{ name: 'a', origin: 'origin:a' }, { name: 'b', origin: 'origin:b' }] } },
        { id: 'h_cd_ok', status: 'validated', createdAt: NOW, provenance: { sources: [{ name: 'c', origin: 'origin:c' }, { name: 'd', origin: 'origin:d' }] } },
        { id: 'h_cd_no', status: 'rejected', createdAt: NOW, provenance: { sources: [{ name: 'c', origin: 'origin:c' }, { name: 'd', origin: 'origin:d' }] } },
      ],
      ingestion: { rawLines: 3, validRows: 3 },
      config,
      now: NOW,
    })

    expect(m.topPairs.map((p) => p.pairKey)).toEqual([K_AB, K_CD])
    expect(m.topPairs[0].adjustment).toBeCloseTo(0.08, 6) // (0.9-0.5)*2 * lambdaClampPct 0.1
    expect(m.topPairs[0].precision).toBe(1) // h_ab validated
    expect(m.topPairs[1].precision).toBeCloseTo(0.5, 6) // 1 validated + 1 rejected
    expect(m.evaluatedPairs).toBe(2)
    expect(m.pairPrecisionAtK).toBeCloseTo(0.75, 6) // (1 + 0.5) / 2
    // windowed exploration: AB + CD both explored by terminal hypotheses, EF never
    expect(m.topPairs[0].novel).toBe(false)
    expect(m.topPairs[1].novel).toBe(false)
    expect(m.noveltyAtK).toBe(0)
    expect(m.ingestion).toEqual({ rawLines: 3, validRows: 3, droppedRows: 0, completeness: 1 })
    expect(m.snapshotVersion).toBe('vtest')
  })

  it('counts unexplored top-K pairs as novel and keeps precision over evaluated pairs only', () => {
    const m = computeFeedbackGenerationMetrics({
      snapshot: snapshotOf([pairWeight(K_AB, 0.9), pairWeight(K_CD, 0.8), pairWeight(K_EF, 0.8)]),
      hypotheses: [
        { id: 'h_ab', status: 'validated', createdAt: NOW, provenance: { sources: [{ name: 'a', origin: 'origin:a' }, { name: 'b', origin: 'origin:b' }] } },
        { id: 'h_cd_ok', status: 'validated', createdAt: NOW, provenance: { sources: [{ name: 'c', origin: 'origin:c' }, { name: 'd', origin: 'origin:d' }] } },
        { id: 'h_cd_no', status: 'rejected', createdAt: NOW, provenance: { sources: [{ name: 'c', origin: 'origin:c' }, { name: 'd', origin: 'origin:d' }] } },
      ],
      config: { precisionK: 10, windowDays: 30 },
      now: NOW,
    })
    // topPairs = all three; EF has no terminal → precision null, not counted
    expect(m.topPairs).toHaveLength(3)
    expect(m.evaluatedPairs).toBe(2)
    expect(m.pairPrecisionAtK).toBeCloseTo(0.75, 6)
    // only EF is unexplored → novelty 1/3
    expect(m.noveltyAtK).toBeCloseTo(1 / 3, 6)
  })

  it('links generate-shaped provenance (name: origin fallback) to snapshot pairs so precision@K is sampled', () => {
    // P3-R5（task 0946ba33）：creativity generate 落库的 provenance 用
    // sourceConceptId 同一身份规则——origin 缺失回退 name:<name>。
    const key = conceptPairKey('name:auth', 'name:cache')
    const m = computeFeedbackGenerationMetrics({
      snapshot: snapshotOf([pairWeight(key, 0.9)]),
      hypotheses: [
        {
          id: 'h_gen',
          status: 'validated',
          createdAt: NOW,
          provenance: {
            strategy: 'explore',
            sources: [
              { name: 'auth', type: 'knowledge', origin: 'name:auth' },
              { name: 'cache', type: 'knowledge', origin: 'name:cache' },
            ],
          },
        },
      ],
      ingestion: { rawLines: 1, validRows: 1 },
      config: { precisionK: 10, windowDays: 30 },
      now: NOW,
    })
    expect(m.pairPrecisionAtK).toBe(1)
    expect(m.evaluatedPairs).toBe(1)
    expect(m.validationPassRate).toBe(1)
    expect(m.topPairs[0].pairKey).toBe(key)
    expect(m.topPairs[0].novel).toBe(false)
  })

  it('hypothesis_only pairs never enter top-K even when they carry the largest adjustment', () => {
    const m = computeFeedbackGenerationMetrics({
      snapshot: snapshotOf([pairWeight('hypothesis:only', 1.0)]),
      config: { precisionK: 10, windowDays: 30 },
      now: NOW,
    })
    expect(m.topPairs).toEqual([])
    expect(m.pairPrecisionAtK).toBeNull()
    expect(m.noveltyAtK).toBeNull()
  })
})

describe('validation pass rate + exploration window', () => {
  it('is windowed: terminal hypotheses older than windowDays are excluded', () => {
    const m = computeFeedbackGenerationMetrics({
      hypotheses: [
        { id: 'h1', status: 'validated', createdAt: NOW },
        { id: 'h2', status: 'rejected', createdAt: NOW },
        { id: 'h3', status: 'validated', createdAt: NOW - 40 * DAY }, // outside 30d
        { id: 'h4', status: 'active', createdAt: NOW },
        { id: 'h5', status: 'validated' }, // no createdAt → excluded
      ],
      config: { precisionK: 10, windowDays: 30 },
      now: NOW,
    })
    expect(m.validationPassRate).toBeCloseTo(0.5, 6) // 1 validated / 2 terminal
    expect(m.terminalHypotheses).toBe(2)
  })

  it('is null when the window contains no terminal hypotheses at all', () => {
    const m = computeFeedbackGenerationMetrics({
      hypotheses: [{ id: 'h1', status: 'validated', createdAt: NOW - 40 * DAY }],
      config: { precisionK: 10, windowDays: 30 },
      now: NOW,
    })
    expect(m.validationPassRate).toBeNull()
    expect(m.terminalHypotheses).toBe(0)
  })

  it('exploration set falls back to sourceLabels (no-provenance hypotheses) in the name: space', () => {
    const m = computeFeedbackGenerationMetrics({
      snapshot: snapshotOf([pairWeight(K_LABEL, 0.9), pairWeight(K_AB, 0.8)]),
      hypotheses: [
        { id: 'h_labels', status: 'draft', createdAt: NOW, sourceLabels: ['x', 'y'] },
        { id: 'h_old', status: 'draft', createdAt: NOW - 40 * DAY, provenance: { sources: [{ name: 'a', origin: 'origin:a' }, { name: 'b', origin: 'origin:b' }] } },
      ],
      config: { precisionK: 10, windowDays: 30 },
      now: NOW,
    })
    const byKey = Object.fromEntries(m.topPairs.map((p) => [p.pairKey, p.novel]))
    expect(byKey[K_LABEL]).toBe(false) // explored via sourceLabels within window
    expect(byKey[K_AB]).toBe(true) // provenance exists but outside the window
  })
})

describe('event ingestion completeness', () => {
  it('reports dropped rows and a bounded ratio when the raw file has content', () => {
    const m = computeFeedbackGenerationMetrics({ ingestion: { rawLines: 5, validRows: 4 }, now: NOW })
    expect(m.ingestion).toEqual({ rawLines: 5, validRows: 4, droppedRows: 1, completeness: 0.8 })
  })

  it('completeness is null (no samples), not 1, when there are zero raw lines', () => {
    const m = computeFeedbackGenerationMetrics({ ingestion: { rawLines: 0, validRows: 0 }, now: NOW })
    expect(m.ingestion.completeness).toBeNull()
    expect(m.ingestion.droppedRows).toBe(0)
  })
})
