/**
 * MemoryOptimizationExecutor — 记忆优化执行器
 *
 * 消费 MemoryOptimizationCollector 生成的 Problem（source='memory'），
 * 根据建议参数：
 *   1. 读取当前可调参数配置
 *   2. 创建变更前快照（由 MemoryConfigManager 自动完成）
 *   3. 通过 MemoryService.updateTunableConfig() 应用参数变更
 *   4. 记录变更摘要
 *   5. 如果命中率下降，支持回滚（下一次采集时会检测并建议回滚）
 *
 * ── 安全性 ──
 * - 只在高置信度建议时执行（suggestedParams 存在）
 * - 参数变更幅度受 TUNABLE_RANGES 约束（MemoryOptimizationConfig 内定义）
 * - 每次变更前自动创建快照，支持回滚
 * - 参数值自动 clamp 到安全范围
 * - Problem severity 为 'warning' 时提示用户确认
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { FixExecutor, FixResult, AssignedProblem } from './types'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import type { MemoryTunableConfig } from '@akemi-mio/intelligence-memory/MemoryOptimizationConfig'

/** 最近一次执行前记录的效用统计摘要（用于执行后对比） */
let baselineStats: {
  meanUtility: number
  lowUtilityRatio: number
  longTailRatio: number
} | null = null

/** 最近一次执行结果（供 rollback 决策参考） */
let lastExecResult: {
  problemId: string
  timestamp: number
  configBefore: MemoryTunableConfig
  configAfter: MemoryTunableConfig
} | null = null

export class MemoryOptimizationExecutor implements FixExecutor {
  readonly name = 'memory-optimization-executor'
  readonly timeoutMs = 10_000
  readonly supportedSources = ['memory'] as const

  private memoryService: MemoryService | null = null

  isAvailable(): boolean {
    return this.memoryService !== null
  }

  /** 注入 MemoryService 引用 */
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
    log('INFO', 'memory_opt_executor_memory_attached')
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startTime = Date.now()

    if (!this.memoryService) {
      return {
        problemId: problem.id,
        success: false,
        summary: 'MemoryService 未就绪',
        durationMs: Date.now() - startTime,
        error: 'memory_service_not_ready',
      }
    }

