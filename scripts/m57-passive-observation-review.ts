#!/usr/bin/env tsx
import { isDeepStrictEqual } from 'util'
import { readFile } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { closeDatabase, initDatabase } from '@akemi-mio/core/db/connection'
import {
  buildBehavioralObservationSnapshot,
  type BehavioralObservationSnapshot,
} from '@akemi-mio/core/core/evaluation/BehavioralObservationWriter'
import { EvaluationStore, QUERY_NO_LIMIT } from '@akemi-mio/core/core/evaluation/EvaluationStore'
import { evaluatePassiveObservation, type PassiveObservationReport } from '@akemi-mio/core/core/evaluation/PassiveObservationMonitor'
import { M57_PASSIVE_OBSERVATION_BASELINE } from '@akemi-mio/core/core/evaluation/PassiveObservationBaseline'
import { PassiveObservationReviewWriter } from '@akemi-mio/core/core/evaluation/PassiveObservationReviewWriter'
import { resolveBehavioralObservationUserDataDir } from './m57-behavioral-observation'
import type { EvaluationEvent } from '@akemi-mio/core/core/evaluation/types'

export interface PassiveObservationReviewStore {
  init(): Promise<void>
  queryStrict(range: { since: number; until?: number; type?: string }, options?: { limit?: number }): Promise<EvaluationEvent[]>
  shutdown(): Promise<void>
}

export interface PassiveObservationReviewRunnerOptions {
  currentArtifactPath: string
  outputPath: string
  createStore?: () => PassiveObservationReviewStore
  initDatabase?: () => Promise<void>
  closeDatabase?: () => void | Promise<void>
  now?: () => string
}

const SNAPSHOT_FIELDS: Array<keyof BehavioralObservationSnapshot> = [
  'sampleCount',
  'rejectedSampleCount',
  'incompleteEvidenceCount',
  'sequenceFamilies',
  'fingerprintDistribution',
  'divergenceSummary',
  'decisionImpactSummary',
  'traceRefs',
]

export async function runPassiveObservationReview(
  options: PassiveObservationReviewRunnerOptions,
): Promise<{ outputPath: string; report: PassiveObservationReport }> {
  const initializeDatabase = options.initDatabase ?? initDatabase
  const close = options.closeDatabase ?? closeDatabase
  const createStore = options.createStore ?? (() => new EvaluationStore())
  const now = options.now ?? (() => new Date().toISOString())

  let store: PassiveObservationReviewStore | undefined
  let result: { outputPath: string; report: PassiveObservationReport } | undefined
  let primaryFailure: unknown

  try {
    await initializeDatabase()
    store = createStore()
    await store.init()

    const events = await store.queryStrict({ since: 0 }, { limit: QUERY_NO_LIMIT })
    const currentSnapshot = buildBehavioralObservationSnapshot(events)
    const persistedSnapshot = await readBehavioralObservationSnapshot(options.currentArtifactPath)
    assertSnapshotMatches(currentSnapshot, persistedSnapshot)

    const report = evaluatePassiveObservation(
      M57_PASSIVE_OBSERVATION_BASELINE,
      {
        sampleCount: currentSnapshot.sampleCount,
        traceCount: currentSnapshot.traceRefs.length,
        incompleteEvidenceCount: currentSnapshot.incompleteEvidenceCount,
        fingerprintDistribution: currentSnapshot.fingerprintDistribution,
        divergenceCount: currentSnapshot.divergenceSummary.detectedCount,
        decisionImpactCount: currentSnapshot.decisionImpactSummary.derivedCount,
      },
      now(),
    )

    const writer = new PassiveObservationReviewWriter(dirname(options.outputPath))
    const outputPath = await writer.write(report, basename(options.outputPath))
    result = { outputPath, report }
  } catch (error) {
    primaryFailure = error
  } finally {
    if (store) {
      try {
        await store.shutdown()
      } catch (error) {
        primaryFailure ??= error
      }
    }

    try {
      await close()
    } catch (error) {
      primaryFailure ??= error
    }
  }

  if (primaryFailure) {
    throw primaryFailure
  }

  if (!result) {
    throw new Error('Passive observation review completed without a result')
  }

  return result
}

export function resolvePassiveObservationArtifactPath(args: string[]): string {
  const explicit = args.find((arg) => arg.startsWith('--artifact='))
  if (explicit) {
    return resolve(explicit.slice('--artifact='.length))
  }

  return join(resolveBehavioralObservationUserDataDir(), 'evolution_workspace', 'pipeline_data', 'behavioral-observation.json')
}

export function resolvePassiveObservationOutputPath(args: string[]): string {
  const explicit = args.find((arg) => arg.startsWith('--output='))
  if (explicit) {
    return resolve(explicit.slice('--output='.length))
  }

  const snapshotDate = args.find((arg) => arg.startsWith('--snapshotDate='))?.slice('--snapshotDate='.length)
  const reportsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'reports', 'm57', 'observation')
  if (snapshotDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
      throw new Error('--snapshotDate must use YYYY-MM-DD')
    }
    return join(reportsDir, 'passive-observation', `${snapshotDate}.json`)
  }

  return join(reportsDir, 'passive-review.json')
}

async function readBehavioralObservationSnapshot(filePath: string): Promise<BehavioralObservationSnapshot> {
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as BehavioralObservationSnapshot
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid behavioral observation artifact: ${filePath}`)
  }
  return parsed
}

function assertSnapshotMatches(expected: BehavioralObservationSnapshot, actual: BehavioralObservationSnapshot): void {
  for (const field of SNAPSHOT_FIELDS) {
    if (!isDeepStrictEqual(expected[field], actual[field])) {
      throw new Error(`Behavioral artifact mismatch in field: ${field}`)
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  process.env.USER_DATA_DIR ??= resolveBehavioralObservationUserDataDir()

  const result = await runPassiveObservationReview({
    currentArtifactPath: resolvePassiveObservationArtifactPath(args),
    outputPath: resolvePassiveObservationOutputPath(args),
  })

  console.log(
    JSON.stringify(
      {
        outputPath: result.outputPath,
        decision: result.report.decision,
        triggers: result.report.triggers,
        sampleCount: result.report.current.sampleCount,
      },
      null,
      2,
    ),
  )
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
