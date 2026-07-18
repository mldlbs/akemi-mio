import { log } from '../logger/Logger'
import { execAsync } from '../utils/async'
import { WORKSPACE } from '../config'

const EVO_CWD = WORKSPACE.evolution

export enum RollbackLevel {
  TASK = 'task',
  MODULE = 'module',
  SYSTEM = 'system',
}

/**
 * Git 操作 — 自动 commit/stash/restore。
 * 从 SelfEvolutionService 提取。
 */
export class EvolutionGitOps {
  constructor() {}

  async autoGitCommit(planTitle: string): Promise<void> {
    try {
      await execAsync('git add -A', { cwd: EVO_CWD, timeout: 15000 })
      await execAsync(`git commit -m "[evolution] ${planTitle}"`, { cwd: EVO_CWD, timeout: 15000 })
      log('INFO', 'evolution_auto_commit', { planTitle })
    } catch (err: any) {
      log('INFO', 'evolution_auto_commit_skip', { error: err.message?.slice(0, 100) })
    }
  }

  async workspacePreCheck(lastSuccessTime: number): Promise<boolean> {
    try {
      const oneHourAgo = Date.now() - 60 * 60 * 1000
      if (lastSuccessTime > 0 && lastSuccessTime > oneHourAgo) return false
      const status = await execAsync('git status --short', { cwd: EVO_CWD, timeout: 10000 })
      const dirtyCount = status.trim() ? status.trim().split('\n').length : 0
      if (dirtyCount > 5) {
        await execAsync('git stash push -m "[evolution] auto-stash pre-analysis"', { cwd: EVO_CWD, timeout: 15000 })
        log('INFO', 'evolution_workspace_stashed', { dirtyCount })
        return true
      }
    } catch (err: any) {
      log('INFO', 'evolution_workspace_stash_skip', { error: err.message?.slice(0, 100) })
    }
    return false
  }

  async workspacePostRestore(): Promise<void> {
    try {
      await execAsync('git stash pop', { cwd: EVO_CWD, timeout: 15000 })
      log('INFO', 'evolution_workspace_stash_restored')
    } catch (err: any) {
      log('INFO', 'evolution_workspace_stash_restore_skip', { error: err.message?.slice(0, 100) })
    }
  }

  async collectChangedFiles(): Promise<{ newFiles: string[]; modifiedFiles: string[] }> {
    try {
      const output = await execAsync('git status --porcelain 2>&1', { cwd: EVO_CWD, timeout: 5000 })
      const lines = (output || '').split('\n').filter(Boolean)
      const newFiles: string[] = []
      const modifiedFiles: string[] = []
      for (const line of lines) {
        const status = line.slice(0, 2).trim()
        const file = line.slice(3).trim()
        if (status === '??' || status.startsWith('A')) newFiles.push(file)
        else if (status.startsWith('M') || status.startsWith('R')) modifiedFiles.push(file)
      }
      return { newFiles, modifiedFiles }
    } catch {
      return { newFiles: [], modifiedFiles: [] }
    }
  }

  async getCurrentBranch(): Promise<string> {
    try {
      const result = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: EVO_CWD, timeout: 10000 })
      return result.trim()
    } catch {
      return 'unknown'
    }
  }

  async createSnapshot(tag: string): Promise<string | null> {
    try {
      await execAsync('git add -A', { cwd: EVO_CWD, timeout: 15000 })
      await execAsync(`git commit -m "[snapshot] ${tag}"`, { cwd: EVO_CWD, timeout: 15000 })
      const branch = `evolution/snapshot/${tag}_${Date.now()}`
      await execAsync(`git branch ${branch}`, { cwd: EVO_CWD, timeout: 10000 })
      log('INFO', 'evolution_snapshot_created', { tag, branch })
      return branch
    } catch (err: any) {
      log('WARN', 'evolution_snapshot_failed', { error: err.message?.slice(0, 100) })
      return null
    }
  }

  async rollbackToSnapshot(branch: string, level: RollbackLevel = RollbackLevel.MODULE): Promise<boolean> {
    // P0: 阻止无差别工作区覆盖，保护开发环境
    // snapshot 不做文件级 ownership，rollback 会覆盖所有跟踪文件
    // 包括人类的未提交修改。正确修复见 P1：
    //   - snapshot 记录 modifiedFiles 列表
    //   - rollback 只恢复 modifiedFiles，不是整个 .
    // P2 防御：rollback 前检测 git status，若有非 Evolution 修改则拒绝
    log('WARN', 'evolution_rollback_to_snapshot_blocked', { branch, level, message: 'rollback temporarily disabled - P0 safety guard' })
    return false
  }

  async rollback(level: RollbackLevel, ref: string): Promise<boolean> {
    return this.rollbackToSnapshot(ref, level)
  }

  async cleanupSnapshot(branch: string): Promise<boolean> {
    try {
      await execAsync(`git branch -D ${branch}`, { cwd: EVO_CWD, timeout: 10000 })
      log('INFO', 'evolution_snapshot_cleaned', { branch })
      return true
    } catch (err: any) {
      log('WARN', 'evolution_snapshot_cleanup_failed', { error: err.message?.slice(0, 100) })
      return false
    }
  }
}
