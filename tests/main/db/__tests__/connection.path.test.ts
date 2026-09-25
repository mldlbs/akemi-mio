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

  // 超时给到 30s（默认 5s）。§10.20 的 A′（beforeAll 预热冷 import）只消除了
  // **冷 import**；09-25 实测：测试体里 `initDatabase()` 仍有 ~250–500ms 的
  // **真·每次调用**成本（建 2 个 SQLite 库 + 同步迁移；`runMigrations` 无动态 import），
  // 而且**不可预热** —— 在 beforeAll 里额外预热一次 initDatabase 后，body 的 init 并未下降
  // （warmInit 485–529ms，body init 仍 246–504ms）。CI 冷/资源争用时这段真活儿会放大到
  // >5s ⇒ 假红（Run #97 复现；§10.20 当初否决「放宽超时」的理由是「成本可预热」，已被实测推翻）。
  // 该测试只做 3 个确定性的 existsSync 断言，放宽超时不掩盖代码回归（只去掉机器速度敏感性）；
  // 真正的死循环/挂起仍会在 30s 判红。
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
  }, 30_000)
})
