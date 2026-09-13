import { rmSync } from 'node:fs'

/**
 * 删除测试临时产物；删不掉就算了，绝不抛。
 *
 * 为什么需要它：清理临时目录/临时文件**不是被测行为**。一旦 rmSync 被环境策略
 * 拦下（沙箱、CI 的批量删除守卫、Windows 上被占用的文件），抛错会让每一个用到
 * 该夹具的用例一起变红，而真实断言其实全绿 —— 一次全量 vitest 能刷出 250 条
 * 全是 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 的假失败，把真正的回归彻底淹没。
 *
 * 残留的临时产物顶多占磁盘，不该伪装成测试失败。
 *
 * @param target 要删除的路径
 * @param recursive 删除目录时传 true
 */
export function removeQuietly(target: string, recursive = false): void {
  try {
    rmSync(target, { recursive, force: true })
  } catch {
    // 清理失败 = 留下孤儿文件，可接受；测试继续跑。
  }
}
