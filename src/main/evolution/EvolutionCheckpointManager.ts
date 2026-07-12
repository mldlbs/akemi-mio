/**
 * EvolutionCheckpointManager — 自进化系统检查点管理器
 *
 * 职责：
 * 1. 在每个进化周期关键阶段创建 git 快照 + 数据库记录
 * 2. 提供中断恢复能力：启动时检测未完成检查点并恢复/回滚
 * 3. 注册进程信号处理（SIGINT/SIGTERM），确保任意中断都能保留现场
 *
 * 检查点生命周期：
 *   pre_cycle → pre_pipeline → in_collect → pre_execute → post_execute → pre_commit
 *   每个阶段创建后可查询状态，支持回滚到任意已完成检查点。
 *
 * 与现有组件关系：
 * - 使用 getRawDb() 写入 evolution_checkpoints 表
 * - 使用 EvolutionGitOps 进行 git stash/snapshot
 * - 被 SelfEvolutionService.runAnalysisCycle() 消费
 */

import { log } from '../logger/Logger'
import { getRawDb } from '../db/connection'
import { execAsync } from '../utils/async'
import { EvolutionGitOps } from './EvolutionGitOps'
import type { EvolutionCheckpointPhase, EvolutionCheckpointStatus } from '../db/schema/evolution_checkpoints'

// =============================================================================
// 检查点数据库行接口
// =============================================================================

interface CheckpointRow {
  id: string
  cycle_id: string
  phase: string
  status: string
  git_snapshot_branch: string | null
  stash_message: string | null
  target_files: string | null
  git_head_hash: string | null
  step_data: string | null
  created_at: number
  completed_at: number | null
  error: string | null
}

// =============================================================================
// 检查点上下文（供外部查询）
// =============================================================================

export interface CheckpointContext {
  id: string
  cycleId: string
  phase: EvolutionCheckpointPhase
  status: EvolutionCheckpointStatus
  gitSnapshotBranch: string | null
  targetFiles: string[]
  stepData: Record<string, unknown> | null
  createdAt: number
  completedAt: number | null
  error: string | null
}

export interface UnfinishedCheckpoint extends CheckpointContext {
  elapsedMs: number
}

// =============================================================================
// 检查点管理器
// =============================================================================

export class EvolutionCheckpointManager {
  private gitOps: EvolutionGitOps
  /** 当前活跃检查点 ID（用于信号处理时快速标记中断） */
  private currentCheckpointId: string | null = null
  /** 当前周期 ID（用于信号处理时标记该周期下所有未完成检查点） */
  private currentCycleId: string | null = null
  /** 是否已注册信号处理 */
  private signalsRegistered = false

  /** 信号处理已触发的标记，防止重复保存 */
  private signalFired = false

  constructor() {
    this.gitOps = new EvolutionGitOps()
  }

  // ===========================================================================
  // 公共 API
  // ===========================================================================

