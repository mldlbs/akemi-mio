import { describe, expect, it } from 'vitest'

// 从独立小模块导入，不要从 AppRuntime 导 —— 后者的依赖树会把整个启动流程拉起来
// （实测 import 一次 40s+ 且刷一堆启动日志）
import { toUnpacked } from '../../../../packages/main/src/bootstrap/asar-path'

/**
 * 回归：打包版曾因为把 asar 内的路径交给系统 node 而启动失败。
 *
 * MCP 服务器是 spawn 出去的独立 node 进程，拿 `...\app.asar\node_modules\...` 这种
 * 路径必然 MODULE_NOT_FOUND —— asar 只有 Electron 自己的 patched fs 能读。
 * 所以必须映射到 electron-builder asarUnpack 出来的 app.asar.unpacked。
 */
describe('toUnpacked', () => {
  it('把 asar 内路径映射到解包目录', () => {
    const p = 'D:\\app\\resources\\app.asar\\node_modules\\@playwright\\mcp\\cli.js'
    expect(toUnpacked(p)).toBe(
      'D:\\app\\resources\\app.asar.unpacked\\node_modules\\@playwright\\mcp\\cli.js',
    )
  })

  it('未打包（dev 直跑）路径原样返回', () => {
    const p = 'D:\\work\\code\\akemi-mio\\node_modules\\@playwright\\mcp\\cli.js'
    expect(toUnpacked(p)).toBe(p)
  })

  it('已经是解包目录时不重复替换', () => {
    const p = 'D:\\app\\resources\\app.asar.unpacked\\node_modules\\@playwright\\mcp\\cli.js'
    expect(toUnpacked(p)).toBe(p)
  })

  it('路径里没有 app.asar 时原样返回', () => {
    expect(toUnpacked('C:\\Users\\me\\app.asar.backup\\x.js')).toBe(
      'C:\\Users\\me\\app.asar.backup\\x.js',
    )
  })
})
