#!/usr/bin/env tsx
import { fileURLToPath } from 'url'
import { join, resolve } from 'path'
import { homedir } from 'os'

import { closeDatabase, initDatabase } from '@akemi-mio/core/db/connection'
import {
  BehavioralObservationWriter,
  buildBehavioralObservationSnapshot,
  type BehavioralObservationSnapshot,
} from '@akemi-mio/core/core/evaluation/BehavioralObservationWriter'
import { EvaluationStore, QUERY_NO_LIMIT } from '@akemi-mio/core/core/evaluation/EvaluationStore'
import type { EvaluationEvent } from '@akemi-mio/core/core/evaluation/types'

export interface BehavioralObservationStore {
  init(): Promise<void>
  queryStrict(range: { since: number; until?: number; type?: string }, options?: { limit?: number }): Promise<EvaluationEvent[]>
  shutdown(): Promise<void>
}

export interface BehavioralObservationRunnerDependencies {
  initDatabase?: () => Promise<void>
  closeDatabase?: () => void | Promise<void>
  createStore?: () => BehavioralObservationStore
  writeSnapshot?: (persistDir: string, snapshot: BehavioralObservationSnapshot) => Promise<string>
}

export function resolveBehavioralObservationUserDataDir(): string {
  if (process.env.USER_DATA_DIR) {
    return process.env.USER_DATA_DIR
  }

  if (process.env.APPDATA) {
    return join(process.env.APPDATA, 'akemi-mio')
  }

  return join(homedir(), 'AppData', 'Roaming', 'akemi-mio')
}

export function resolveBehavioralObservationPersistDir(args: string[]): string {
  const explicit = args.find((arg) => arg.startsWith('--persistDir='))
  if (explicit) {
    return resolve(explicit.slice('--persistDir='.length))
  }

  return join(resolveBehavioralObservationUserDataDir(), 'evolution_workspace', 'pipeline_data')
}

export async function runBehavioralObservation(
  persistDir: string,
  dependencies: BehavioralObservationRunnerDependencies = {},
): Promise<string> {
  const initializeDatabase = dependencies.initDatabase ?? initDatabase
  const close = dependencies.closeDatabase ?? closeDatabase
  const writeSnapshot = dependencies.writeSnapshot ?? ((directory, snapshot) => new BehavioralObservationWriter(directory).write(snapshot))
  let store: BehavioralObservationStore | undefined
  let outputPath = ''
  let hasFailure = false
  let primaryFailure: unknown

  const recordFailure = (error: unknown): void => {
    if (!hasFailure) {
      hasFailure = true
      primaryFailure = error
    }
  }

  try {
    store = dependencies.createStore?.() ?? new EvaluationStore()
    await initializeDatabase()
    await store.init()
    const events = await store.queryStrict({ since: 0 }, { limit: QUERY_NO_LIMIT })
    const snapshot = buildBehavioralObservationSnapshot(events)
    outputPath = await writeSnapshot(persistDir, snapshot)
  } catch (error) {
    recordFailure(error)
  } finally {
    if (store) {
      try {
        await store.shutdown()
      } catch (error) {
        recordFailure(error)
      }
    }

    try {
      await close()
    } catch (error) {
      recordFailure(error)
    }
  }

  if (hasFailure) {
    throw primaryFailure
  }

  return outputPath
}

async function main(): Promise<void> {
  process.env.USER_DATA_DIR ??= resolveBehavioralObservationUserDataDir()
  const persistDir = resolveBehavioralObservationPersistDir(process.argv.slice(2))
  const outputPath = await runBehavioralObservation(persistDir)
  console.log(outputPath)
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
