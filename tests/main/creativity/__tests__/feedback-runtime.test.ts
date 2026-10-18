import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FEEDBACK_RUNTIME,
  FEEDBACK_MODES,
  parseFeedbackRuntime,
  resolveFeedbackRuntime,
  isFeedbackApplied,
  isFeedbackObserved,
} from '@akemi-mio/creativity/FeedbackRuntime'

describe('parseFeedbackRuntime (R6 配置纪律)', () => {
  it('accepts a full valid config', () => {
    const cfg = parseFeedbackRuntime({ mode: 'canary', lambdaClampPct: 0.2, explorationBudget: 0.3, halfLifeDays: 45, canaryFraction: 0.25 })
    expect(cfg).toEqual({ mode: 'canary', lambdaClampPct: 0.2, explorationBudget: 0.3, halfLifeDays: 45, canaryFraction: 0.25 })
  })

  it('rejects unknown modes (fail-closed)', () => {
    expect(parseFeedbackRuntime({ mode: 'bogus' })).toBeNull()
    expect(parseFeedbackRuntime(null)).toBeNull()
    expect(parseFeedbackRuntime('off')).toBeNull()
  })

  it('clamps out-of-range numbers to safe bounds', () => {
    const cfg = parseFeedbackRuntime({ mode: 'full', lambdaClampPct: 99, explorationBudget: -1, halfLifeDays: 0, canaryFraction: 5 })!
    expect(cfg.lambdaClampPct).toBe(0.5)
    expect(cfg.explorationBudget).toBe(0)
    expect(cfg.halfLifeDays).toBe(1)
    expect(cfg.canaryFraction).toBe(1)
  })
})

describe('resolveFeedbackRuntime (env)', () => {
  it('defaults to off when nothing is set', () => {
    expect(resolveFeedbackRuntime({})).toEqual(DEFAULT_FEEDBACK_RUNTIME)
    expect(DEFAULT_FEEDBACK_RUNTIME.mode).toBe('off')
  })

  it('reads env overrides', () => {
    const cfg = resolveFeedbackRuntime({
      MIO_FEEDBACK_MODE: 'shadow',
      MIO_FEEDBACK_LAMBDA_PCT: '0.15',
      MIO_FEEDBACK_EXPLORATION: '0.4',
      MIO_FEEDBACK_HALF_LIFE_DAYS: '60',
      MIO_FEEDBACK_CANARY_FRACTION: '0.5',
    })
    expect(cfg.mode).toBe('shadow')
    expect(cfg.lambdaClampPct).toBe(0.15)
    expect(cfg.explorationBudget).toBe(0.4)
    expect(cfg.halfLifeDays).toBe(60)
    expect(cfg.canaryFraction).toBe(0.5)
  })

  it('falls back to off on an invalid mode', () => {
    expect(resolveFeedbackRuntime({ MIO_FEEDBACK_MODE: 'nope' }).mode).toBe('off')
  })
})

describe('mode gating', () => {
  it('only canary/full apply feedback', () => {
    expect(isFeedbackApplied('off')).toBe(false)
    expect(isFeedbackApplied('shadow')).toBe(false)
    expect(isFeedbackApplied('canary')).toBe(true)
    expect(isFeedbackApplied('full')).toBe(true)
  })

  it('shadow/canary/full observe feedback', () => {
    expect(isFeedbackObserved('off')).toBe(false)
    expect(isFeedbackObserved('shadow')).toBe(true)
    expect(isFeedbackObserved('canary')).toBe(true)
    expect(isFeedbackObserved('full')).toBe(true)
  })

  it('exposes the full mode list', () => {
    expect(FEEDBACK_MODES).toEqual(['off', 'shadow', 'canary', 'full'])
  })
})
