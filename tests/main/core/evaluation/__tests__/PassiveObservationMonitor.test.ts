import { describe, expect, it } from 'vitest'

import { M57_PASSIVE_OBSERVATION_BASELINE } from '@akemi-mio/core/core/evaluation/PassiveObservationBaseline'
import { evaluatePassiveObservation, type PassiveObservationBaseline, type PassiveObservationCurrent } from '@akemi-mio/core/core/evaluation/PassiveObservationMonitor'

const baseline: PassiveObservationBaseline = {
  sampleCount: 103,
  traceCount: 304,
  incompleteEvidenceCount: 201,
  fingerprintDistribution: {
    response: 93,
    'tool:file_management>response': 3,
  },
}

const current: PassiveObservationCurrent = {
  sampleCount: 104,
  traceCount: 305,
  incompleteEvidenceCount: 201,
  fingerprintDistribution: {
    response: 94,
    'tool:file_management>response': 3,
  },
  divergenceCount: 0,
  decisionImpactCount: 0,
}

const generatedAt = '2026-08-03T00:00:00.000Z'

describe('PassiveObservationMonitor', () => {
  it('uses the frozen M5.7 baseline values', () => {
    expect(M57_PASSIVE_OBSERVATION_BASELINE).toEqual({
      sampleCount: 103,
      traceCount: 304,
      incompleteEvidenceCount: 201,
      fingerprintDistribution: {
        response: 93,
        'tool:file_management>response': 3,
        'tool:file_management>tool:file_management>tool:system_execution>response': 1,
        'tool:system_execution>response': 2,
        'tool:system_execution>tool:file_management>response': 1,
        'tool:system_execution>tool:system_execution>response': 3,
      },
    })
  })

  it('continues freeze when no trigger signal is present', () => {
    const report = evaluatePassiveObservation(baseline, current, generatedAt)

    expect(report).toEqual({
      schemaVersion: 1,
      generatedAt,
      baseline: {
        sampleCount: 103,
        traceCount: 304,
        incompleteEvidenceRate: 201 / 304,
      },
      current: {
        sampleCount: 104,
        traceCount: 305,
        incompleteEvidenceCount: 201,
        incompleteEvidenceRate: 201 / 305,
        fingerprintDistribution: {
          response: 94,
          'tool:file_management>response': 3,
        },
        newFingerprintCount: 0,
        divergenceCount: 0,
        decisionImpactCount: 0,
        blindSpotCount: 0,
      },
      comparison: {
        newIncompleteEvidenceCount: 0,
        incompleteEvidenceRateDelta: 201 / 305 - 201 / 304,
        repeatedNewFingerprintCount: 0,
      },
      decision: 'Continue Freeze',
      triggers: [],
    })
  })

  it('requires review for a repeated new fingerprint', () => {
    const report = evaluatePassiveObservation(
      baseline,
      {
        ...current,
        fingerprintDistribution: {
          ...current.fingerprintDistribution,
          'tool:search_retrieval>response': 3,
        },
      },
      generatedAt,
    )

    expect(report.decision).toBe('Evidence Review Required')
    expect(report.triggers).toEqual(['repeated_new_fingerprint'])
    expect(report.current.newFingerprintCount).toBe(1)
    expect(report.current.blindSpotCount).toBe(1)
    expect(report.comparison.repeatedNewFingerprintCount).toBe(1)
  })

  it('records but does not trigger on a one-off new fingerprint', () => {
    const report = evaluatePassiveObservation(
      baseline,
      {
        ...current,
        fingerprintDistribution: {
          ...current.fingerprintDistribution,
          'tool:search_retrieval>response': 1,
        },
      },
      generatedAt,
    )

    expect(report.decision).toBe('Continue Freeze')
    expect(report.current.newFingerprintCount).toBe(1)
    expect(report.current.blindSpotCount).toBe(0)
    expect(report.comparison.repeatedNewFingerprintCount).toBe(0)
  })

  it('requires review for divergence or decision impact', () => {
    expect(evaluatePassiveObservation(baseline, { ...current, divergenceCount: 1 }, generatedAt).triggers).toContain('divergence_detected')

    expect(evaluatePassiveObservation(baseline, { ...current, decisionImpactCount: 1 }, generatedAt).triggers).toContain(
      'decision_impact_detected',
    )
  })

  it('requires both incomplete-evidence threshold conditions', () => {
    const baselineRate = baseline.incompleteEvidenceCount / baseline.traceCount

    const belowRate = evaluatePassiveObservation(
      baseline,
      {
        ...current,
        traceCount: 304,
        incompleteEvidenceCount: 231,
      },
      generatedAt,
    )
    expect(belowRate.current.incompleteEvidenceRate - baselineRate).toBeLessThan(0.1)
    expect(belowRate.triggers).not.toContain('incomplete_evidence_regression')

    const aboveThreshold = evaluatePassiveObservation(
      baseline,
      {
        ...current,
        traceCount: 304,
        incompleteEvidenceCount: 236,
      },
      generatedAt,
    )
    expect(aboveThreshold.current.incompleteEvidenceRate - baselineRate).toBeGreaterThanOrEqual(0.1)
    expect(aboveThreshold.comparison.newIncompleteEvidenceCount).toBe(35)
    expect(aboveThreshold.triggers).toContain('incomplete_evidence_regression')
  })

  it('does not trigger when the rate delta is high but fewer than five new incomplete traces exist', () => {
    const report = evaluatePassiveObservation(
      baseline,
      {
        ...current,
        traceCount: 269,
        incompleteEvidenceCount: 205,
      },
      generatedAt,
    )

    expect(report.current.incompleteEvidenceRate - 201 / 304).toBeGreaterThanOrEqual(0.1)
    expect(report.comparison.newIncompleteEvidenceCount).toBe(4)
    expect(report.triggers).not.toContain('incomplete_evidence_regression')
  })

  it('does not trigger when fewer than five new incomplete traces exist and the rate delta is low', () => {
    const report = evaluatePassiveObservation(
      baseline,
      {
        ...current,
        traceCount: 304,
        incompleteEvidenceCount: 205,
      },
      generatedAt,
    )

    expect(report.comparison.newIncompleteEvidenceCount).toBe(4)
    expect(report.current.incompleteEvidenceRate - 201 / 304).toBeLessThan(0.1)
    expect(report.triggers).not.toContain('incomplete_evidence_regression')
  })

  it('sorts current fingerprint records by key without changing counts', () => {
    const report = evaluatePassiveObservation(
      baseline,
      {
        ...current,
        fingerprintDistribution: {
          zeta: 3,
          alpha: 1,
          response: 94,
          'tool:file_management>response': 3,
        },
      },
      generatedAt,
    )

    expect(Object.keys(report.current.fingerprintDistribution)).toEqual(['alpha', 'response', 'tool:file_management>response', 'zeta'])
    expect(report.current.fingerprintDistribution).toEqual({
      alpha: 1,
      response: 94,
      'tool:file_management>response': 3,
      zeta: 3,
    })
  })

  it.each([
    ['sampleCount', { sampleCount: -1 }, 'baseline.sampleCount'],
    ['traceCount', { traceCount: 0 }, 'baseline.traceCount'],
    ['incompleteEvidenceCount', { incompleteEvidenceCount: Number.NaN }, 'baseline.incompleteEvidenceCount'],
  ])('rejects invalid baseline %s with a field-specific error', (_field, patch, fieldPath) => {
    expect(() => evaluatePassiveObservation({ ...baseline, ...patch }, current, generatedAt)).toThrow(fieldPath)
  })

  it.each([
    ['sampleCount', { sampleCount: Number.POSITIVE_INFINITY }, 'current.sampleCount'],
    ['traceCount', { traceCount: -1 }, 'current.traceCount'],
    ['incompleteEvidenceCount', { incompleteEvidenceCount: -1 }, 'current.incompleteEvidenceCount'],
    ['divergenceCount', { divergenceCount: Number.NaN }, 'current.divergenceCount'],
    ['decisionImpactCount', { decisionImpactCount: Number.POSITIVE_INFINITY }, 'current.decisionImpactCount'],
  ])('rejects invalid current %s with a field-specific error', (_field, patch, fieldPath) => {
    expect(() => evaluatePassiveObservation(baseline, { ...current, ...patch }, generatedAt)).toThrow(fieldPath)
  })

  it('rejects invalid fingerprint distributions with field-specific errors', () => {
    expect(() => evaluatePassiveObservation({ ...baseline, fingerprintDistribution: { response: -1 } }, current, generatedAt)).toThrow(
      'baseline.fingerprintDistribution.response',
    )

    expect(() =>
      evaluatePassiveObservation(baseline, { ...current, fingerprintDistribution: { response: Number.NaN } }, generatedAt),
    ).toThrow('current.fingerprintDistribution.response')
  })
})
