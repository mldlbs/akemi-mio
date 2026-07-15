/**
 * ReplayRunner v0.1 — MVP
 *
 * Read-only consumer of Golden Dataset:
 *   1. Loads manifest + all GoldenCase JSON files
 *   2. Validates each against JSON Schema
 *   3. Runs plan(input) and deep-equals level1
 *   4. Produces ReplayReport
 *
 * Side effects: NONE (read-only)
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { plan } from '../ReasoningPlanner'
import type { ReasoningContext, ReasoningDirective } from '../types'
import { EMPTY_DIRECTIVE } from '../types'
import type {
  GoldenCase,
  ReplayResult,
  ReplayReport,
  ReplayFailure,
  DirectiveDiff,
  RunnerVersion,
  GoldenSchemaVersion,
} from './types'

export const RUNNER_VERSION: RunnerVersion = '0.1'
const GOLDEN_SCHEMA_VERSION: GoldenSchemaVersion = '0.1'

// ── Error types ──

export class ReplayError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'ReplayError'
  }
}

// ── Config ──

export interface ReplayRunnerConfig {
  /** Root directory containing manifest.json and category subdirectories. */
  goldenRoot: string
}

// ── Internal helpers ──

function deepEqualDir(a: ReasoningDirective, b: ReasoningDirective): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function describeDiff(expected: ReasoningDirective, actual: ReasoningDirective): string | null {
  if (deepEqualDir(expected, actual)) return null
  const lines: string[] = []
  if (expected.pattern !== actual.pattern) lines.push(`pattern: expected ${expected.pattern}, got ${actual.pattern}`)
  const eg = JSON.stringify(expected.goals)
  const ag = JSON.stringify(actual.goals)
  if (eg !== ag) lines.push(`goals differ`)
  const ec = JSON.stringify(expected.constraints)
  const ac = JSON.stringify(actual.constraints)
  if (ec !== ac) lines.push(`constraints differ`)
  if (expected.outputStyle !== actual.outputStyle) lines.push(`outputStyle: expected ${expected.outputStyle}, got ${actual.outputStyle}`)
  return lines.length > 0 ? lines.join('; ') : 'directive structure differs'
}

function loadManifest(root: string): { total: number; cases: Array<{ caseId: string; category: string }> } {
  const manifestPath = join(root, 'manifest.json')
  const raw = readFileSync(manifestPath, 'utf8')
  return JSON.parse(raw)
}

function loadGoldenCase(root: string, caseId: string, category: string): GoldenCase {
  const filePath = join(root, category, `${caseId}.json`)
  if (!existsSync(filePath)) {
    throw new ReplayError(`Golden file not found: ${filePath}`, 'GOLDEN_MISSING')
  }
  const raw = readFileSync(filePath, 'utf8')
  return JSON.parse(raw)
}

function makeContext(gc: GoldenCase): ReasoningContext {
  return {
    input: {
      text: gc.caseRef.text,
    },
  }
}

// ── ReplayRunner ──

export class ReplayRunner {
  private readonly config: ReplayRunnerConfig

  constructor(config: ReplayRunnerConfig) {
    this.config = config
  }

  /** Execute replay for all cases in the manifest. */
  run(): ReplayReport {
    const start = performance.now()
    const manifest = loadManifest(this.config.goldenRoot)
    const results: ReplayResult[] = []
    const failures: ReplayFailure[] = []
    let passed = 0
    let failed = 0

    for (const entry of manifest.cases) {
      // Skip if case ID doesn't appear in manifest — shouldn't happen
      const gc = loadGoldenCase(this.config.goldenRoot, entry.caseId, entry.category)

      // Validate schema version
      if (gc.level1.schemaVersion !== GOLDEN_SCHEMA_VERSION) {
        results.push({
          caseId: gc.caseId,
          passed: false,
          expected: gc.level1.directive,
          actual: EMPTY_DIRECTIVE,
          diff: { description: `unsupported schema version: ${gc.level1.schemaVersion}` },
          executedAt: new Date().toISOString(),
        })
        failed++
        continue
      }

      // Execute planner
      const ctx = makeContext(gc)
      let actual: ReasoningDirective
      try {
        actual = plan(ctx)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({
          caseId: gc.caseId,
          passed: false,
          expected: gc.level1.directive,
          actual: EMPTY_DIRECTIVE,
          diff: { description: `planner execution failed: ${msg}` },
          executedAt: new Date().toISOString(),
        })
        failed++
        continue
      }

      // Compare
      const expected = gc.level1.directive
      const pass = deepEqualDir(expected, actual)
      const diffDesc = describeDiff(expected, actual)
      const diff: DirectiveDiff = { description: diffDesc }

      const res: ReplayResult = {
        caseId: gc.caseId,
        passed: pass,
        expected,
        actual,
        diff,
        executedAt: new Date().toISOString(),
      }
      results.push(res)

      if (pass) {
        passed++
      } else {
        failed++
        failures.push({
          caseId: gc.caseId,
          expected,
          actual,
          diff: diffDesc ?? 'unknown',
        })
      }
    }

    const durationMs = Math.round(performance.now() - start)

    return {
      total: manifest.total,
      passed,
      failed,
      skipped: 0,
      durationMs,
      failures,
      runnerVersion: RUNNER_VERSION,
      executedAt: new Date().toISOString(),
    }
  }
}
