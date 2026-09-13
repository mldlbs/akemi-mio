/**
 * asar 路径 → 解包目录路径的映射。
 *
 * 为什么需要它：打包后 `require.resolve()` 返回的是
 * `...\resources\app.asar\node_modules\...`，而 **asar 里的文件只有 Electron 自己的
 * patched fs 能读**。任何由我们 spawn 出去的独立进程（MCP 服务器用的是系统 `node`）
 * 拿到这种路径必然 MODULE_NOT_FOUND —— 表现为子进程秒退、反复重启、initialize 超时，
 * 最后整个启动流程静默卡死。
 *
 * 解法是 electron-builder 的 `asarUnpack`（见 electron-builder.yml）把相关包解包到
 * `app.asar.unpacked`，运行时再用这里把路径指过去。
 *
 * 单独成一个模块而不是塞在 AppRuntime 里：AppRuntime 的 import 依赖树极重，
 * 单测只想要这个纯函数时不该把它整个拉起来（实测 import 一次要 40s+ 且刷一堆日志）。
 */

import { sep } from 'path'

export function toUnpacked(p: string): string {
  // 按**路径段**精确匹配，不能用字符串包含判断：
  // 否则 `app.asar.backup` 这种目录名也会被替换成 `app.asar.unpacked.backup`
  const segments = p.split(/[\\/]/)
  let hit = false
  const mapped = segments.map((seg) => {
    if (seg === 'app.asar') {
      hit = true
      return 'app.asar.unpacked'
    }
    return seg
  })
  return hit ? mapped.join(sep) : p
}
