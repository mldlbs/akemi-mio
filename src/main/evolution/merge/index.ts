/**
 * 自进化合并引擎 — 模块入口
 *
 * 利用自进化系统的代码分析与自动修改能力，自动化 radar-bot 到 telegram-bot 的合并：
 * 1. MergeAnalyzer — 扫描雷达和 Telegram 代码，识别合并缺口
 * 2. MergePlanGenerator — 生成结构化合并计划
 * 3. MergePatchExecutor — 执行补丁生成、验证、回滚
 * 4. MergeEngineCollector — 进化采集器（接入 2h 周期管道）
 * 5. MergeEngine — 主编排器（也实现 FixExecutor 接口）
 * 6. MergeSecurityScanner — 安全扫描（参考 MS #570）
 *
 * 使用方式：
 * ```ts
 * import { mergeEngine } from './evolution/merge'
 *
 * // 手动触发全量合并
 * const result = await mergeEngine.runFullCycle()
 *
 * // 获取引擎状态
 * const status = mergeEngine.getStatus()
 * ```
 */

export { MergeEngine } from './MergeEngine'
export { MergeAnalyzer } from './MergeAnalyzer'
export { MergePlanGenerator } from './MergePlanGenerator'
export { MergePatchExecutor } from './MergePatchExecutor'
export { MergeEngineCollector } from './MergeEngineCollector'
export { MergeSecurityScanner } from './MergeSecurityScanner'

export type {
  MergeGapType,
  SourceModule,
  ScannedFunction,
  MergeGap,
  MergePlan,
  MergePlanStatus,
  MergeScanResult,
  MergePatch,
  PatchStatus,
  SecurityFinding,
  SecuritySeverity,
  SecurityScanResult,
  MergeEngineStatus,
} from './types'
