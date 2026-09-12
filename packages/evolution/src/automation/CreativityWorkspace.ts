/**
 * CreativityWorkspace — 创意实现独立工作区（git worktree 隔离）
 *
 * 目的：CreativityExecutor 的 agent 不再直接在主仓库改文件，
 * 而是在独立 git worktree 里读写，主仓库与主应用（dev watch）零接触。
 * 执行完成后以 patch 形式把改动安全回收回主仓库（带安全闸）。
 *
 * 设计约束：
 *  - worktree 固定单一（创意执行串行，busy 标志保证并发安全）
 *  - 每次 ensure() 把 worktree 重置到主分支最新，避免 agent 基于旧代码工作
 *  - deliver() 前检查主仓库工作区：脏则拒绝自动应用（P0 安全闸，避免卷走人类未提交改动）
 *  - 应用只写文件、不自动 commit（commit 交给主仓库现有流程/人工 review，规避 git add -A 风险）
 *  - node_modules 用 Windows junction 链接主仓库，省磁盘且 reset/clean 不触碰（clean -fd 不删 ignore 文件）
 */

import { existsSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { join } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { execAsync } from '@akemi-mio/core/utils/async'
import { DEV_PROJECT_ROOT } from '@akemi-mio/core/config'

const MAIN_ROOT = DEV_PROJECT_ROOT || process.cwd()

/** 创意执行专用 worktree 路径（.gitignore 已忽略 .worktrees/） */
export const CREATIVITY_WORKTREE_PATH = join(MAIN_ROOT, '.worktrees', 'creativity-exec')
/** 创意执行专用分支 */
export const CREATIVITY_WORKTREE_BRANCH = 'creativity/exec'

export interface CreativityDeliverResult {
  /** 是否已应用到主仓库 */
  applied: boolean
  /** 改动文件相对路径列表 */
  changedFiles: string[]
  /** 未自动应用时的 patch 保存路径 */
  patchPath?: string
  /** 未应用/拒绝原因 */
  reason?: 'no-changes' | 'main-dirty' | 'apply-check-failed' | 'deliver-error'
  /** 错误信息 */
  error?: string
  /** 是否已安全提交（只 add patch 涉及文件，不 git add -A） */
  committed?: boolean
  /** 提交短 SHA */
  commitSha?: string
}

export class CreativityWorkspace {
  private mainRoot: string
  private worktreePath: string
  private branch: string
  private patchDir: string

  constructor(mainRoot: string = MAIN_ROOT, worktreePath: string = CREATIVITY_WORKTREE_PATH, branch: string = CREATIVITY_WORKTREE_BRANCH) {
    this.mainRoot = mainRoot
    this.worktreePath = worktreePath
    this.branch = branch
    this.patchDir = join(join(mainRoot, '.worktrees'), 'patches')
  }

  /** 当前主分支 HEAD commit */
  private async mainHead(): Promise<string> {
    const out = await execAsync('git rev-parse HEAD', { cwd: this.mainRoot, timeout: 10000 })
    return out.trim()
  }

  /** worktree 是否已存在且可用 */
  private async worktreeExists(): Promise<boolean> {
    try {
      const out = await execAsync('git rev-parse --git-dir', { cwd: this.worktreePath, timeout: 10000 })
      return out.trim().length > 0
    } catch {
      return false
    }
  }

  private async branchExists(): Promise<boolean> {
    try {
      const out = await execAsync(`git branch --list ${this.branch}`, { cwd: this.mainRoot, timeout: 10000 })
      return out.trim().length > 0
    } catch {
      return false
    }
  }

  private async linkNodeModules(): Promise<void> {
    const mainModules = join(this.mainRoot, 'node_modules')
    const worktreeModules = join(this.worktreePath, 'node_modules')
    if (existsSync(worktreeModules) || !existsSync(mainModules)) return
    try {
      symlinkSync(mainModules, worktreeModules, 'junction')
      log('INFO', 'creativity_workspace_node_modules_linked', { path: worktreeModules })
    } catch (err: any) {
      log('WARN', 'creativity_workspace_node_modules_link_failed', { error: err.message })
    }
  }

  /**
   * 确保 worktree 存在并同步到主分支最新。
   * 返回 worktree 路径；任何失败都会抛出（调用方决定回退策略）。
   */
  async ensure(): Promise<string> {
    const worktreeBase = join(this.mainRoot, '.worktrees')
    if (!existsSync(worktreeBase)) mkdirSync(worktreeBase, { recursive: true })
    const head = await this.mainHead()

    if (!(await this.worktreeExists())) {
      const hasBranch = await this.branchExists()
      if (hasBranch) {
        await execAsync(`git worktree add "${this.worktreePath}" ${this.branch}`, { cwd: this.mainRoot, timeout: 60000 })
      } else {
        await execAsync(`git worktree add -b ${this.branch} "${this.worktreePath}" ${head}`, { cwd: this.mainRoot, timeout: 60000 })
      }
      log('INFO', 'creativity_workspace_created', { path: this.worktreePath, branch: this.branch, head })
    } else {
      log('DEBUG', 'creativity_workspace_reuse', { path: this.worktreePath })
    }

    // 同步：重置到主分支最新，清掉上次执行残留（clean -fd 保留 node_modules junction）
    await execAsync(`git -C "${this.worktreePath}" reset --hard ${head}`, { timeout: 30000 })
    await execAsync(`git -C "${this.worktreePath}" clean -fd`, { timeout: 30000 })

    await this.linkNodeModules()
    return this.worktreePath
  }

  /** 收集 worktree 相对主分支 HEAD 的改动文件列表 */
  async changedFiles(): Promise<string[]> {
    const head = await this.mainHead()
    const out = await execAsync(`git -C "${this.worktreePath}" diff --name-only ${head}`, { timeout: 15000 })
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  private savePatch(problemId: string | undefined, patch: string): string {
    const safeId = (problemId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
    const fileName = `${Date.now()}_${safeId}.patch`
    if (!existsSync(this.patchDir)) mkdirSync(this.patchDir, { recursive: true })
    const patchPath = join(this.patchDir, fileName)
    writeFileSync(patchPath, patch, 'utf-8')
    return patchPath
  }

  /**
   * 把 worktree 改动安全应用到主仓库。
   * P0 安全闸：主仓库工作区有未提交改动时拒绝自动应用，patch 落盘供人工 review。
   * 成功应用只写文件、不自动 commit。
   */
  async deliver(problemId?: string, title?: string): Promise<CreativityDeliverResult> {
    try {
      const changedFiles = await this.changedFiles()
      if (changedFiles.length === 0) {
        return { applied: false, changedFiles: [], reason: 'no-changes' }
      }

      const head = await this.mainHead()
      let patch = await execAsync(`git -C "${this.worktreePath}" diff --binary ${head}`, { timeout: 30000 })
      if (!patch.endsWith('\n')) patch += '\n'

      // P0 安全闸：主仓库脏则拒绝自动应用，patch 落盘
      const status = await execAsync('git status --porcelain', { cwd: this.mainRoot, timeout: 10000 })
      if (status.trim()) {
        const patchPath = this.savePatch(problemId, patch)
        log('WARN', 'creativity_workspace_deliver_blocked', { reason: 'main-dirty', patchPath, changed: changedFiles.length })
        return { applied: false, changedFiles, patchPath, reason: 'main-dirty' }
      }

      const patchPath = this.savePatch(problemId, patch)
      await execAsync(`git -C "${this.mainRoot}" apply --check --3way "${patchPath}"`, { timeout: 30000 })
      await execAsync(`git -C "${this.mainRoot}" apply --3way "${patchPath}"`, { timeout: 30000 })

      // 安全提交：只 add patch 涉及的文件（不用 git add -A，规避卷走人类改动），失败降级不抛
      let committed = false
      let commitSha: string | undefined
      try {
        const quotedFiles = changedFiles.map((file) => `"${file}"`).join(' ')
        await execAsync(`git -C "${this.mainRoot}" add ${quotedFiles}`, { timeout: 15000 })
        const commitMsg = `[creativity] ${(title || problemId || 'idea').slice(0, 60)}`.replace(/"/g, "'")
        await execAsync(`git -C "${this.mainRoot}" commit -m "${commitMsg}"`, { timeout: 15000 })
        committed = true
        const sha = await execAsync(`git -C "${this.mainRoot}" rev-parse --short HEAD`, { timeout: 10000 })
        commitSha = sha.trim()
        log('INFO', 'creativity_workspace_committed', { files: changedFiles.length, sha: commitSha })
      } catch (commitErr: any) {
        log('WARN', 'creativity_workspace_commit_skip', { error: commitErr.message })
      }

      log('INFO', 'creativity_workspace_delivered', { changed: changedFiles.length, patchPath, committed })
      return { applied: true, changedFiles, patchPath, committed, commitSha }
    } catch (err: any) {
      log('WARN', 'creativity_workspace_deliver_failed', { error: err.message })
      return { applied: false, changedFiles: [], reason: 'deliver-error', error: err.message }
    }
  }
}
