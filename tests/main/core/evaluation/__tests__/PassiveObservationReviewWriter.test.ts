import { mkdtemp, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { describe, expect, it } from 'vitest'

import { PassiveObservationReviewWriter } from '@akemi-mio/core/core/evaluation/PassiveObservationReviewWriter'

describe('PassiveObservationReviewWriter', () => {
  it('writes the default passive review report without changing source files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm57-passive-'))
    const writer = new PassiveObservationReviewWriter(directory)
    const report = {
      schemaVersion: 1 as const,
      generatedAt: '2026-08-03T00:00:00.000Z',
      baseline: { sampleCount: 103, traceCount: 304, incompleteEvidenceRate: 0.661184 },
      current: {
        sampleCount: 103,
        traceCount: 304,
        incompleteEvidenceCount: 201,
        incompleteEvidenceRate: 0.661184,
        fingerprintDistribution: { response: 93 },
        newFingerprintCount: 0,
        divergenceCount: 0,
        decisionImpactCount: 0,
        blindSpotCount: 0,
      },
      comparison: {
        newIncompleteEvidenceCount: 0,
        incompleteEvidenceRateDelta: 0,
        repeatedNewFingerprintCount: 0,
      },
      decision: 'Continue Freeze' as const,
      triggers: [],
    }

    const output = await writer.write(report)

    expect(output).toBe(join(directory, 'passive-review.json'))
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(report)
  })

  it('creates parent directories for dated snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm57-passive-'))
    const writer = new PassiveObservationReviewWriter(directory)

    const output = await writer.write(
      {
        schemaVersion: 1,
        generatedAt: '2026-08-03T00:00:00.000Z',
        baseline: { sampleCount: 103, traceCount: 304, incompleteEvidenceRate: 0.661184 },
        current: {
          sampleCount: 103,
          traceCount: 304,
          incompleteEvidenceCount: 201,
          incompleteEvidenceRate: 0.661184,
          fingerprintDistribution: {},
          newFingerprintCount: 0,
          divergenceCount: 0,
          decisionImpactCount: 0,
          blindSpotCount: 0,
        },
        comparison: {
          newIncompleteEvidenceCount: 0,
          incompleteEvidenceRateDelta: 0,
          repeatedNewFingerprintCount: 0,
        },
        decision: 'Continue Freeze',
        triggers: [],
      },
      'passive-observation/2026-08-03.json',
    )

    expect(output).toBe(join(directory, 'passive-observation', '2026-08-03.json'))
    expect(JSON.parse(await readFile(output, 'utf8')).decision).toBe('Continue Freeze')
  })
})
