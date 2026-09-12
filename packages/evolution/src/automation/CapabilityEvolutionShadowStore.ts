import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { log } from '@akemi-mio/core/logger/Logger'
import type { CapabilityEvolutionShadowRun } from './types'

const STORE_FILE = 'capability_evolution_shadow_runs.json'

export class CapabilityEvolutionShadowStore {
  private readonly storePath: string
  private readonly maxRuns: number

  constructor(persistDir: string, maxRuns: number = 50) {
    this.storePath = join(persistDir, STORE_FILE)
    this.maxRuns = maxRuns
  }

  save(run: CapabilityEvolutionShadowRun): void {
    const runs = this.getAll()
    runs.push(run)
    const trimmed = runs.slice(-this.maxRuns)

    try {
      const dir = dirname(this.storePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.storePath, JSON.stringify(trimmed, null, 2), 'utf-8')
    } catch (error: any) {
      log('WARN', 'capability_shadow_store_save_failed', { error: error.message })
    }
  }

  /**
   * Replace the full set of stored runs (used for data-quality remediation).
   * Keeps at most maxRuns entries.
   */
  replaceAll(runs: CapabilityEvolutionShadowRun[]): void {
    const trimmed = runs.slice(-this.maxRuns)

    try {
      const dir = dirname(this.storePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.storePath, JSON.stringify(trimmed, null, 2), 'utf-8')
    } catch (error: any) {
      log('WARN', 'capability_shadow_store_replace_failed', { error: error.message })
    }
  }

  getLatest(): CapabilityEvolutionShadowRun | null {
    const runs = this.getAll()
    return runs.length > 0 ? runs[runs.length - 1] : null
  }

  getAll(): CapabilityEvolutionShadowRun[] {
    try {
      if (!existsSync(this.storePath)) return []
      const raw = readFileSync(this.storePath, 'utf-8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as CapabilityEvolutionShadowRun[]) : []
    } catch (error: any) {
      log('WARN', 'capability_shadow_store_load_failed', { error: error.message })
      return []
    }
  }
}
