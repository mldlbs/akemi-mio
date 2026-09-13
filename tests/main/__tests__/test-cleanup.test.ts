import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeQuietly } from '../test-cleanup'

describe('removeQuietly', () => {
  it('正常路径下确实删掉目标目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mio-cleanup-'))
    writeFileSync(join(dir, 'a.txt'), 'x')

    removeQuietly(dir, true)

    expect(existsSync(dir)).toBe(false)
  })

  it('删除被拒时静默返回，不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mio-cleanup-'))
    writeFileSync(join(dir, 'a.txt'), 'x')

    // recursive=false 去删非空目录，fs 必定抛 ERR_FS_EISDIR。
    // 用它模拟「清理被环境策略拦下」（沙箱 / CI 的批量删除守卫）。
    // 要锁住的契约是：清理失败绝不能让用例变红 —— 残留临时产物只是占磁盘。
    expect(() => removeQuietly(dir)).not.toThrow()
    expect(existsSync(dir)).toBe(true)

    removeQuietly(dir, true)
  })
})
