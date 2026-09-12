import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

import { BehavioralEvidenceAnalyzer } from './BehavioralEvidenceAnalyzer'
import type { EvaluationEvent } from './types'

export interface BehavioralObservationSnapshot {
  sampleCount: number
  rejectedSampleCount: number
  incompleteEvidenceCount: number
  sequenceFamilies: Record<string, number>
  fingerprintDistribution: Record<string, number>
  divergenceSummary: {
    detectedCount: number
    insufficientCount: number
    traceIds: string[]
  }
  decisionImpactSummary: {
    derivedCount: number
    insufficientCount: number
    traceIds: string[]
  }
  traceRefs: string[]
}

export function buildBehavioralObservationSnapshot(events: EvaluationEvent[]): BehavioralObservationSnapshot {
  const traceIds = Array.from(new Set(events.map((event) => event.traceId).filter((traceId) => traceId.trim() !== ''))).sort(
    (left, right) => left.localeCompare(right),
  )
  const analyses = traceIds.map((traceId) => BehavioralEvidenceAnalyzer.compute(traceId, events))
  const traceRefs = analyses.map((analysis) => analysis.traceId).sort((left, right) => left.localeCompare(right))

  const sequenceFamilies = new Map<string, number>()
  const fingerprintDistribution = new Map<string, number>()
  const decisionImpactDerivedTraceIds: string[] = []

  let sampleCount = 0
  let rejectedSampleCount = 0
  let incompleteEvidenceCount = 0
  let divergenceInsufficientCount = 0
  let decisionImpactInsufficientCount = 0

  for (const analysis of analyses) {
    if (analysis.observationEligible) {
      sampleCount += 1
    } else {
      rejectedSampleCount += 1
    }

    if (analysis.sampleStatus === 'incomplete_sample' || analysis.sequenceStatus === 'insufficient_for_fingerprint') {
      incompleteEvidenceCount += 1
    }

    if (analysis.divergenceStatus === 'insufficient_for_divergence') {
      divergenceInsufficientCount += 1
    }

    if (analysis.decisionImpactStatus === 'derived') {
      decisionImpactDerivedTraceIds.push(analysis.traceId)
    } else if (analysis.decisionImpactStatus === 'insufficient_for_decision_impact') {
      decisionImpactInsufficientCount += 1
    }

    if (!analysis.observationEligible || analysis.fingerprint === null) {
      continue
    }

    incrementCount(fingerprintDistribution, analysis.fingerprint)
    incrementCount(sequenceFamilies, analysis.sequence.join('>'))
  }

  decisionImpactDerivedTraceIds.sort((left, right) => left.localeCompare(right))

  return {
    sampleCount,
    rejectedSampleCount,
    incompleteEvidenceCount,
    sequenceFamilies: toSortedRecord(sequenceFamilies),
    fingerprintDistribution: toSortedRecord(fingerprintDistribution),
    divergenceSummary: {
      detectedCount: 0,
      insufficientCount: divergenceInsufficientCount,
      traceIds: [],
    },
    decisionImpactSummary: {
      derivedCount: decisionImpactDerivedTraceIds.length,
      insufficientCount: decisionImpactInsufficientCount,
      traceIds: decisionImpactDerivedTraceIds,
    },
    traceRefs,
  }
}

export class BehavioralObservationWriter {
  constructor(private readonly persistDir: string) {}

  async write(snapshot: BehavioralObservationSnapshot): Promise<string> {
    await mkdir(this.persistDir, { recursive: true })

    const outputPath = join(this.persistDir, 'behavioral-observation.json')
    await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')

    return outputPath
  }
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function toSortedRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(Array.from(counts.entries()).sort(([left], [right]) => left.localeCompare(right)))
}
