import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FEEDBACK_LEARNING_CONFIG,
  aggregateConceptPairWeights,
  buildFeedbackSnapshot,
  pairKeyOf,
  replayFeedbackAdjustment,
  timeDecay,
  type ConceptPairWeight,
  type FeedbackLearningConfig,
  type HypothesisProvenanceLike,
} from '@akemi-mio/creativity/FeedbackLearning'
import type { HypothesisFeedbackEvent } from '@akemi-mio/creativity/FeedbackEvents'
import { FeedbackLearningService } from '@akemi-mio/creativity'

const H = 86_400_000
const NOW = 1_800_000_000_000

function event(over: Partial<HypothesisFeedbackEvent> & Pick<HypothesisFeedbackEvent, 'hypothesisId' | 'eventType'>): HypothesisFeedbackEvent {
  return {
    id: over.id ?? `fbe_${Math.random().toString(36).slice(2)}`,
    sourceType: over.sourceType ?? 'experiment',
    sourceId: over.sourceId ?? 's1',
    occurredAt: over.occurredAt ?? NOW,
    ingestedAt: over.ingestedAt ?? NOW,
    idempotencyKey: over.idempotencyKey ?? `k:${over.hypothesisId}:${over.eventType}:${over.sourceId ?? 's1'}`,
    schemaVersion: 1,
    ...over,
  }
}

function hypotheses(...pairs: Array<[string, string]>): Record<string, HypothesisProvenanceLike | undefined> {
  const map: Record<string, HypothesisProvenanceLike | undefined> = {}
  for (const [id, ...origins] of pairs) {
    map[id] = { sources: origins.map((origin, i) => ({ name: `n${i}`, type: 'knowledge', origin })) }
  }
  return map
}

describe('timeDecay', () => {
  it('half-life is exact and never amplifies future events', () => {
    expect(timeDecay(NOW - 30 * H, NOW, 30)).toBeCloseTo(0.5, 6)
    expect(timeDecay(NOW - 60 * H, NOW, 30)).toBeCloseTo(0.25, 6)
    expect(timeDecay(NOW + 10 * H, NOW, 30)).toBe(1)
    expect(timeDecay(NOW, NOW, 30)).toBe(1)
  })
})

