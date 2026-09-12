import { log } from '@akemi-mio/core/logger/Logger'
import { getRawDb } from '@akemi-mio/core/db/connection'
import type {
  ExecutionGoal,
  ExecutionGoalInput,
  ExecutionGoalMethodologyStat,
  ExecutionGoalStats,
  ExecutionGoalStatus,
  Evidence,
} from './types'

let idCounter = 0

const TERMINAL_STATUSES: ReadonlySet<ExecutionGoalStatus> = new Set(['completed', 'abandoned'])

/**
 * ExecutionGoalStore — 执行级目标存储（M6.0 Execution Goal Binding）
 *
 * 与 cognitive.GoalEngine（使命级目标追踪）职责分离：
 * - GoalEngine：长期/使命目标，只有 title/progress，不参与单次任务执行；
 * - ExecutionGoalStore：单次用户请求的执行目标，携带 successCriteria、
 *   plan 绑定（复用 evolution DevPlan）与结构化 evidence。
 *
 * M6.0 只提供 schema + persistence + lifecycle，不接入执行循环。
 * M6.1 起由 EvidenceCollector / GoalEvaluator 消费。
 */
export class ExecutionGoalStore {
  create(input: ExecutionGoalInput): ExecutionGoal {
    const db = getRawDb()
    const id = `exec_goal_${Date.now()}_${++idCounter}`
    const now = Date.now()
    db.run(
      `INSERT INTO task_goals (id, session_id, objective, success_criteria, status, plan_id, methodology, current_step, evidence, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'planning', ?, ?, 0, '[]', ?, ?, NULL)`,
      [
        id,
        input.sessionId ?? null,
        input.objective,
        JSON.stringify(input.successCriteria ?? []),
        input.planId ?? null,
        input.methodology ?? null,
        now,
        now,
      ],
    )
    log('INFO', 'execution_goal_created', { id, objective: input.objective, sessionId: input.sessionId ?? null })
    return {
      id,
      sessionId: input.sessionId ?? null,
      objective: input.objective,
      successCriteria: input.successCriteria ?? [],
      status: 'planning',
      planId: input.planId ?? null,
      methodology: input.methodology ?? null,
      currentStep: 0,
      evidence: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
  }

  get(id: string): ExecutionGoal | null {
    const rows = getRawDb().exec('SELECT * FROM task_goals WHERE id = ?', [id])[0]
    if (!rows) return null
    return this.rowToGoal(rows.columns, rows.values[0])
  }

  listBySession(sessionId: string): ExecutionGoal[] {
    const rows = getRawDb().exec('SELECT * FROM task_goals WHERE session_id = ? ORDER BY created_at ASC', [sessionId])[0]
    if (!rows) return []
    return rows.values.map((v) => this.rowToGoal(rows.columns, v))
  }

  /** 所有未终结的执行目标（planning/executing/blocked），按创建时间正序。 */
  listActive(): ExecutionGoal[] {
    const rows = getRawDb().exec("SELECT * FROM task_goals WHERE status IN ('planning', 'executing', 'blocked') ORDER BY created_at ASC")[0]
    if (!rows) return []
    return rows.values.map((v) => this.rowToGoal(rows.columns, v))
  }

  /**
   * 状态迁移。completed/abandoned 为终态，不可再迁移。
   * 进入 completed 时记录 completed_at。
   */
  setStatus(id: string, status: ExecutionGoalStatus): boolean {
    const db = getRawDb()
    const goal = this.get(id)
    if (!goal) return false
    if (TERMINAL_STATUSES.has(goal.status)) {
      log('WARN', 'execution_goal_terminal_immutable', { id, status: goal.status, attempted: status })
      return false
    }
    const now = Date.now()
    if (status === 'completed') {
      db.run('UPDATE task_goals SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?', [status, now, now, id])
    } else {
      db.run('UPDATE task_goals SET status = ?, updated_at = ? WHERE id = ?', [status, now, id])
    }
    log('INFO', 'execution_goal_status_changed', { id, from: goal.status, to: status })
    return true
  }

  markExecuting(id: string): boolean {
    return this.setStatus(id, 'executing')
  }

  markBlocked(id: string): boolean {
    return this.setStatus(id, 'blocked')
  }

  complete(id: string): boolean {
    return this.setStatus(id, 'completed')
  }

  abandon(id: string): boolean {
    return this.setStatus(id, 'abandoned')
  }

  /** 追加一条证据（append-only）。允许对已终结目标追加最终判定证据。 */
  appendEvidence(id: string, evidence: Evidence): boolean {
    const goal = this.get(id)
    if (!goal) return false
    const next = [...goal.evidence, evidence]
    getRawDb().run('UPDATE task_goals SET evidence = ?, updated_at = ? WHERE id = ?', [JSON.stringify(next), Date.now(), id])
    log('DEBUG', 'execution_goal_evidence_appended', { id, type: evidence.type, tool: evidence.tool, step: evidence.step })
    return true
  }

  bindPlan(id: string, planId: string): boolean {
    const goal = this.get(id)
    if (!goal) return false
    getRawDb().run('UPDATE task_goals SET plan_id = ?, updated_at = ? WHERE id = ?', [planId, Date.now(), id])
    return true
  }

  /** 完成率统计（供 Evolution / 仪表盘分析真实完成率）。since 可选：只统计该时间戳之后创建的目标。 */
  getStats(since?: number): ExecutionGoalStats {
    const db = getRawDb()
    const where = since ? 'WHERE created_at >= ?' : ''
    const params = since ? [since] : []
    const rows = db.exec(`SELECT status, COUNT(*) AS c FROM task_goals ${where} GROUP BY status`, params)[0]
    const counts: Record<string, number> = {}
    if (rows) {
      const statusIdx = rows.columns.indexOf('status')
      const countIdx = rows.columns.indexOf('c')
      for (const row of rows.values) {
        counts[String(row[statusIdx])] = Number(row[countIdx] || 0)
      }
    }
    const total =
      (counts.planning || 0) + (counts.executing || 0) + (counts.blocked || 0) + (counts.completed || 0) + (counts.abandoned || 0)
    const closed = (counts.completed || 0) + (counts.blocked || 0) + (counts.abandoned || 0)
    return {
      total,
      active: (counts.planning || 0) + (counts.executing || 0),
      blocked: counts.blocked || 0,
      completed: counts.completed || 0,
      abandoned: counts.abandoned || 0,
      completionRate: closed > 0 ? (counts.completed || 0) / closed : 0,
    }
  }

  /** Completion-rate stats grouped by methodology. Optional since filters goals created after timestamp. */
  getMethodologyStats(since?: number): ExecutionGoalMethodologyStat[] {
    const db = getRawDb()
    const where = since ? 'WHERE created_at >= ?' : ''
    const params = since ? [since] : []
    const rows = db.exec(`SELECT methodology, status, COUNT(*) AS c FROM task_goals ${where} GROUP BY methodology, status`, params)[0]
    const buckets: Record<string, Record<string, number>> = {}
    if (rows) {
      const methodologyIdx = rows.columns.indexOf('methodology')
      const statusIdx = rows.columns.indexOf('status')
      const countIdx = rows.columns.indexOf('c')
      for (const row of rows.values) {
        const methodology = row[methodologyIdx] == null ? null : String(row[methodologyIdx])
        const status = String(row[statusIdx])
        const key = methodology ?? '__null__'
        buckets[key] ??= { methodology: 0, total: 0, completed: 0, blocked: 0, abandoned: 0 }
        buckets[key][status] = (buckets[key][status] || 0) + Number(row[countIdx] || 0)
      }
    }
    const result: ExecutionGoalMethodologyStat[] = []
    for (const [key, counts] of Object.entries(buckets)) {
      const completed = counts.completed || 0
      const blocked = counts.blocked || 0
      const abandoned = counts.abandoned || 0
      const total = (counts.planning || 0) + (counts.executing || 0) + blocked + completed + abandoned
      const closed = completed + blocked + abandoned
      result.push({
        methodology: key === '__null__' ? null : key,
        total,
        completed,
        blocked,
        abandoned,
        completionRate: closed > 0 ? completed / closed : 0,
      })
    }
    result.sort((a, b) => (a.methodology ?? '').localeCompare(b.methodology ?? ''))
    return result
  }

  advanceStep(id: string, step: number): boolean {
    const goal = this.get(id)
    if (!goal || step < 0) return false
    getRawDb().run('UPDATE task_goals SET current_step = ?, updated_at = ? WHERE id = ?', [step, Date.now(), id])
    return true
  }

  private rowToGoal(columns: string[], values: unknown[]): ExecutionGoal {
    const obj: Record<string, any> = {}
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = values[i]
    return {
      id: String(obj.id),
      sessionId: obj.session_id != null ? String(obj.session_id) : null,
      objective: String(obj.objective),
      successCriteria: parseJsonArray(obj.success_criteria),
      status: obj.status as ExecutionGoalStatus,
      planId: obj.plan_id != null ? String(obj.plan_id) : null,
      methodology: obj.methodology != null ? String(obj.methodology) : null,
      currentStep: Number(obj.current_step ?? 0),
      evidence: parseJsonArray(obj.evidence),
      createdAt: Number(obj.created_at),
      updatedAt: Number(obj.updated_at),
      completedAt: obj.completed_at != null ? Number(obj.completed_at) : null,
    }
  }
}

function parseJsonArray(raw: unknown): any[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
