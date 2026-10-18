import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS,
  FEEDBACK_MODE_LADDER,
  nextFeedbackMode,
  negativeEventRateOf,
  parseFeedbackRolloutThresholds,
  resolveFeedbackRolloutThresholds,
  buildFeedbackRolloutReport,
  type FeedbackRolloutThresholds,
  type FeedbackRuntimeRun,
} from '@akemi-mio/creativity/FeedbackRollout'
import {
  buildFeedbackSnapshot,
  pairKeyOf,
  type FeedbackSnapshot,
  type HypothesisProvenanceLike,
} from '@akemi-mio/creativity/FeedbackLearning'
import type { HypothesisFeedbackEvent } from '@akemi-mio/creativity/FeedbackEvents'

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

function provenance(): Record<string, HypothesisProvenanceLike | undefined> {
  return { h1: { sources: [{ name: 'a', type: 'knowledge', origin: 'origin:a' }, { name: 'b', type: 'knowledge', origin: 'origin:b' }] } }
}

function makeSnapshot(overrides: Partial<FeedbackSnapshot> = {}): FeedbackSnapshot {
  return {
    version: 'fb-0001',
    configHash: 'cfg',
    generatedAt: NOW,
    eventCount: 0,
    pairs: [],
    attributionCoverage: 0,
    duplicateApplicationRate: 0,
    dedupedEventCount: 0,
    ...overrides,
  }
}

function run(mode: FeedbackRuntimeRun['mode'], at: number): FeedbackRuntimeRun {
  return { at, mode, snapshotVersion: 'fb-0001', pairCount: 1, applied: mode !== 'shadow' }
}

const baseThresholds: FeedbackRolloutThresholds = {
  minStageRuns: 5,
  minAttributionCoverage: 0.3,
  maxNegativeEventRate: 0.5,
}