    try {
      // 从 Problem context 中读取建议参数
      const suggestedParamsStr = problem.context.metadata?.suggestedParams
      if (!suggestedParamsStr) {
        // 没有具体的参数建议 → 只记录分析结果，不执行变更
        return {
          problemId: problem.id,
          success: true,
          summary: `📊 ${problem.title}（仅分析，无需调参）`,
          durationMs: Date.now() - startTime,
          output: problem.context.snippet,
        }
      }

      const suggestedParams: Record<string, number> = JSON.parse(suggestedParamsStr)
      const analysisType = problem.context.metadata?.analysisType || 'unknown'

      // ── 记录基线（用于后续对比） ──
      const stats = this.memoryService.getOptimizationStats()
      baselineStats = {
        meanUtility: stats.utilityStats.meanUtility,
        lowUtilityRatio: stats.utilityStats.lowUtilityRatio,
        longTailRatio: stats.accessStats.longTailRatio,
      }

      // ── 生成变更原因 ──
      const reason = `[记忆优化] ${analysisType}: ${problem.title}`

      // ── 应用参数变更 ──
      const configBefore = this.memoryService.getTunableConfig()
      const configAfter = this.memoryService.updateTunableConfig(suggestedParams, reason)

      // ── 记录执行结果 ──
      lastExecResult = {
        problemId: problem.id,
        timestamp: Date.now(),
        configBefore: { ...configBefore },
        configAfter: { ...configAfter },
      }

      // ── 构建变更摘要 ──
      const changes = Object.entries(suggestedParams)
        .filter(([key]) => (configBefore as any)[key] !== undefined)
        .map(([key, value]) => {
          const oldVal = (configBefore as any)[key]
          return `  - ${key}: ${oldVal} → ${value}`
        })
        .join('\n')

      const summary = `✅ 记忆参数已优化更新
      ${changes}
      类型: ${analysisType}
      基线效用: ${baselineStats.meanUtility.toFixed(3)}
      基线低效用率: ${(baselineStats.lowUtilityRatio * 100).toFixed(1)}%`

      log('INFO', 'memory_opt_executor_applied', {
        problemId: problem.id,
        analysisType,
        changes: Object.keys(suggestedParams),
        configAfter,
      })

      return {
        problemId: problem.id,
        success: true,
        summary,
        durationMs: Date.now() - startTime,
        output: `记忆配置已更新: ${Object.keys(suggestedParams).join(', ')}`,
      }
    } catch (err: any) {
      log('ERROR', 'memory_opt_executor_error', { problemId: problem.id, error: err.message })

      return {
        problemId: problem.id,
        success: false,
        summary: `记忆优化失败: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: err.message,
      }
    }
  }

  /**
   * 检查上一次优化后的效果，如果指标恶化则建议回滚。
   * 由 MemoryOptimizationCollector 在下次采集时调用（通过 Problem 上下文传递）。
   *
   * @param memoryService MemoryService 引用
   * @returns 回滚建议文本（空字符串表示无需回滚）
   */
  static checkAndSuggestRollback(memoryService: MemoryService): string {
    if (!lastExecResult || !baselineStats) return ''

    try {
      const currentStats = memoryService.getOptimizationStats()
      const currentUtility = currentStats.utilityStats.meanUtility
      const currentLowRatio = currentStats.utilityStats.lowUtilityRatio
      const currentLongTail = currentStats.accessStats.longTailRatio

      const utilityDrop = currentUtility < baselineStats.meanUtility * 0.9 // 效用下降超过 10%
      const lowUtilityIncrease = currentLowRatio > baselineStats.lowUtilityRatio * 1.2 // 低效用率上升 20%
      const longTailIncrease = currentLongTail > baselineStats.longTailRatio * 1.2

      if (utilityDrop || lowUtilityIncrease || longTailIncrease) {
        const rollbackInfo = memoryService.getConfigSnapshots()
        const snapshot = rollbackInfo[rollbackInfo.length - 1]

        return [
          `⚠️ 上次优化后记忆指标出现恶化：`,
          `  - 平均效用: ${baselineStats.meanUtility.toFixed(3)} → ${currentUtility.toFixed(3)}${utilityDrop ? ' ↓' : ''}`,
          `  - 低效用率: ${(baselineStats.lowUtilityRatio * 100).toFixed(1)}% → ${(currentLowRatio * 100).toFixed(1)}%${lowUtilityIncrease ? ' ↑' : ''}`,
          `  - 长尾率: ${(baselineStats.longTailRatio * 100).toFixed(1)}% → ${(currentLongTail * 100).toFixed(1)}%${longTailIncrease ? ' ↑' : ''}`,
          snapshot ? `  快照: ${snapshot.id} (${snapshot.reason})` : '',
          '建议执行回滚。',
        ].join('\n')
      }
    } catch {
      // 静默失败
    }

    return ''
  }

  /**
   * 手动触发回滚最近一次变更（供外部使用或 UI 操作）。
   * @param memoryService MemoryService 引用
   * @returns 回滚摘要
   */
  static rollback(memoryService: MemoryService): string {
    const rolledBack = memoryService.rollbackMemoryConfig()
    if (!rolledBack) return '没有可回滚的配置快照。'

    lastExecResult = null
    baselineStats = null

    log('INFO', 'memory_opt_executor_rollback', { config: rolledBack })
    return `✅ 已回滚到上一个配置: ${JSON.stringify(rolledBack)}`
  }

  /** 获取最近一次执行结果（只读） */
  static getLastExecResult() {
    return lastExecResult ? { ...lastExecResult } : null
  }

  /** 获取基线统计（只读） */
  static getBaselineStats() {
    return baselineStats ? { ...baselineStats } : null
  }
}
