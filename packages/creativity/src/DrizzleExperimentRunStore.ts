/**
 * DrizzleExperimentRunStore — 实验运行权威持久层（正向反馈闭环 P2）
 *
 * 终结 mechanism-registry.js:50 的"凭 id 构造 runs"：真实 ExperimentRun
 * 现落 SQLite `experiment_runs`（migration v52）。追加/更新用 id 主键；
 * listByIds 供晋级门与快照归因读取。
 *
 * 仓内专用（依赖 @akemi-mio/core/db/connection），不进 npm 构建。
 */

import { getRawDb, markDirty } from '@akemi-mio/core/db/connection'
import type { ExperimentRun, ExperimentAssignment, ExperimentOutcome } from './ExperimentRunStore'

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return fallback
  }
}

function rowToRun(obj: any): ExperimentRun {
  const run: ExperimentRun = {
    id: obj.id,
    hypothesisId: obj.hypothesis_id ?? undefined,
    candidateId: obj.candidate_id ?? undefined,
    baselineId: obj.baseline_id ?? undefined,
    assignment: obj.assignment as ExperimentAssignment,
    outcome: obj.outcome as ExperimentOutcome,
    metrics: parseJson(obj.metrics, {}),
    evidenceIds: parseJson<string[]>(obj.evidence_ids, []),
    baseSnapshotId: obj.base_snapshot_id ?? undefined,
    stale: obj.stale ? true : undefined,
    createdAt: Number(obj.created_at),
    completedAt: obj.completed_at != null ? Number(obj.completed_at) : undefined,
  }
  if (obj.feedback_snapshot_version != null) run.feedbackSnapshotVersion = String(obj.feedback_snapshot_version)
  if (obj.baseline_version != null) run.baselineVersion = String(obj.baseline_version)
  if (obj.candidate_version != null) run.candidateVersion = String(obj.candidate_version)
  const testResults = parseJson<Record<string, number | boolean | string> | null>(obj.test_results, null)
  if (testResults) run.testResults = testResults
  const regressionResults = parseJson<Record<string, number | boolean | string> | null>(obj.regression_results, null)
  if (regressionResults) run.regressionResults = regressionResults
  if (obj.decision != null) run.decision = obj.decision as ExperimentRun['decision']
  return run
}

export class DrizzleExperimentRunStore {
  append(run: ExperimentRun): void {
    const db = getRawDb()
    db.run(
      `INSERT OR REPLACE INTO experiment_runs
        (id, hypothesis_id, candidate_id, baseline_id, assignment, outcome, metrics, evidence_ids,
         base_snapshot_id, stale, created_at, completed_at, feedback_snapshot_version,
         baseline_version, candidate_version, test_results, regression_results, decision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.hypothesisId ?? null,
        run.candidateId ?? null,
        run.baselineId ?? null,
        run.assignment,
        run.outcome,
        JSON.stringify(run.metrics ?? {}),
        JSON.stringify(run.evidenceIds ?? []),
        run.baseSnapshotId ?? null,
        run.stale ? 1 : 0,
        run.createdAt,
        run.completedAt ?? null,
        run.feedbackSnapshotVersion ?? null,
        run.baselineVersion ?? null,
        run.candidateVersion ?? null,
        run.testResults ? JSON.stringify(run.testResults) : null,
        run.regressionResults ? JSON.stringify(run.regressionResults) : null,
        run.decision ?? null,
      ],
    )
    markDirty()
  }

  list(options?: { hypothesisId?: string; feedbackSnapshotVersion?: string; limit?: number }): ExperimentRun[] {
    const db = getRawDb()
    let sql = 'SELECT * FROM experiment_runs'
    const clauses: string[] = []
    const params: any[] = []
    if (options?.hypothesisId) {
      clauses.push('hypothesis_id = ?')
      params.push(options.hypothesisId)
    }
    if (options?.feedbackSnapshotVersion) {
      clauses.push('feedback_snapshot_version = ?')
      params.push(options.feedbackSnapshotVersion)
    }
    if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ')
    sql += ' ORDER BY created_at ASC'
    if (options?.limit) sql += ` LIMIT ${options.limit}`
    const result = db.exec(sql, params)
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    const columns = result[0].columns
    return result[0].values.map((values: any[]) => {
      const obj: any = {}
      for (let i = 0; i < columns.length; i++) obj[columns[i]] = values[i]
      return rowToRun(obj)
    })
  }

  listByIds(ids: readonly string[]): ExperimentRun[] {
    if (ids.length === 0) return []
    const db = getRawDb()
    const placeholders = ids.map(() => '?').join(',')
    const result = db.exec(`SELECT * FROM experiment_runs WHERE id IN (${placeholders})`, [...ids])
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    const columns = result[0].columns
    const runs = result[0].values.map((values: any[]) => {
      const obj: any = {}
      for (let i = 0; i < columns.length; i++) obj[columns[i]] = values[i]
      return rowToRun(obj)
    })
    const byId = new Map(runs.map((r) => [r.id, r]))
    return ids.map((id) => byId.get(id)).filter((r): r is ExperimentRun => !!r)
  }

  count(): number {
    const db = getRawDb()
    const r = db.exec('SELECT COUNT(*) FROM experiment_runs')
    return r && r.length > 0 && r[0].values.length > 0 ? Number(r[0].values[0][0]) : 0
  }
}
