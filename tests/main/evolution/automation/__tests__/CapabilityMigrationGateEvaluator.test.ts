import { describe, expect, it } from 'vitest'

import { evaluateCapabilityMigrationGate } from '@akemi-mio/evolution/automation/CapabilityMigrationGateEvaluator'

describe('CapabilityMigrationGateEvaluator', () => {
  it('passes only when all gate conditions are met', () => {
    const report = evaluateCapabilityMigrationGate({
      observationWindow: { candidateCount: 1200, observedDays: 8 },
      coverage: { identityCoverage: 0.97, traceabilityRate: 1, legacyOnlyRatio: 0.04 },
      decision: { consistencyRate: 0.96, executorRegressionCount: 0 },
    })

    expect(report.status).toBe('pass')
    expect(report.metrics.observationWindow.passed).toBe(true)
    expect(report.metrics.identityCoverage.passed).toBe(true)
    expect(report.metrics.traceability.passed).toBe(true)
    expect(report.metrics.legacyOnlyRatio.passed).toBe(true)
    expect(report.metrics.decisionConsistency.passed).toBe(true)
    expect(report.metrics.executorRegression.passed).toBe(true)
  })

  it('returns hold when cutover evidence is incomplete but safety invariants remain intact', () => {
    const report = evaluateCapabilityMigrationGate({
      observationWindow: { candidateCount: 999, observedDays: 6 },
      coverage: { identityCoverage: 0.89, traceabilityRate: 1, legacyOnlyRatio: 0.11 },
      decision: { consistencyRate: 0.94, executorRegressionCount: 0 },
    })

    expect(report.status).toBe('hold')
    expect(report.metrics.observationWindow.passed).toBe(false)
    expect(report.metrics.identityCoverage.passed).toBe(false)
    expect(report.metrics.traceability.passed).toBe(true)
    expect(report.metrics.legacyOnlyRatio.passed).toBe(false)
    expect(report.metrics.decisionConsistency.passed).toBe(false)
    expect(report.metrics.executorRegression.passed).toBe(true)
  })

  it('returns fail when safety invariants or executor regression are broken', () => {
    const report = evaluateCapabilityMigrationGate({
      observationWindow: { candidateCount: 1200, observedDays: 8 },
      coverage: { identityCoverage: 0.97, traceabilityRate: 0.8, legacyOnlyRatio: 0.04 },
      decision: { consistencyRate: 0.97, executorRegressionCount: 1 },
    })

    expect(report.status).toBe('fail')
    expect(report.metrics.observationWindow.passed).toBe(true)
    expect(report.metrics.traceability.passed).toBe(false)
    expect(report.metrics.executorRegression.passed).toBe(false)
  })
})
