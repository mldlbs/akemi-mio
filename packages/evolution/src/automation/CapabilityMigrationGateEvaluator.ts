import type { CapabilityMigrationGateInput } from './types'

export function evaluateCapabilityMigrationGate(input: CapabilityMigrationGateInput): {
  status: 'hold' | 'fail' | 'pass'
  metrics: {
    observationWindow: { actual: number; target: string; passed: boolean }
    identityCoverage: { actual: number; target: string; passed: boolean }
    traceability: { actual: number; target: string; passed: boolean }
    legacyOnlyRatio: { actual: number; target: string; passed: boolean }
    decisionConsistency: { actual: number; target: string; passed: boolean }
    executorRegression: { actual: number; target: string; passed: boolean }
  }
} {
  const observationPassed = input.observationWindow.candidateCount >= 1000 || input.observationWindow.observedDays >= 7
  const identityPassed = input.coverage.identityCoverage >= 0.9
  const traceabilityPassed = input.coverage.traceabilityRate === 1
  const legacyOnlyPassed = input.coverage.legacyOnlyRatio < 0.1
  const consistencyPassed = input.decision.consistencyRate >= 0.95
  const executorRegressionPassed = input.decision.executorRegressionCount === 0
  const safetyInvariantPassed = traceabilityPassed && executorRegressionPassed
  const cutoverReady =
    observationPassed && identityPassed && traceabilityPassed && legacyOnlyPassed && consistencyPassed && executorRegressionPassed

  return {
    status: cutoverReady ? 'pass' : safetyInvariantPassed ? 'hold' : 'fail',
    metrics: {
      observationWindow: {
        actual: input.observationWindow.candidateCount,
        target: '>=1000 candidates or >=7 days',
        passed: observationPassed,
      },
      identityCoverage: {
        actual: input.coverage.identityCoverage,
        target: '>=0.90',
        passed: identityPassed,
      },
      traceability: {
        actual: input.coverage.traceabilityRate,
        target: '=1.00',
        passed: traceabilityPassed,
      },
      legacyOnlyRatio: {
        actual: input.coverage.legacyOnlyRatio,
        target: '<0.10',
        passed: legacyOnlyPassed,
      },
      decisionConsistency: {
        actual: input.decision.consistencyRate,
        target: '>=0.95',
        passed: consistencyPassed,
      },
      executorRegression: {
        actual: input.decision.executorRegressionCount,
        target: '=0',
        passed: executorRegressionPassed,
      },
    },
  }
}