describe('aggregateConceptPairWeights', () => {
  it('dedups same-batch evidence so duplicates do not inflate counts (Duplicate Application Rate = 0)', () => {
    const events = [
      event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1', occurredAt: NOW }),
      event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's2', occurredAt: NOW }),
      event({ hypothesisId: 'h1', eventType: 'adopted', sourceId: 's3', occurredAt: NOW }),
    ]
    const result = aggregateConceptPairWeights(events, hypotheses(['h1', 'origin:a', 'origin:b']), undefined, NOW)
    expect(result.duplicateApplicationRate).toBe(0)
    // h1 has one batch (hypothesisId) → 去重后 quality 只计一次；evidenceCount 保留原始可追溯条数
    const pair = result.pairs.find((p) => p.pairKey === pairKeyOf('origin:a', 'origin:b'))!
    expect(pair.quality.evidenceCount).toBe(2)
    expect(pair.selection.evidenceCount).toBe(1)
    expect(pair.quality.positiveCount).toBeCloseTo(DEFAULT_FEEDBACK_LEARNING_CONFIG.weightCaps.validated, 6)
    expect(result.dedupedEventCount).toBe(1)
  })

  it('treats the same commitSha as a single landing sample', () => {
    const events = [
      event({ hypothesisId: 'h1', eventType: 'implemented', sourceId: 'c1', commitSha: 'abc', occurredAt: NOW }),
      event({ hypothesisId: 'h1', eventType: 'implemented', sourceId: 'c2', commitSha: 'abc', occurredAt: NOW }),
    ]
    const result = aggregateConceptPairWeights(events, hypotheses(['h1', 'origin:a', 'origin:b']), undefined, NOW)
    expect(result.duplicateApplicationRate).toBe(0)
    const pair = result.pairs[0]
    expect(pair.landing.positiveCount).toBeCloseTo(DEFAULT_FEEDBACK_LEARNING_CONFIG.weightCaps.implemented, 6)
  })

  it('keeps the three dimensions separate instead of merging into a success count', () => {
    const events = [
      event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1', occurredAt: NOW }),
      event({ hypothesisId: 'h1', eventType: 'adopted', sourceId: 's2', occurredAt: NOW }),
      event({ hypothesisId: 'h1', eventType: 'implemented', sourceId: 's3', commitSha: 'c', occurredAt: NOW }),
    ]
    const result = aggregateConceptPairWeights(events, hypotheses(['h1', 'origin:a', 'origin:b']), undefined, NOW)
    const pair = result.pairs[0]
    expect(pair.quality.positiveCount).toBeGreaterThan(0)
    expect(pair.selection.positiveCount).toBeGreaterThan(0)
    expect(pair.landing.positiveCount).toBeGreaterThan(0)
    // 不跨维度：各维度计数独立，无合并的"成功次数"
    expect(pair.quality.positiveCount).not.toBeCloseTo(pair.selection.positiveCount, 6)
  })

  it('falls back to the prior mean on a dimension with no evidence', () => {
    const events = [event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1', occurredAt: NOW })]
    const result = aggregateConceptPairWeights(events, hypotheses(['h1', 'origin:a', 'origin:b']), undefined, NOW)
    const pair = result.pairs[0]
    expect(pair.quality.posteriorMean).toBeCloseTo(1.5 / 2.5, 6) // (1+0.5)/(1+1+0.5)
    expect(pair.selection.posteriorMean).toBeCloseTo(0.5, 6)
    expect(pair.landing.posteriorMean).toBeCloseTo(0.5, 6)
  })

  it('records hypothesis_only when provenance is missing and lowers attribution coverage', () => {
    const events = [event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1', occurredAt: NOW })]
    const result = aggregateConceptPairWeights(events, { h1: undefined }, undefined, NOW)
    expect(result.pairs[0].attribution).toBe('hypothesis_only')
    expect(result.pairs[0].pairKey).toBe('hypothesis:h1')
    expect(result.attributionCoverage).toBe(0)
  })

  it('reports attribution coverage for positive events with provenance', () => {
    const events = [
      event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1', occurredAt: NOW }),
      event({ hypothesisId: 'h2', eventType: 'adopted', sourceId: 's2', occurredAt: NOW }),
    ]
    const result = aggregateConceptPairWeights(events, hypotheses(['h1', 'origin:a', 'origin:b']), undefined, NOW)
    expect(result.attributionCoverage).toBe(0.5)
  })
})

describe('buildFeedbackSnapshot', () => {
  const events = [
    event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1', occurredAt: NOW }),
    event({ hypothesisId: 'h2', eventType: 'adopted', sourceId: 's2', occurredAt: NOW }),
  ]
  const hyp = hypotheses(['h1', 'origin:a', 'origin:b'], ['h2', 'origin:c', 'origin:d'])

  it('is deterministic under shuffled input', () => {
    const a = buildFeedbackSnapshot(events, hyp, undefined, NOW)
    const b = buildFeedbackSnapshot([...events].reverse(), hyp, undefined, NOW)
    expect(b.version).toBe(a.version)
  })

  it('changes when the config changes', () => {
    const a = buildFeedbackSnapshot(events, hyp, undefined, NOW)
    const b = buildFeedbackSnapshot(events, hyp, { ...DEFAULT_FEEDBACK_LEARNING_CONFIG, halfLifeDays: 60 }, NOW)
    expect(b.version).not.toBe(a.version)
    expect(b.configHash).not.toBe(a.configHash)
  })

  it('stamps every pair with the snapshot version', () => {
    const snap = buildFeedbackSnapshot(events, hyp, undefined, NOW)
    expect(snap.pairs.length).toBeGreaterThan(0)
    for (const p of snap.pairs) expect(p.feedbackSnapshotVersion).toBe(snap.version)
    expect(snap.duplicateApplicationRate).toBe(0)
  })

  it('does not inflate weights when duplicate events are appended (Duplicate Application Rate = 0)', () => {
    const once = buildFeedbackSnapshot(events, hyp, undefined, NOW)
    const twice = buildFeedbackSnapshot([...events, ...events], hyp, undefined, NOW)
    // 重复事件被去重抑制：权重不变、重复加权比例为 0
    expect(twice.duplicateApplicationRate).toBe(0)
    expect(twice.dedupedEventCount).toBe(events.length)
    expect(twice.pairs.map((p) => p.quality.positiveCount)).toEqual(once.pairs.map((p) => p.quality.positiveCount))
    expect(twice.pairs.map((p) => p.selection.positiveCount)).toEqual(once.pairs.map((p) => p.selection.positiveCount))
  })
})

