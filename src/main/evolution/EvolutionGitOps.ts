import { log } from '../logger/Logger'
import { execAsync } from '../utils/async'

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
      await execAsync('git add -A', { timeout: 15000 })
      await execAsync(`git commit -m "[evolution] ${planTitle}"`, { timeout: 15000 })
      log('INFO', 'evolution_auto_commit', { planTitle })
    } catch (err: any) {
      log('INFO', 'evolution_auto_commit_skip', { error: err.message?.slice(0, 100) })
    }
  }

  async workspacePreCheck(lastSuccessTime: number): Promise<boolean> {
    try {
      const oneHourAgo = Date.now() - 60 * 60 * 1000
      if (lastSuccessTime > 0 && lastSuccessTime > oneHourAgo) return false
      const status = await execAsync('git status --short', { timeout: 10000 })
      const dirtyCount = status.trim() ? status.trim().split('\n').length : 0
      if (dirtyCount > 5) {
        await execAsync('git stash push -m "[evolution] auto-stash pre-analysis"', { timeout: 15000 })
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
      await execAsync('git stash pop', { timeout: 15000 })
      log('INFO', 'evolution_workspace_stash_restored')
    } catch (err: any) {
      log('INFO', 'evolution_workspace_stash_restore_skip', { error: err.message?.slice(0, 100) })
    }
  }

  async collectChangedFiles(): Promise<{ newFiles: string[]; modifiedFiles: string[] }> {
    try {
      const output = await execAsync('git status --porcelain 2>&1', { timeout: 5000 })
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
      const result = await execAsync('git rev-parse --abbrev-ref HEAD', { timeout: 10000 })
      return result.trim()
    } catch {
      return 'unknown'
    }
  }

  async createSnapshot(tag: string): Promise<string | null> {
    try {
      await execAsync('git add -A', { timeout: 15000 })
      await execAsync(`git commit -m "[snapshot] ${tag}"`, { timeout: 15000 })
      const branch = `evolution/snapshot/${tag}_${Date.now()}`
      await execAsync(`git branch ${branch}`, { timeout: 10000 })
      log('INFO', 'evolution_snapshot_created', { tag, branch })
      return branch
    } catch (err: any) {
      log('WARN', 'evolution_snapshot_failed', { error: err.message?.slice(0, 100) })
      return null
    }
  }

  async rollbackToSnapshot(branch: string, level: RollbackLevel = RollbackLevel.MODULE): Promise<boolean> {
    try {
      const currentBranch = await this.getCurrentBranch()
      await execAsync('git stash push -m "[rollback] auto-stash before rollback"', { timeout: 15000 })
      await execAsync(`git checkout ${branch} -- .`, { timeout: 15000 })
      if (level === RollbackLevel.MODULE || level === RollbackLevel.SYSTEM) {
        await execAsync('git clean -fd', { timeout: 15000 })
      }
      await execAsync(`git checkout ${currentBranch}`, { timeout: 10000 })
      log('INFO', 'evolution_rollback_completed', { branch, level })
      return true
    } catch (err: any) {
      log('ERROR', 'evolution_rollback_failed', { error: err.message?.slice(0, 100) })
      return false
    }
  }

  async rollback(level: RollbackLevel, ref: string): Promise<boolean> {
    return this.rollbackToSnapshot(ref, level)
  }

  async cleanupSnapshot(branch: string): Promise<boolean> {
    try {
      await execAsync(`git branch -D ${branch}`, { timeout: 10000 })
      log('INFO', 'evolution_snapshot_cleaned', { branch })
      return true
    } catch (err: any) {
      log('WARN', 'evolution_snapshot_cleanup_failed', { error: err.message?.slice(0, 100) })
      return false
    }
  }
}
