/**
 * CreativityWorkspace — 独立工作区（git worktree 隔离）单测
 *
 * 验证：
 * 1. ensure() 首次创建 worktree（-b 新分支）并 reset/clean 同步
 * 2. ensure() 复用已存在 worktree，不做 add
 * 3. ensure() 分支已存在时 add 已存在分支（不带 -b）
 * 4. deliver() 无改动 → no-changes
 * 5. deliver() 主仓库脏 → P0 安全闸拒绝自动应用，patch 落盘
 * 6. deliver() 主仓库干净 → apply + 安全 commit（只 add 涉及文件）
 * 7. deliver() commit 失败 → 降级不抛，applied 仍为 true
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CreativityWorkspace } from '@akemi-mio/evolution/automation/CreativityWorkspace'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))
vi.mock('@akemi-mio/core/utils/async', () => ({ execAsync: vi.fn() }))

import { execAsync } from '@akemi-mio/core/utils/async'

describe('CreativityWorkspace', () => {
  let mainRoot: string
  let wt: string
  let ws: CreativityWorkspace

  beforeEach(() => {
    mainRoot = mkdtempSync(join(tmpdir(), 'mio-main-'))
    wt = join(mainRoot, '.worktrees', 'creativity-exec')
    ws = new CreativityWorkspace(mainRoot, wt, 'creativity/exec')
    ;(execAsync as any).mockReset()
  })

  afterEach(() => {
    rmSync(mainRoot, { recursive: true, force: true })
  })

  it('ensure(): 首次创建 worktree（-b 新分支）并 reset/clean 同步', async () => {
    ;(execAsync as any)
      .mockResolvedValueOnce('abc123\n') // mainHead
      .mockRejectedValueOnce(new Error('no git dir')) // worktreeExists
      .mockResolvedValueOnce('') // branchExists → false
      .mockResolvedValueOnce('') // worktree add -b
      .mockResolvedValueOnce('') // reset
      .mockResolvedValueOnce('') // clean

    const path = await ws.ensure()

    expect(path).toBe(wt)
    const cmds = (execAsync as any).mock.calls.map((c: any[]) => c[0])
    const addCmd = cmds[3]
    expect(addCmd).toContain('worktree add -b creativity/exec')
    expect(addCmd).toContain(wt)
    expect(cmds[4]).toContain('reset --hard abc123')
    expect(cmds[5]).toContain('clean -fd')
  })

  it('ensure(): worktree 已存在时仅同步，不做 add', async () => {
    ;(execAsync as any)
      .mockResolvedValueOnce('abc123\n') // mainHead
      .mockResolvedValueOnce('/fake/.git\n') // worktreeExists → true
      .mockResolvedValueOnce('') // reset
      .mockResolvedValueOnce('') // clean

    const path = await ws.ensure()

    expect(path).toBe(wt)
    const cmds = (execAsync as any).mock.calls.map((c: any[]) => c[0]).join('\n')
    expect(cmds).not.toContain('worktree add')
    expect(cmds).toContain('reset --hard abc123')
  })

  it('ensure(): worktree 不存在但分支已存在时 add 已存在分支', async () => {
    ;(execAsync as any)
      .mockResolvedValueOnce('abc123\n') // mainHead
      .mockRejectedValueOnce(new Error('no git dir')) // worktreeExists
      .mockResolvedValueOnce('creativity/exec\n') // branchExists → true
      .mockResolvedValueOnce('') // worktree add（不带 -b）
      .mockResolvedValueOnce('') // reset
      .mockResolvedValueOnce('') // clean

    await ws.ensure()

    const cmds = (execAsync as any).mock.calls.map((c: any[]) => c[0])
    const addCmd = cmds[3]
    expect(addCmd).toContain('worktree add')
    expect(addCmd).not.toContain('-b')
  })

  it('deliver(): 无改动返回 no-changes', async () => {
    ;(execAsync as any)
      .mockResolvedValueOnce('abc123\n') // changedFiles → mainHead
      .mockResolvedValueOnce('') // diff --name-only

    const r = await ws.deliver('p1')

    expect(r.applied).toBe(false)
    expect(r.reason).toBe('no-changes')
    expect(r.changedFiles).toEqual([])
  })

  it('deliver(): 主仓库脏时拒绝自动应用并落盘 patch（P0 安全闸）', async () => {
    ;(execAsync as any)
      .mockResolvedValueOnce('abc123\n') // changedFiles → mainHead
      .mockResolvedValueOnce('src/foo.ts\n') // diff --name-only
      .mockResolvedValueOnce('abc123\n') // deliver → mainHead
      .mockResolvedValueOnce('diff --git a/src/foo.ts b/src/foo.ts\n') // diff --binary
      .mockResolvedValueOnce(' M src/other.ts\n') // status --porcelain（脏）

    const r = await ws.deliver('p1')

    expect(r.applied).toBe(false)
    expect(r.reason).toBe('main-dirty')
    expect(r.patchPath).toBeTruthy()
    expect(existsSync(r.patchPath as string)).toBe(true)
    const cmds = (execAsync as any).mock.calls.map((c: any[]) => c[0]).join('\n')
    expect(cmds).not.toContain('apply')
  })

  it('deliver(): 主仓库干净时应用 patch 并安全 commit（只 add 涉及文件，带标题）', async () => {
    ;(execAsync as any)
      .mockResolvedValueOnce('abc123\n') // changedFiles → mainHead
      .mockResolvedValueOnce('src/foo.ts\n') // diff --name-only
      .mockResolvedValueOnce('abc123\n') // deliver → mainHead
      .mockResolvedValueOnce('diff --git a/src/foo.ts b/src/foo.ts\n') // diff --binary
      .mockResolvedValueOnce('') // status --porcelain（干净）
      .mockResolvedValueOnce('') // apply --check --3way
      .mockResolvedValueOnce('') // apply --3way
      .mockResolvedValueOnce('') // git add "src/foo.ts"
      .mockResolvedValueOnce('') // git commit -m "[creativity] ..."
      .mockResolvedValueOnce('abc1234\n') // rev-parse --short HEAD

    const r = await ws.deliver('p1', '实现跨模块缓存优化')

    expect(r.applied).toBe(true)
    expect(r.committed).toBe(true)
    expect(r.commitSha).toBe('abc1234')
    expect(r.changedFiles).toEqual(['src/foo.ts'])
    const cmds = (execAsync as any).mock.calls.map((c: any[]) => c[0]).join('\n')
    expect(cmds).toContain('apply --check --3way')
    expect(cmds).toContain('apply --3way')
    expect(cmds).toContain('add "src/foo.ts"')
    expect(cmds).toContain('commit -m "[creativity] 实现跨模块缓存优化"')
    expect(cmds).not.toContain('git add -A')
  })

  it('deliver(): commit 失败降级不抛，applied 仍为 true', async () => {
    ;(execAsync as any)
      .mockResolvedValueOnce('abc123\n') // changedFiles → mainHead
      .mockResolvedValueOnce('src/foo.ts\n') // diff --name-only
      .mockResolvedValueOnce('abc123\n') // deliver → mainHead
      .mockResolvedValueOnce('diff --git a/src/foo.ts b/src/foo.ts\n') // diff --binary
      .mockResolvedValueOnce('') // status（干净）
      .mockResolvedValueOnce('') // apply --check
      .mockResolvedValueOnce('') // apply --3way
      .mockRejectedValueOnce(new Error('nothing to commit')) // git add/commit 失败

    const r = await ws.deliver('p1', '标题')

    expect(r.applied).toBe(true)
    expect(r.committed).toBe(false)
    expect(r.commitSha).toBeUndefined()
  })
})