describe('replayFeedbackAdjustment', () => {
  function weight(over: Partial<ConceptPairWeight> = {}): ConceptPairWeight {
    return {
      conceptAId: 'origin:a',
      conceptBId: 'origin:b',
      pairKey: pairKeyOf('origin:a', 'origin:b'),
      attribution: 'pair',
      selection: { positiveCount: 0, negativeCount: 0, evidenceCount: 0, posteriorMean: 0.5, confidence: 0, lastEvidenceAt: 0 },
      quality: { positiveCount: 0, negativeCount: 0, evidenceCount: 0, posteriorMean: 0.5, confidence: 0, lastEvidenceAt: 0 },
      landing: { positiveCount: 0, negativeCount: 0, evidenceCount: 0, posteriorMean: 0.5, confidence: 0, lastEvidenceAt: 0 },
      negative: { positiveCount: 0, negativeCount: 0, evidenceCount: 0, posteriorMean: 0.5, confidence: 0, lastEvidenceAt: 0 },
      lastEvidenceAt: 0,
      ...over,
    }
  }

  it('moves the adjustment negative under strong negative evidence', () => {
    const adj = replayFeedbackAdjustment(
      weight({ negative: { positiveCount: 0, negativeCount: 2, evidenceCount: 1, posteriorMean: 0.75, confidence: 0.6, lastEvidenceAt: 0 } }),
    )
    expect(adj.adjustment).toBeLessThan(0)
  })

  it('is clamped by lambdaClampPct', () => {
    const adj = replayFeedbackAdjustment(
      weight({
        quality: { positiveCount: 1, negativeCount: 0, evidenceCount: 1, posteriorMean: 1, confidence: 1, lastEvidenceAt: 0 },
      }),
      { ...DEFAULT_FEEDBACK_LEARNING_CONFIG, lambdaClampPct: 0.1 },
    )
    expect(Math.abs(adj.clampedAdjustment)).toBeLessThanOrEqual(0.1 + 1e-9)
  })
})

describe('FeedbackLearningService (injected stores)', () => {
  it('builds a snapshot and a replay report from injected data', () => {
    const events = [event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's1', occurredAt: NOW })]
    const hyp = hypotheses(['h1', 'origin:a', 'origin:b'])
    const service = new FeedbackLearningService({
      eventStore: { list: () => events },
      ideaStore: { getHypotheses: () => [{ id: 'h1', provenance: hyp['h1'] }] },
      now: NOW,
    })
    const snap = service.buildSnapshot()
    expect(snap.version).toMatch(/^[0-9a-f]{12}$/)
    expect(snap.duplicateApplicationRate).toBe(0)

    const report = service.replay(new Map([[pairKeyOf('origin:a', 'origin:b'), 50]]))
    expect(report.comparisons).toHaveLength(1)
    expect(report.comparisons[0].feedbackScore).not.toBe(report.comparisons[0].baseScore)
    expect(report.traceableEvidenceCount).toBeGreaterThan(0)
  })
})
