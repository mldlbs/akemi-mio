/**
 * CapabilityPilotStore - persist M5.6.5 capability-led pilot gate run records.
 *
 * Writes to <rootDir>/<runId>/ and mirrors the latest run to <rootDir>/latest/,
 * mirroring the CapabilityMigrationArtifactStore layout under reports/m56/pilot/.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'

import type { CapabilityPilotRunRecord } from './CapabilityPilotDecisionGate'

export class CapabilityPilotStore {
  private readonly resolvedRootDir: string

  constructor(private readonly rootDir: string) {
    this.resolvedRootDir = resolve(rootDir)
  }

  saveRun(run: CapabilityPilotRunRecord): void {
    const runDir = this.resolveWithinRoot(run.runId)
    const latestDir = this.resolveWithinRoot('latest')
    const targets = [runDir, latestDir]

    for (const targetDir of targets) {
      this.writeJson(resolve(targetDir, 'pilot_run.json'), run)
    }
  }

  readLatest(): CapabilityPilotRunRecord | null {
    const filePath = this.resolveWithinRoot('latest', 'pilot_run.json')
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf-8')) as CapabilityPilotRunRecord
  }

  /** Read every persisted run (excluding the latest/ mirror), newest first. */
  readAll(): CapabilityPilotRunRecord[] {
    if (!existsSync(this.resolvedRootDir)) return []

    const runs: CapabilityPilotRunRecord[] = []
    for (const entry of readdirSync(this.resolvedRootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'latest') continue
      const filePath = resolve(this.resolvedRootDir, entry.name, 'pilot_run.json')
      if (!existsSync(filePath)) continue
      try {
        runs.push(JSON.parse(readFileSync(filePath, 'utf-8')) as CapabilityPilotRunRecord)
      } catch {
        // skip malformed run dirs; latest mirror is authoritative for recovery
      }
    }

    return runs.sort((a, b) => b.generatedAt - a.generatedAt)
  }

  private writeJson(filePath: string, value: unknown): void {
    const directory = dirname(filePath)
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true })
    }

    writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
  }

  private resolveWithinRoot(...segments: string[]): string {
    const candidatePath = resolve(this.resolvedRootDir, ...segments)
    const relativePath = relative(this.resolvedRootDir, candidatePath)

    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`Pilot artifact path resolves outside rootDir: ${candidatePath}`)
    }

    return candidatePath
  }
}