  /**
   * 创建检查点并执行 git stash/snapshot。
   *
   * @param cycleId - 所属进化周期 ID
   * @param phase   - 阶段名称
   * @param targetFiles - 受影响的文件列表（可选）
   * @param stepData    - 步骤元数据（可选，如 { planId, stepIndex, problemIds }）
   * @returns 检查点 ID，失败时返回 null
   */
  async beginCheckpoint(
    cycleId: string,
    phase: EvolutionCheckpointPhase,
    targetFiles?: string[],
    stepData?: Record<string, unknown>,
  ): Promise<string | null> {
    const checkpointId = `chk_${cycleId}_${phase}_${Date.now()}`
    const now = Date.now()

    // 1. 执行 git 状态保存
    const gitResult = await this.saveGitState(cycleId, phase)

    // 2. 写入数据库
    const db = tryDb()
    if (!db) {
      log('WARN', 'checkpoint_db_unavailable', { checkpointId, phase })
      return null
    }

    try {
      db.run(
        `INSERT INTO evolution_checkpoints (id, cycle_id, phase, status, git_snapshot_branch, stash_message, target_files, git_head_hash, step_data, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        [
          checkpointId,
          cycleId,
          phase,
          gitResult.snapshotBranch ?? null,
          gitResult.stashMessage ?? null,
          targetFiles ? JSON.stringify(targetFiles) : null,
          gitResult.headHash ?? null,
          stepData ? JSON.stringify(stepData) : null,
          now,
        ],
      )
    } catch (err: any) {
      log('ERROR', 'checkpoint_insert_failed', { checkpointId, error: String(err) })
      return null
    }

    // 3. 更新为 in_progress
    db.run('UPDATE evolution_checkpoints SET status = ? WHERE id = ?', ['in_progress', checkpointId])

    // 4. 记录当前检查点（供信号处理使用）
    this.currentCheckpointId = checkpointId
    this.currentCycleId = cycleId

    log('INFO', 'checkpoint_began', { cycleId, phase, checkpointId, snapshotBranch: gitResult.snapshotBranch })
    return checkpointId
  }

  /**
   * 标记检查点为成功完成。
   */
  completeCheckpoint(checkpointId: string): void {
    const db = tryDb()
    if (!db) return

    try {
      db.run('UPDATE evolution_checkpoints SET status = ?, completed_at = ? WHERE id = ?', [
        'completed',
        Date.now(),
        checkpointId,
      ])
      log('INFO', 'checkpoint_completed', { checkpointId })

      // 只有当前检查点匹配时才清除
      if (this.currentCheckpointId === checkpointId) {
        this.currentCheckpointId = null
      }
    } catch (err: any) {
      log('WARN', 'checkpoint_complete_failed', { checkpointId, error: String(err) })
    }
  }

  /**
   * 标记检查点为失败（带错误信息），并可选执行回滚。
   */
  async failCheckpoint(checkpointId: string, error: string, shouldRollback = false): Promise<void> {
    const db = tryDb()
    if (!db) return

    try {
      db.run('UPDATE evolution_checkpoints SET status = ?, completed_at = ?, error = ? WHERE id = ?', [
        'failed',
        Date.now(),
        error,
        checkpointId,
      ])
      log('ERROR', 'checkpoint_failed', { checkpointId, error })

      if (this.currentCheckpointId === checkpointId) {
        this.currentCheckpointId = null
      }

      if (shouldRollback) {
        await this.rollbackCheckpoint(checkpointId)
      }
    } catch (err: any) {
      log('WARN', 'checkpoint_fail_failed', { checkpointId, error: String(err) })
    }
  }

  /**
   * 回滚到指定检查点（恢复 git 状态）。
   */
  async rollbackCheckpoint(checkpointId: string): Promise<boolean> {
    const row = this.getCheckpointRow(checkpointId)
    if (!row) {
      log('WARN', 'checkpoint_rollback_not_found', { checkpointId })
      return false
    }

    try {
      // 优先使用 branch 回滚
      if (row.git_snapshot_branch) {
        const ok = await this.gitOps.rollbackToSnapshot(row.git_snapshot_branch)
        if (!ok) {
          log('ERROR', 'checkpoint_rollback_snapshot_failed', { checkpointId })
          return false
        }
      } else {
        log('INFO', 'checkpoint_rollback_no_snapshot', { checkpointId, phase: row.phase })
        return false
      }

      const db = tryDb()
      if (db) {
        db.run('UPDATE evolution_checkpoints SET status = ?, completed_at = ? WHERE id = ?', [
          'rolled_back',
          Date.now(),
          checkpointId,
        ])
      }
      log('INFO', 'checkpoint_rolled_back', { checkpointId })
      return true
    } catch (err: any) {
      log('ERROR', 'checkpoint_rollback_error', { checkpointId, error: String(err) })
      return false
    }
  }

  // ===========================================================================
  // 启动恢复
  // ===========================================================================

  /**
   * 在服务启动时调用，检测并处理未完成的检查点。
   *
   * @param activeCycleId - 当前周期的 cycleId（可选），只恢复特定周期
   * @returns 恢复摘要文本，无未完成检查点时返回空字符串
   */
  async recoverOnStartup(activeCycleId?: string): Promise<string> {
    const unfinished = this.findUnfinishedCheckpoints(activeCycleId)
    if (unfinished.length === 0) return ''

    const lines: string[] = [
      '【自进化检查点恢复】',
      `检测到 ${unfinished.length} 个未完成的检查点，正在尝试恢复...`,
      '',
    ]

    for (const cp of unfinished) {
      const elapsed = (Date.now() - cp.createdAt) / 1000
      lines.push(`- [${cp.phase}] ${cp.id}（${elapsed.toFixed(0)}s 前中断）`)

      // 如果是 pre_cycle/pre_pipeline 阶段且有 snapshot，回滚
      if (cp.gitSnapshotBranch && (cp.phase === 'pre_cycle' || cp.phase === 'pre_pipeline')) {
        const ok = await this.rollbackCheckpoint(cp.id)
        lines.push(ok ? `  → 已回滚到快照 ${cp.gitSnapshotBranch}` : `  → 回滚失败`)
      } else if (cp.gitSnapshotBranch) {
        // 后续阶段：标记为 interrupted，不清除工作区（避免丢失用户修改）
        this.markInterrupted(cp.id)
        lines.push(`  → 已标记为中断，工作区保持现状（快照 ${cp.gitSnapshotBranch} 可用）`)
      } else {
        this.markInterrupted(cp.id)
        lines.push(`  → 已标记为中断（无 git 快照，工作区保持现状）`)
      }
    }

    lines.push('', '恢复完成。')
    const summary = lines.join('\n')
    log('INFO', 'checkpoint_recovery_done', { count: unfinished.length })
    return summary
  }

  // ===========================================================================
  // 信号处理
  // ===========================================================================

  /**
   * 注册进程信号处理（SIGINT / SIGTERM / beforeExit）。
   * 在任意中断时保存当前检查点状态到数据库。
   * 多次调用安全（只注册一次）。
   */
  registerSignalHandlers(): void {
    if (this.signalsRegistered) return
    this.signalsRegistered = true

    const handler = (signal: string) => {
      if (this.signalFired) return
      this.signalFired = true

      log('INFO', 'checkpoint_signal_received', { signal })

      // 标记当前检查点为 interrupted
      if (this.currentCheckpointId) {
        try {
          const db = tryDb()
          if (db) {
            db.run('UPDATE evolution_checkpoints SET status = ?, completed_at = ? WHERE id = ?', [
              'interrupted',
              Date.now(),
              this.currentCheckpointId,
            ])
            log('INFO', 'checkpoint_marked_interrupted', { checkpointId: this.currentCheckpointId })
          }
        } catch (err) {
          log('WARN', 'checkpoint_signal_save_failed', { error: String(err) })
        }
      }

      // 标记整个周期下所有其他 in_progress/pending 检查点
      if (this.currentCycleId) {
        try {
          const db = tryDb()
          if (db) {
            const pending = db.exec(
              `SELECT id FROM evolution_checkpoints WHERE cycle_id = ? AND status IN ('pending', 'in_progress')`,
              [this.currentCycleId],
            )
            if (pending.length && pending[0].values.length) {
              const idCol = pending[0].columns.indexOf('id')
              for (const row of pending[0].values) {
                const pid = String(row[idCol])
                db.run('UPDATE evolution_checkpoints SET status = ?, completed_at = ? WHERE id = ?', [
                  'interrupted',
                  Date.now(),
                  pid,
                ])
              }
              log('INFO', 'checkpoint_cycle_marked_interrupted', {
                cycleId: this.currentCycleId,
                count: pending[0].values.length,
              })
            }
          }
        } catch (err) {
          log('WARN', 'checkpoint_signal_cycle_update_failed', { error: String(err) })
        }
      }
    }

    process.on('SIGINT', () => handler('SIGINT'))
    process.on('SIGTERM', () => handler('SIGTERM'))
    process.on('beforeExit', () => handler('beforeExit'))

    log('INFO', 'checkpoint_signal_handlers_registered')
  }

  // ===========================================================================
  // 查询
  // ===========================================================================

  /** 获取指定周期所有检查点 */
  getCycleCheckpoints(cycleId: string): CheckpointContext[] {
    const db = tryDb()
    if (!db) return []

    try {
      const rows = db.exec(
        `SELECT * FROM evolution_checkpoints WHERE cycle_id = ? ORDER BY created_at ASC`,
        [cycleId],
      )
      return this.rowsToContexts(rows)
    } catch {
      return []
    }
  }

  /** 获取最近的检查点记录（按时间倒序） */
  getRecentCheckpoints(limit = 10): CheckpointContext[] {
    const db = tryDb()
    if (!db) return []

    try {
      const rows = db.exec(
        `SELECT * FROM evolution_checkpoints ORDER BY created_at DESC LIMIT ?`,
        [limit],
      )
      return this.rowsToContexts(rows)
    } catch {
      return []
    }
  }

  /** 获取当前活跃检查点 ID */
  getCurrentCheckpointId(): string | null {
    return this.currentCheckpointId
  }

  /** 获取当前周期 ID */
  getCurrentCycleId(): string | null {
    return this.currentCycleId
  }

  // ===========================================================================
  // 内部方法
  // ===========================================================================

  /**
   * 执行 git 状态保存。
   * 策略：
   *   1. 如果有未提交的变更 → git stash
   *   2. 然后创建一次 git commit + snapshot branch
   */
  private async saveGitState(
    cycleId: string,
    phase: string,
  ): Promise<{ snapshotBranch: string | null; stashMessage: string | null; headHash: string | null }> {
    const tag = `evolution_checkpoint_${cycleId}_${phase}`

    try {
      // 先尝试获取当前 HEAD hash
      let headHash: string | null = null
      try {
        const hash = await this.execGit('git rev-parse HEAD', 5000)
        headHash = hash.trim() || null
      } catch {
        // 可能没有 commit
      }

      // 检查是否有未提交变更
      let stashMessage: string | null = null
      try {
        const status = await this.execGit('git status --porcelain', 5000)
        if (status.trim()) {
          stashMessage = `[evolution checkpoint] ${tag}`
          await this.execGit(`git stash push -m "${stashMessage}"`, 15000)
          log('INFO', 'checkpoint_git_stashed', { tag })
        }
      } catch (err: any) {
        log('WARN', 'checkpoint_git_stash_skip', { error: err.message?.slice(0, 100) })
      }

      // 创建 snapshot commit + branch
      let snapshotBranch: string | null = null
      try {
        await this.execGit('git add -A', 15000)
        const commitMsg = `[snapshot] ${tag}`
        await this.execGit(`git commit -m "${commitMsg}"`, 15000)
        // eslint-disable-next-line prefer-const
        snapshotBranch = `evolution/snapshot/${tag}_${Date.now()}`
        await this.execGit(`git branch ${snapshotBranch}`, 10000)

        // pop stash 恢复工作区
        if (stashMessage) {
          try {
            await this.execGit('git stash pop', 15000)
          } catch {
            log('WARN', 'checkpoint_git_stash_pop_skip', { tag })
          }
        }

        log('INFO', 'checkpoint_git_snapshot_created', { tag, branch: snapshotBranch })
      } catch (err: any) {
        log('WARN', 'checkpoint_git_snapshot_skip', { error: err.message?.slice(0, 100) })
      }

      return { snapshotBranch, stashMessage, headHash }
    } catch (err: any) {
      log('WARN', 'checkpoint_git_state_failed', { error: err.message?.slice(0, 100) })
      return { snapshotBranch: null, stashMessage: null, headHash: null }
    }
  }

  /** 查找未完成的检查点 */
  private findUnfinishedCheckpoints(cycleId?: string): UnfinishedCheckpoint[] {
    const db = tryDb()
    if (!db) return []

    try {
      let rows: any
      if (cycleId) {
        rows = db.exec(
          `SELECT * FROM evolution_checkpoints
           WHERE cycle_id = ? AND status IN ('pending', 'in_progress')
           ORDER BY created_at ASC`,
          [cycleId],
        )
      } else {
        rows = db.exec(
          `SELECT * FROM evolution_checkpoints
           WHERE status IN ('pending', 'in_progress')
           ORDER BY created_at ASC`,
        )
      }

      return this.rowsToContexts(rows).map((ctx) => ({
        ...ctx,
        elapsedMs: Date.now() - ctx.createdAt,
      }))
    } catch {
      return []
    }
  }

  /** 标记检查点为中断 */
  private markInterrupted(checkpointId: string): void {
    const db = tryDb()
    if (!db) return
    try {
      db.run('UPDATE evolution_checkpoints SET status = ?, completed_at = ? WHERE id = ?', [
        'interrupted',
        Date.now(),
        checkpointId,
      ])
    } catch {
      // silent
    }
  }

  /** 获取单条检查点记录 */
  private getCheckpointRow(id: string): CheckpointRow | null {
    const db = tryDb()
    if (!db) return null

    try {
      const rows = db.exec('SELECT * FROM evolution_checkpoints WHERE id = ?', [id])
      if (!rows.length || !rows[0].values.length) return null
      const cols = rows[0].columns
      const vals = rows[0].values[0]
      return this.rowToObj(cols, vals)
    } catch {
      return null
    }
  }

  /** 将 DB 查询结果转换为 CheckpointContext 数组 */
  private rowsToContexts(rows: any[]): CheckpointContext[] {
    if (!rows.length || !rows[0].values.length) return []
    const cols = rows[0].columns
    return rows[0].values.map((vals: any[]) => {
      const row = this.rowToObj(cols, vals)
      return {
        id: row.id,
        cycleId: row.cycle_id,
        phase: row.phase as EvolutionCheckpointPhase,
        status: row.status as EvolutionCheckpointStatus,
        gitSnapshotBranch: row.git_snapshot_branch,
        targetFiles: row.target_files ? JSON.parse(row.target_files) : [],
        stepData: row.step_data ? JSON.parse(row.step_data) : null,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        error: row.error,
      }
    })
  }

  /** 列名+值 → 对象 */
  private rowToObj(cols: string[], vals: any[]): CheckpointRow {
    const obj: any = {}
    for (let i = 0; i < cols.length; i++) {
      obj[cols[i]] = vals[i]
    }
    return obj as CheckpointRow
  }

  /** 执行 git 命令的快捷方法 */
  private async execGit(cmd: string, timeout: number): Promise<string> {
    return execAsync(cmd, { timeout, windowsHide: true })
  }
}

// ===========================================================================
// 全局单例
// ===========================================================================

export const evolutionCheckpointManager = new EvolutionCheckpointManager()

// ===========================================================================
// 辅助
// ===========================================================================

function tryDb(): ReturnType<typeof getRawDb> | null {
  try {
    return getRawDb()
  } catch {
    return null
  }
}
