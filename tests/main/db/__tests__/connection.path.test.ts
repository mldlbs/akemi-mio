import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('database connection paths', () => {
  const tempRoots: string[] = []

  // 预热：付掉**进程级**的冷启动成本（better-sqlite3 原生模块 + 首次 transform）。
  // 实测第一次 import 957ms，而 vi.resetModules() 之后只要 8ms —— 它是进程级一次性的。
  // 这 957ms 与本测试要断言的东西（路径在 init 时解析、而非 import 时）毫无关系，
  // 却会吃掉 5000ms 的测试超时：Windows runner 上 5 次运行有 2 次因此假红（见
  // docs/gate-integrity-assessment-2026-09-20.md §10.20）。
  // 放进 beforeAll = 付在测试体之外，**测试自己的超时预算保持 5s 不变**（灵敏度零损失）。
  // import 本身无副作用 —— 开库的是 initDatabase()。
  // hook 的超时必须显式给：默认与 testTimeout 同为 5000ms，冷启动会把 hook 判红。
  //
  // ⚠️⚠️ `vi.resetModules()` 是**必须的**，不是保险起见：
  // 不重置的话，下面那次 `await import('@akemi-mio/core/db/connection')` 会拿到
  // 预热时缓存下来的实例，它内部的 config 引用指向**真实配置** → `vi.doMock` 被
  // 静默绕过。又因为 `USER_DATA_DIR` 优先级高于 `WORKSPACE.databases`，
  // 前两条断言在这种情形下**照样通过** —— 测试会变成假通过，且没有任何信号。
  // 实测（临时探针）：预热+resetModules → 落到 mock 路径 ✓；预热不重置 → 落到真实路径 ✗。
  beforeAll(async () => {
    await import('@akemi-mio/core/db/connection')
    vi.resetModules()
  }, 60_000)

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('@akemi-mio/core/config')
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop()!, { recursive: true, force: true })
    }
  })

  it('resolves database files from USER_DATA_DIR at initialization time', async () => {
    const fixedRoot = mkdtempSync(join(tmpdir(), 'akemi-db-fixed-'))
    const dynamicRoot = mkdtempSync(join(tmpdir(), 'akemi-db-dynamic-'))
    tempRoots.push(fixedRoot, dynamicRoot)

    vi.doMock('@akemi-mio/core/config', () => ({
      WORKSPACE: {
        databases: join(fixedRoot, 'databases'),
      },
    }))

    const previousUserDataDir = process.env.USER_DATA_DIR
    delete process.env.USER_DATA_DIR

    const connection = await import('@akemi-mio/core/db/connection')
    process.env.USER_DATA_DIR = dynamicRoot

    try {
      await connection.initDatabase()
    } finally {
      connection.closeDatabase()
      if (previousUserDataDir === undefined) {
        delete process.env.USER_DATA_DIR
      } else {
        process.env.USER_DATA_DIR = previousUserDataDir
      }
    }

    expect(existsSync(join(dynamicRoot, 'databases', 'main.db'))).toBe(true)
    expect(existsSync(join(dynamicRoot, 'databases', 'events.db'))).toBe(true)
    expect(existsSync(join(fixedRoot, 'databases', 'main.db'))).toBe(false)
  })
})