describe('FeedbackRollout pure core', () => {
  it('ladder is off→shadow→canary→full and nextFeedbackMode wraps to null at the top', () => {
    expect(FEEDBACK_MODE_LADDER).toEqual(['off', 'shadow', 'canary', 'full'])
    expect(nextFeedbackMode('off')).toBe('shadow')
    expect(nextFeedbackMode('shadow')).toBe('canary')
    expect(nextFeedbackMode('canary')).toBe('full')
    expect(nextFeedbackMode('full')).toBeNull()
  })

  it('parse thresholds is fail-closed: null / empty → null (caller falls back to defaults)', () => {
    expect(parseFeedbackRolloutThresholds(null)).toBeNull()
    expect(parseFeedbackRolloutThresholds({})).toBeNull()
    expect(parseFeedbackRolloutThresholds('nonsense')).toBeNull()
  })

  it('parse thresholds clamp out-of-range values and fall back per-field on garbage', () => {
    const clamped = parseFeedbackRolloutThresholds({
      minStageRuns: 99_999,
      minAttributionCoverage: -1,
      maxNegativeEventRate: 5,
    })
    expect(clamped).toEqual({ minStageRuns: 10_000, minAttributionCoverage: 0, maxNegativeEventRate: 1 })

    const garbage = parseFeedbackRolloutThresholds({ minStageRuns: 'abc' })
    expect(garbage).toEqual({
      minStageRuns: DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS.minStageRuns,
      minAttributionCoverage: DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS.minAttributionCoverage,
      maxNegativeEventRate: DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS.maxNegativeEventRate,
    })

    const ok = parseFeedbackRolloutThresholds({
      minStageRuns: 10,
      minAttributionCoverage: 0.5,
      maxNegativeEventRate: 0.25,
    })
    expect(ok).toEqual({ minStageRuns: 10, minAttributionCoverage: 0.5, maxNegativeEventRate: 0.25 })
  })

  it('resolveFeedbackRolloutThresholds maps env vars and falls back to defaults when nothing parses', () => {
    const empty = resolveFeedbackRolloutThresholds({})
    expect(empty).toEqual(DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS)
    const ok = resolveFeedbackRolloutThresholds({
      MIO_FEEDBACK_MIN_STAGE_RUNS: '7',
      MIO_FEEDBACK_MIN_COVERAGE: '0.5',
      MIO_FEEDBACK_MAX_NEGATIVE_RATE: '0.25',
    })
    expect(ok).toEqual({ minStageRuns: 7, minAttributionCoverage: 0.5, maxNegativeEventRate: 0.25 })
    const garbage = resolveFeedbackRolloutThresholds({ MIO_FEEDBACK_MIN_STAGE_RUNS: 'abc' })
    expect(garbage).toEqual(DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS)
  })

  it('negativeEventRateOf is 0 with no evidence and negative/(positive+negative) otherwise', () => {
    expect(negativeEventRateOf(null)).toBe(0)
    expect(negativeEventRateOf(makeSnapshot())).toBe(0)
    const snapshot = buildFeedbackSnapshot(
      [
        event({ hypothesisId: 'h1', eventType: 'adopted', sourceId: 's1' }),
        event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's2' }),
        event({ hypothesisId: 'h1', eventType: 'implemented', sourceId: 'c1', commitSha: 'abc' }),
        event({ hypothesisId: 'h1', eventType: 'rejected', sourceId: 's3' }),
      ],
      provenance(),
      undefined,
      NOW,
    )
    // 4 events, 1 negative → 1/4 = 0.25
    expect(negativeEventRateOf(snapshot)).toBeCloseTo(0.25)
  })

  it('off→shadow always advances, even with zero runs (bootstrap)', () => {
    const report = buildFeedbackRolloutReport({
      snapshot: makeSnapshot(),
      runs: [],
      currentMode: 'off',
      thresholds: baseThresholds,
    })
    expect(report.decision).toBe('advance')
    expect(report.to).toBe('shadow')
    expect(report.from).toBe('off')
    expect(report.reasons.join(' ')).toMatch(/observation/i)
  })

  it('shadow holds until stage runs and attribution coverage both clear their thresholds', () => {
    const fewRuns = Array.from({ length: 4 }, (_, i) => run('shadow', i + 1))
    const lowCoverage = buildFeedbackRolloutReport({
      snapshot: makeSnapshot({ attributionCoverage: 0.1 }),
      runs: fewRuns,
      currentMode: 'shadow',
      thresholds: baseThresholds,
    })
    expect(lowCoverage.decision).toBe('hold')
    expect(lowCoverage.to).toBeNull()
    expect(lowCoverage.reasons.join(' ')).toMatch(/shadow runs/i)
    expect(lowCoverage.reasons.join(' ')).toMatch(/attribution coverage/i)

    const enoughRunsLowCoverage = buildFeedbackRolloutReport({
      snapshot: makeSnapshot({ attributionCoverage: 0.1 }),
      runs: Array.from({ length: 6 }, (_, i) => run('shadow', i + 1)),
      currentMode: 'shadow',
      thresholds: baseThresholds,
    })
    expect(enoughRunsLowCoverage.decision).toBe('hold')
    expect(enoughRunsLowCoverage.reasons.join(' ')).toMatch(/attribution coverage/i)
    expect(enoughRunsLowCoverage.reasons.join(' ')).not.toMatch(/shadow runs/i)

    const ready = buildFeedbackRolloutReport({
      snapshot: makeSnapshot({ attributionCoverage: 0.6 }),
      runs: Array.from({ length: 6 }, (_, i) => run('shadow', i + 1)),
      currentMode: 'shadow',
      thresholds: baseThresholds,
    })
    expect(ready.decision).toBe('advance')
    expect(ready.to).toBe('canary')
  })

  it('canary additionally requires the negative-event-rate ceiling', () => {
    const runs = Array.from({ length: 6 }, (_, i) => run('canary', i + 1))
    const snapshot = makeSnapshot({ attributionCoverage: 0.8, eventCount: 10 })
    // fabricate pair evidence with heavy negatives via real snapshot builder
    const hot = buildFeedbackSnapshot(
      [
        event({ hypothesisId: 'h1', eventType: 'adopted', sourceId: 's1' }),
        ...Array.from({ length: 8 }, (_, i) => event({ hypothesisId: 'h1', eventType: 'rejected', sourceId: `r${i}` })),
      ],
      provenance(),
      undefined,
      NOW,
    )
    // rate = 8/9 ≈ 0.889 > 0.5
    expect(negativeEventRateOf(hot)).toBeGreaterThan(0.5)
    const report = buildFeedbackRolloutReport({ snapshot: hot, runs, currentMode: 'canary', thresholds: baseThresholds })
    expect(report.decision).toBe('hold')
    expect(report.reasons.join(' ')).toMatch(/negative event rate/i)

    const clean = buildFeedbackRolloutReport({
      snapshot: makeSnapshot({ attributionCoverage: 0.8, eventCount: 10, duplicateApplicationRate: 0 }),
      runs,
      currentMode: 'canary',
      thresholds: baseThresholds,
    })
    // no pair evidence → negative rate 0 → clear
    expect(clean.decision).toBe('advance')
    expect(clean.to).toBe('full')
  })

  it('full holds (no higher stage); duplicate rate > 0 forces rollback anywhere', () => {
    const runs = Array.from({ length: 6 }, (_, i) => run('full', i + 1))
    const atFull = buildFeedbackRolloutReport({
      snapshot: makeSnapshot({ attributionCoverage: 0.9 }),
      runs,
      currentMode: 'full',
      thresholds: baseThresholds,
    })
    expect(atFull.decision).toBe('hold')
    expect(atFull.to).toBeNull()
    expect(atFull.reasons.join(' ')).toMatch(/already at full stage/i)

    for (const mode of ['shadow', 'canary', 'full'] as const) {
      const dup = buildFeedbackRolloutReport({
        snapshot: makeSnapshot({ attributionCoverage: 0.9, duplicateApplicationRate: 0.4 }),
        runs: Array.from({ length: 8 }, (_, i) => run(mode, i + 1)),
        currentMode: mode,
        thresholds: baseThresholds,
      })
      expect(dup.decision).toBe('rollback')
      expect(dup.to).toBe('off')
      expect(dup.reasons.join(' ')).toMatch(/duplicate_application_rate/i)
    }
  })

  it('report metrics carry per-mode run counts for observability', () => {
    const runs = [run('shadow', 1), run('shadow', 2), run('canary', 3), run('canary', 4), run('full', 5)]
    const report = buildFeedbackRolloutReport({
      snapshot: makeSnapshot({ attributionCoverage: 0.9 }),
      runs,
      currentMode: 'canary',
      thresholds: baseThresholds,
    })
    expect(report.metrics.shadowRuns).toBe(2)
    expect(report.metrics.canaryRuns).toBe(2)
    expect(report.from).toBe('canary')
  })

  it('event axis mapping is consistent with the P0 contract (adopted=selection, validated=quality, implemented=landing)', () => {
    const snapshot = buildFeedbackSnapshot(
      [
        event({ hypothesisId: 'h1', eventType: 'adopted', sourceId: 's1' }),
        event({ hypothesisId: 'h1', eventType: 'validated', sourceId: 's2' }),
        event({ hypothesisId: 'h1', eventType: 'implemented', sourceId: 'c1', commitSha: 'abc' }),
        event({ hypothesisId: 'h1', eventType: 'rejected', sourceId: 's3' }),
      ],
      provenance(),
      undefined,
      NOW,
    )
    const pair = snapshot.pairs.find((p) => p.pairKey === pairKeyOf('origin:a', 'origin:b'))!
    expect(pair.selection.evidenceCount).toBe(1)
    expect(pair.quality.evidenceCount).toBe(1)
    expect(pair.landing.evidenceCount).toBe(1)
    expect(pair.negative.evidenceCount).toBe(1)
    expect(pair.attribution).toBe('pair')
  })
})
