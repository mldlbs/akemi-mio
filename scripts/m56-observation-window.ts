import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface M56ObservationRecord {
  id: string
  toolName: string
  capability?: string
  timestamp: number
}

export interface M56CapabilityMap {
  [toolName: string]: string[]
}

export interface M56ObservationSnapshot {
  timestamp: string
  since: string
  events: number
  taggedEvents: number
  coverage: number
  capabilities: Record<string, number>
  enrichmentGap: number
  catalogGap: number
  sourceMismatch: number
}

export interface BuildObservationOptions {
  now: Date
  sinceMs: number
}

export function buildObservationSnapshot(
  records: M56ObservationRecord[],
  capabilityMap: M56CapabilityMap,
  options: BuildObservationOptions,
): M56ObservationSnapshot {
  const inWindow = records.filter((r) => r.timestamp >= options.sinceMs)
  let taggedEvents = 0
  let enrichmentGap = 0
  let catalogGap = 0
  let sourceMismatch = 0
  const capabilities: Record<string, number> = {}

  for (const record of inWindow) {
    const allowedCapabilities = capabilityMap[record.toolName]
    if (!allowedCapabilities) {
      catalogGap++
      continue
    }
    if (record.capability === undefined) {
      enrichmentGap++
      continue
    }
    if (allowedCapabilities && !allowedCapabilities.includes(record.capability)) {
      sourceMismatch++
      continue
    }
    taggedEvents++
    capabilities[record.capability] = (capabilities[record.capability] ?? 0) + 1
  }

  const events = inWindow.length
  return {
    timestamp: options.now.toISOString(),
    since: new Date(options.sinceMs).toISOString(),
    events,
    taggedEvents,
    coverage: events === 0 ? 0 : taggedEvents / events,
    capabilities,
    enrichmentGap,
    catalogGap,
    sourceMismatch,
  }
}

export interface PersistObservationResult {
  latestPath: string
  historyPath: string
  snapshotPath: string
}

export function persistObservationSnapshot(
  outDir: string,
  snapshot: M56ObservationSnapshot,
): PersistObservationResult {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true })
  }

  const latestPath = join(outDir, 'latest.json')
  const historyPath = join(outDir, 'history.jsonl')
  const snapshotPath = join(outDir, snapshot.timestamp.replace(/:/g, '-') + '.json')

  const pretty = JSON.stringify(snapshot, null, 2)
  writeFileSync(latestPath, pretty, 'utf8')
  writeFileSync(snapshotPath, pretty, 'utf8')
  writeFileSync(historyPath, JSON.stringify(snapshot) + '\n', 'utf8')

  return { latestPath, historyPath, snapshotPath }
}
