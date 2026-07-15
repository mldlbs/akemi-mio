import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { plan } from '../ReasoningPlanner'
import { EMPTY_DIRECTIVE } from '../types'
import type { GoldenCase, ReplayReport, ReplayFailure, RunnerVersion, GoldenSchemaVersion } from './types'

export const RUNNER_VERSION: RunnerVersion = '0.1'
const GSCHEMA: GoldenSchemaVersion = '0.1'

export class ReplayError extends Error {
  constructor(
    m: string,
    public readonly code: string,
  ) {
    super(m)
    this.name = 'ReplayError'
  }
}
export interface ReplayRunnerConfig {
  goldenRoot: string
}

function tryLoad(root: string, id: string, cat: string): { ok: true; gc: GoldenCase } | { ok: false; error: string } {
  const fp = join(root, cat, id + '.json')
  if (!existsSync(fp)) return { ok: false, error: 'nf: ' + fp }
  try {
    const d = JSON.parse(readFileSync(fp, 'utf8'))
    if (!d || typeof d !== 'object' || !d.caseId || !d.level1) return { ok: false, error: 'inv: ' + id }
    return { ok: true, gc: d }
  } catch (e) {
    return { ok: false, error: 'ps: ' + id }
  }
}

export class ReplayRunner {
  constructor(private c: ReplayRunnerConfig) {}
  run(): ReplayReport {
    const s = performance.now()
    const M = JSON.parse(readFileSync(join(this.c.goldenRoot, 'manifest.json'), 'utf8'))
    const failures: ReplayFailure[] = []
    let p = 0,
      f = 0
    for (const e of M.cases) {
      const r = tryLoad(this.c.goldenRoot, e.caseId, e.category)
      if (!r.ok) {
        f++
        failures.push({ caseId: e.caseId, expected: EMPTY_DIRECTIVE, actual: EMPTY_DIRECTIVE, diff: r.error })
        continue
      }
      const gc = r.gc
      if (gc.level1.schemaVersion !== GSCHEMA) {
        f++
        failures.push({ caseId: gc.caseId, expected: gc.level1.directive, actual: EMPTY_DIRECTIVE, diff: 'usv' })
        continue
      }
      const a = plan({ input: { text: gc.caseRef.text } })
      const x = gc.level1.directive
      if (JSON.stringify(x) === JSON.stringify(a)) {
        p++
      } else {
        f++
        failures.push({
          caseId: gc.caseId,
          expected: x,
          actual: a,
          diff: x.pattern !== a.pattern ? 'p: ' + x.pattern + ' vs ' + a.pattern : 'd',
        })
      }
    }
    return {
      total: M.total,
      passed: p,
      failed: f,
      skipped: 0,
      durationMs: Math.round(performance.now() - s),
      failures,
      runnerVersion: RUNNER_VERSION,
      executedAt: new Date().toISOString(),
    }
  }
}
