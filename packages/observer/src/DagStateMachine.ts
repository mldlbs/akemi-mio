import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { log } from './logger'
import type { TaskState, DagStateFile } from './types'

// ── 状态转移表 ──────────────────────────────────────────────
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  INIT: ['COLLECTED', 'FAILED'],
  COLLECTED: ['TOPIC_SELECTED', 'FAILED'],
  TOPIC_SELECTED: ['RESEARCHING', 'FAILED'],
  RESEARCHING: ['ANALYZING', 'FAILED'],
  ANALYZING: ['WRITING', 'FAILED'],
  WRITING: ['STORED', 'FAILED'],
  STORED: ['COMPLETED'],
  COMPLETED: [],
  FAILED: ['INIT'],
}

const MAX_ATTEMPTS = 3

// ── 辅助 ────────────────────────────────────────────────────
function todayTaskId(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `dag_${y}${m}${day}`
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ── DagStateMachine ─────────────────────────────────────────
export class DagStateMachine {
  private dagDir: string

  constructor(observerBaseDir: string) {
    this.dagDir = resolve(observerBaseDir, 'dag')
    ensureDir(this.dagDir)
  }

  /** 创建今天的 DAG 任务。如果已有未完成的任务则返回它。 */
  createTask(): DagStateFile {
    const taskId = todayTaskId()
    const existing = this.readState(taskId)
    if (existing) {
      if (existing.state === 'COMPLETED') {
        log('INFO', 'dag_already_completed', { taskId })
        return existing
      }
      // 未完成 — 如果 crash 后恢复，从当前状态继续
      log('INFO', 'dag_resume', { taskId, state: existing.state })
      return existing
    }

    const now = new Date().toISOString()
    const dag: DagStateFile = {
      taskId,
      state: 'INIT',
      attempt: 1,
      maxAttempts: MAX_ATTEMPTS,
      startedAt: now,
      timeline: [{ state: 'INIT', at: now }],
      data: {},
    }
    this.persist(dag)
    log('INFO', 'dag_created', { taskId })
    return dag
  }

  /** 尝试状态转移。返回更新后的 DAG 文件；如果转移非法则抛出。 */
  transition(dag: DagStateFile, to: TaskState, data?: Partial<DagStateFile['data']>): DagStateFile {
    const valid = TRANSITIONS[dag.state]
    if (!valid.includes(to)) {
      throw new Error(`DAG 非法转移: ${dag.state} → ${to} (taskId=${dag.taskId})`)
    }

    const now = new Date().toISOString()
    dag.state = to
    dag.timeline.push({ state: to, at: now })
    if (data) {
      dag.data = { ...dag.data, ...data }
    }

    this.persist(dag)
    log('INFO', 'dag_transition', { taskId: dag.taskId, state: to })
    return dag
  }

  /** 标记失败（带错误信息）。自动处理重试：attempt < max 时回退 INIT。 */
  failTask(dag: DagStateFile, error: { message: string; phase: string }): DagStateFile {
    const now = new Date().toISOString()
    dag.error = { ...error, at: now }
    dag.timeline.push({ state: 'FAILED', at: now, data: error })
    dag.state = 'FAILED'
    this.persist(dag)
    log('WARN', 'dag_failed', { taskId: dag.taskId, error: error.message, attempt: dag.attempt })

    if (dag.attempt < dag.maxAttempts) {
      dag.attempt++
      dag.timeline.push({ state: 'INIT', at: new Date().toISOString(), data: { retry: dag.attempt } })
      dag.state = 'INIT'
      dag.error = undefined
      this.persist(dag)
      log('INFO', 'dag_retry', { taskId: dag.taskId, attempt: dag.attempt })
    }

    return dag
  }

  /** 读取指定 task 的 DAG 文件 */
  readState(taskId: string): DagStateFile | null {
    const file = resolve(this.dagDir, `${taskId}.json`)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      return null
    }
  }

  /** 获取今天任务 */
  getTodayTask(): DagStateFile | null {
    return this.readState(todayTaskId())
  }

  /** 判断今天是否有已完成的任务 */
  isTodayCompleted(): boolean {
    const task = this.getTodayTask()
    return task !== null && task.state === 'COMPLETED'
  }

  /** 获取最近 N 天的所有 DAG 文件摘要 */
  getRecentSummary(days = 7): { taskId: string; state: TaskState; attempt: number }[] {
    const all: { taskId: string; state: TaskState; attempt: number }[] = []
    const d = new Date()
    for (let i = 0; i < days; i++) {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      const taskId = `dag_${y}${m}${day}`
      const task = this.readState(taskId)
      if (task) all.push({ taskId: task.taskId, state: task.state, attempt: task.attempt })
      d.setDate(d.getDate() - 1)
    }
    return all
  }

  /** 获取可重试的失败任务 */
  getRetryableTasks(): DagStateFile[] {
    if (!existsSync(this.dagDir)) return []
    const files = readdirSync(this.dagDir).filter((f) => f.endsWith('.json'))
    const retryable: DagStateFile[] = []
    for (const f of files) {
      try {
        const dag: DagStateFile = JSON.parse(readFileSync(resolve(this.dagDir, f), 'utf-8'))
        if (dag.state === 'FAILED' && dag.attempt < dag.maxAttempts) {
          retryable.push(dag)
        }
      } catch {}
    }
    return retryable
  }

  // ── private ──────────────────────────────────────────────
  private persist(dag: DagStateFile): void {
    const file = resolve(this.dagDir, `${dag.taskId}.json`)
    writeFileSync(file, JSON.stringify(dag, null, 2), 'utf-8')
  }
}
