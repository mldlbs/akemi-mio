import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (rel: string) => readFileSync(join(root, ...rel.split('/')), 'utf8')

/**
 * 回归：调试工具曾无条件开在生产路径上。
 *
 * 两处后果都不小：
 *   1. `mainWindow.webContents.openDevTools()` 写在 loadFile 分支里 —— 那就是**打包版**走的
 *      那条，于是每个正式版用户启动后都会多出一个独立的 "Developer Tools" 窗口。
 *   2. `app.commandLine.appendSwitch('remote-debugging-port','9224')` 无条件执行 ——
 *      用户机器上 9224 常开，连上去就能完全控制应用。
 *
 * 这类问题 dev 下看不出来（isPackaged=false 时本来就该开），只能靠源码断言 +
 * 实跑 exe 数顶层窗口来验证。
 */
describe('debug tooling must be gated in packaged builds', () => {
  it('openDevTools 不再无条件执行', () => {
    const src = read('packages/core/src/core/Lifecycle.ts')
    expect(src).toMatch(/function devToolsEnabled\(\)/)
    // 不能出现裸露的 openDevTools 调用
    expect(src).not.toMatch(/[^ \t]mainWindow\??\.webContents\.openDevTools\(\)/)
    expect(src).toMatch(/if \(devToolsEnabled\(\)\) mainWindow\.webContents\.openDevTools\(\)/)
    expect(src).toMatch(/if \(devToolsEnabled\(\)\) mainWindow\?\.webContents\.openDevTools\(\)/)
  })

  it('远程调试端口只在非打包版或显式开关时打开', () => {
    const src = read('packages/main/src/index.ts')
    expect(src).toMatch(/if \(!app\.isPackaged \|\| process\.env\.MIO_OPEN_DEVTOOLS === '1'\)/)
    // appendSwitch 那行必须在 if 块内，不能还留在顶层
    const lines = src.split('\n')
    const idxSwitch = lines.findIndex((l) =>
      l.includes("appendSwitch('remote-debugging-port'"),
    )
    expect(idxSwitch).toBeGreaterThan(-1)
    const before = lines.slice(0, idxSwitch).reverse()
    const idxIf = before.findIndex((l) => l.includes('if (!app.isPackaged'))
    const idxBrace = before.findIndex((l) => l.trim() === '}')
    // 离它最近的那个 if 必须比最近的闭合括号更近 —— 说明它确实在 if 块里
    expect(idxIf).toBeGreaterThan(-1)
    expect(idxIf).toBeLessThan(idxBrace === -1 ? Number.MAX_SAFE_INTEGER : idxBrace)
  })
})
