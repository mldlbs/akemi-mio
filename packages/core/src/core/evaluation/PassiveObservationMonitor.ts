export type PassiveObservationDecision = 'Continue Freeze' | 'Evidence Review Required'

export interface PassiveObservationBaseline {
  sampleCount: number
  traceCount: number
  incompleteEvidenceCount: number
  fingerprintDistribution: Record<string, number>
}

export interface PassiveObservationCurrent {
  sampleCount: number
  traceCount: number
  incompleteEvidenceCount: number
  fingerprintDistribution: Record<string, number>
  divergenceCount: number
  decisionImpactCount: number
}

export interface PassiveObservationReport {
  schemaVersion: 1
  generatedAt: string
  baseline: {
    sampleCount: number
    traceCount: number
    incompleteEvidenceRate: number
  }
  current: {
    sampleCount: number
    traceCount: number
    incompleteEvidenceCount: number
    incompleteEvidenceRate: number
    fingerprintDistribution: Record<string, number>
    newFingerprintCount: number
    divergenceCount: number
    decisionImpactCount: number
    blindSpotCount: number
  }
  comparison: {
    newIncompleteEvidenceCount: number
    incompleteEvidenceRateDelta: number
    repeatedNewFingerprintCount: number
  }
  decision: PassiveObservationDecision
  triggers: string[]
}

export function evaluatePassiveObservation(
  baseline: PassiveObservationBaseline,
  current: PassiveObservationCurrent,
  generatedAt: string,
): PassiveObservationReport {
  validateInput(baseline, 'baseline')
  validateInput(current, 'current')

  const baselineRate = baseline.incompleteEvidenceCount / baseline.traceCount
  const currentRate = current.incompleteEvidenceCount / current.traceCount
  const incompleteRateDelta = currentRate - baselineRate
  const newIncompleteEvidenceCount = Math.max(0, current.incompleteEvidenceCount - baseline.incompleteEvidenceCount)

  const newFingerprints = Object.keys(current.fingerprintDistribution).filter(
    (fingerprint) => !(fingerprint in baseline.fingerprintDistribution),
  )
  const repeatedNewFingerprintCount = newFingerprints.filter((fingerprint) => current.fingerprintDistribution[fingerprint] >= 3).length

  const triggers: string[] = []
  if (current.divergenceCount > 0) {
    triggers.push('divergence_detected')
  }
  if (current.decisionImpactCount > 0) {
    triggers.push('decision_impact_detected')
  }
  if (repeatedNewFingerprintCount > 0) {
    triggers.push('repeated_new_fingerprint')
  }
  if (incompleteRateDelta >= 0.1 && newIncompleteEvidenceCount >= 5) {
    triggers.push('incomplete_evidence_regression')
  }

  return {
    schemaVersion: 1,
    generatedAt,
    baseline: {
      sampleCount: baseline.sampleCount,
      traceCount: baseline.traceCount,
      incompleteEvidenceRate: baselineRate,
    },
    current: {
      sampleCount: current.sampleCount,
      traceCount: current.traceCount,
      incompleteEvidenceCount: current.incompleteEvidenceCount,
      incompleteEvidenceRate: currentRate,
      fingerprintDistribution: sortRecord(current.fingerprintDistribution),
      newFingerprintCount: newFingerprints.length,
      divergenceCount: current.divergenceCount,
      decisionImpactCount: current.decisionImpactCount,
      blindSpotCount: repeatedNewFingerprintCount,
    },
    comparison: {
      newIncompleteEvidenceCount,
      incompleteEvidenceRateDelta: incompleteRateDelta,
      repeatedNewFingerprintCount,
    },
    decision: triggers.length > 0 ? 'Evidence Review Required' : 'Continue Freeze',
    triggers,
  }
}

function validateInput(input: PassiveObservationBaseline | PassiveObservationCurrent, label: 'baseline' | 'current'): void {
  validateNonNegativeFiniteCount(input.sampleCount, `${label}.sampleCount`)
  validatePositiveTraceCount(input.traceCount, `${label}.traceCount`)
  validateNonNegativeFiniteCount(input.incompleteEvidenceCount, `${label}.incompleteEvidenceCount`)

  if (label === 'current') {
    const current = input as PassiveObservationCurrent
    validateNonNegativeFiniteCount(current.divergenceCount, `${label}.divergenceCount`)
    validateNonNegativeFiniteCount(current.decisionImpactCount, `${label}.decisionImpactCount`)
  }

  validateFingerprintDistribution(input.fingerprintDistribution, `${label}.fingerprintDistribution`)
}

function validateNonNegativeFiniteCount(value: number, fieldPath: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldPath} must be a finite non-negative number`)
  }
}

function validatePositiveTraceCount(value: number, fieldPath: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldPath} must be a finite positive number`)
  }
}

function validateFingerprintDistribution(distribution: Record<string, number>, fieldPath: string): void {
  if (distribution === null || typeof distribution !== 'object' || Array.isArray(distribution)) {
    throw new Error(`${fieldPath} must be an object`)
  }

  for (const [fingerprint, count] of Object.entries(distribution)) {
    validateNonNegativeFiniteCount(count, `${fieldPath}.${fingerprint}`)
  }
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)))
}
