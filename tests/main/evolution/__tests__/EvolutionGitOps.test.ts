import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EvolutionGitOps } from '@akemi-mio/evolution/EvolutionGitOps'
import { WORKSPACE } from '@akemi-mio/core/config'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))
vi.mock('@akemi-mio/core/utils/async', () => ({
  execAsync: vi.fn().mockImplementation(async () => ''),
}))

import { execAsync } from '@akemi-mio/core/utils/async'

describe('EvolutionGitOps', () => {
  let gitOps: EvolutionGitOps

  beforeEach(() => {
    gitOps = new EvolutionGitOps()
    vi.clearAllMocks()
  })

  it('autoGitCommit 调用 git add 和 commit', async () => {
    await gitOps.autoGitCommit('测试计划')
    expect(execAsync).toHaveBeenCalledWith('git add -A', { cwd: WORKSPACE.evolution, timeout: 15000 })
    expect(execAsync).toHaveBeenCalledWith('git commit -m "[evolution] 测试计划"', { cwd: WORKSPACE.evolution, timeout: 15000 })
  })

  it('autoGitCommit 失败时不抛出', async () => {
    ;(execAsync as any).mockRejectedValueOnce(new Error('nothing to commit'))
    await expect(gitOps.autoGitCommit('测试')).resolves.toBeUndefined()
  })

  it('workspacePreCheck 在 lastSuccessTime 较近时返回 false', async () => {
    const result = await gitOps.workspacePreCheck(Date.now())
    expect(result).toBe(false)
  })

  it('workspacePreCheck 在 dirty 文件多时 stash', async () => {
    ;(execAsync as any).mockResolvedValueOnce(' M f1\n M f2\n M f3\n M f4\n M f5\n M f6\n')
    const result = await gitOps.workspacePreCheck(0)
    expect(result).toBe(true)
  })

  it('workspacePostRestore 调用 stash pop', async () => {
    await gitOps.workspacePostRestore()
    expect(execAsync).toHaveBeenCalledWith('git stash pop', { cwd: WORKSPACE.evolution, timeout: 15000 })
  })

  it('workspacePostRestore 失败时不抛出', async () => {
    ;(execAsync as any).mockRejectedValueOnce(new Error('nothing to pop'))
    await expect(gitOps.workspacePostRestore()).resolves.toBeUndefined()
  })

  it('collectChangedFiles 解析 git status', async () => {
    ;(execAsync as any).mockResolvedValueOnce(' M src/test.ts\n?? new_file.ts\nA  added.ts\nR  old.ts -> new.ts\n')
    const result = await gitOps.collectChangedFiles()
    expect(result.newFiles).toContain('new_file.ts')
    expect(result.newFiles).toContain('added.ts')
    expect(result.modifiedFiles).toContain('src/test.ts')
  })

  it('collectChangedFiles 失败时返回空', async () => {
    ;(execAsync as any).mockRejectedValueOnce(new Error('not a git repo'))
    const result = await gitOps.collectChangedFiles()
    expect(result).toEqual({ newFiles: [], modifiedFiles: [] })
  })

  it('getCurrentBranch 返回分支名', async () => {
    ;(execAsync as any).mockResolvedValueOnce('main\n')
    const branch = await gitOps.getCurrentBranch()
    expect(branch).toBe('main')
  })

  it('getCurrentBranch 失败返回 unknown', async () => {
    ;(execAsync as any).mockRejectedValueOnce(new Error('error'))
    const branch = await gitOps.getCurrentBranch()
    expect(branch).toBe('unknown')
  })
})
