import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EvolutionGitOps } from '@akemi-mio/evolution-core/EvolutionGitOps'
import { WORKSPACE } from '@akemi-mio/core/config'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))
vi.mock('@akemi-mio/core/utils/async', () => ({
  execAsync: vi.fn().mockImplementation(async () => ''),
}))

import { execAsync } from '@akemi-mio/core/utils/async'

describe('EvolutionGitOps', () => {
  let gitOps: EvolutionGitOps

  beforeEach(() => {
    // git 写操作受 MIO_EVOLUTION_GIT_WRITES 门禁保护（默认关，避免
    // evolution 在无人看管时对当前分支做 add/commit/stash）。
    // 本文件的用例就是要验证这些 git 操作本身，因此显式打开门禁。
    process.env.MIO_EVOLUTION_GIT_WRITES = '1'
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

// 与上面的 describe 相反：验证门禁**默认关闭**时的行为。
// 这些 git 写曾在无人看管时对当前分支执行 add -A / commit / stash，
// 把用户无关的在途改动一起吸进去，历史上有过丢失本地提交的事故，
// 因此必须锁死"默认不写"。
describe('EvolutionGitOps git 写门禁（默认关闭）', () => {
  beforeEach(() => {
    delete process.env.MIO_EVOLUTION_GIT_WRITES
    vi.clearAllMocks()
  })

  it('autoGitCommit 不执行任何 git 命令', async () => {
    await new EvolutionGitOps().autoGitCommit('测试计划')
    expect(execAsync).not.toHaveBeenCalled()
  })

  it('workspacePreCheck 既不 stash 也不 add', async () => {
    ;(execAsync as any).mockResolvedValue(' M f1\n M f2\n M f3\n M f4\n M f5\n M f6\n')
    const result = await new EvolutionGitOps().workspacePreCheck(0)
    expect(result).toBe(false)
    const calls = (execAsync as any).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(calls.some((c: string) => c.startsWith('git stash'))).toBe(false)
    expect(calls.some((c: string) => c.startsWith('git add'))).toBe(false)
  })

  it('workspacePostRestore 不执行 git stash pop', async () => {
    await new EvolutionGitOps().workspacePostRestore()
    expect(execAsync).not.toHaveBeenCalled()
  })
})
