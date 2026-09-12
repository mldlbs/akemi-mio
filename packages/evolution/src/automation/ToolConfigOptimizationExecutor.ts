/**
 * ToolConfigOptimizationExecutor — 工具配置优化执行器
 *
 * ## 职责
 * 接收 ToolAnalyticsCollector 生成的配置优化问题，执行配置变更：
 * 1. 解析问题元数据（工具名、优化类型、建议值）
 * 2. 通过 ToolConfigManager 应用配置变更（附带评估快照）
 * 3. 在下一个进化周期中评估变更效果，必要时自动回滚
 *
 * ## 支持的优化类型
 * - boost_priority: 提升优先级（高成功+低延迟工具）
 * - reduce_priority: 降低优先级（高错误率工具）
 * - adjust_timeout: 调整超时设置（高延迟工具）
 * - reduce_priority_trend: 趋势恶化降优先级
 * - consider_disable: 暂时禁用工具（极高错误率）
 *
 * ## 与 ToolEvolutionExecutor 的职责分工
 * - ToolEvolutionExecutor: 修改工具**源码**来修复错误（深层修复，针对源头）
 * - ToolConfigOptimizationExecutor: 调整工具**配置**来优化性能（表层调优，针对指标）
 *   两者可以协作：先调优配置快速见效，再考虑源码级修复。
 *
 * ## 安全机制
 * - 每个变更前创建 ToolEvalSnapshot（记录变更前指标基线）
 * - 变更自动关联快照，下个周期 evaluateAndMaybeRollback 检查效果
 * - 配置变更不修改源码，无编译风险
 * - 变更可被人工覆盖或清除
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { FixExecutor, AssignedProblem, FixResult } from './types'
import { toolConfigManager } from '@akemi-mio/capabilities/tool/ToolConfigManager'
import type { ConfigChangeType, ToolTunableConfig } from '@akemi-mio/capabilities/tool/ToolConfigManager'
import { toolStatsTracker } from '@akemi-mio/capabilities/tool/ToolStatsTracker'

// =============================================================================
// 配置常量
// =============================================================================

const EXECUTOR_CONFIG = {
  /** 最小样本数：少于该值拒绝执行配置变更 */
  MIN_SAMPLES: 5,
  /** 执行器可用超时（毫秒） */
  TIMEOUT_MS: 30_000,
  /** 执行间隔冷却（毫秒），避免同一周期内重复执行 */
  MIN_EXECUTE_INTERVAL_MS: 60_000,
}

// =============================================================================
// ToolConfigOptimizationExecutor
// =============================================================================

export class ToolConfigOptimizationExecutor implements FixExecutor {
  readonly name = 'tool-config-optimization-executor'
  readonly supportedSources = ['tool'] as const
  readonly timeoutMs = EXECUTOR_CONFIG.TIMEOUT_MS

  private lastExecuteAt = 0
  private busy = false

  isAvailable(): boolean {
    if (this.busy) return false
    if (Date.now() - this.lastExecuteAt < EXECUTOR_CONFIG.MIN_EXECUTE_INTERVAL_MS) return false
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    this.busy = true
    this.lastExecuteAt = Date.now()
    const startedAt = Date.now()

    try {
      const metadata = problem.context.metadata
      const toolName = metadata?.toolName
      const suggestion = metadata?.suggestion as string | undefined

      if (!toolName || !suggestion) {
        return {
          problemId: problem.id,
          success: false,
          summary: '缺少工具名或优化类型元数据',
          durationMs: Date.now() - startedAt,
          error: 'missing_metadata',
        }
      }

      // ── 解析元数据 ──
      const currentErrorRate = parseFloat(metadata.currentErrorRate ?? '0')
      const totalCalls = parseInt(metadata.totalCalls ?? '0', 10)

      if (totalCalls < EXECUTOR_CONFIG.MIN_SAMPLES) {
        return {
          problemId: problem.id,
          success: false,
          summary: `工具 "${toolName}" 样本不足（${totalCalls} < ${EXECUTOR_CONFIG.MIN_SAMPLES}），跳过配置优化`,
          durationMs: Date.now() - startedAt,
          error: 'insufficient_samples',
        }
      }

      // ── 根据优化类型生成配置变更 ──
      const { changeType, newValues, reason } = this.buildConfigChange(suggestion, metadata)

      if (!changeType || !reason) {
        return {
          problemId: problem.id,
          success: true,
          summary: `工具 "${toolName}" 无需配置变更（无适用优化）`,
          durationMs: Date.now() - startedAt,
          output: 'no_change_needed',
        }
      }

      // ── 应用配置变更（附带评估快照） ──
      const currentConfig = toolConfigManager.getConfig(toolName)

      // 跳过已处于相同状态的工具（幂等保护）
      if (this.isAlreadyApplied(currentConfig, changeType, newValues)) {
        return {
          problemId: problem.id,
          success: true,
          summary: `工具 "${toolName}" 的配置已处于目标状态，跳过重复优化`,
          durationMs: Date.now() - startedAt,
          output: 'already_applied',
        }
      }

      const { snapshotId, changed } = toolConfigManager.applyChange(toolName, changeType, newValues, reason)

      if (!changed) {
        return {
          problemId: problem.id,
          success: true,
          summary: `工具 "${toolName}" 配置无实际变更`,
          durationMs: Date.now() - startedAt,
          output: 'no_change',
        }
      }

      // 标记冷却，防止 ToolEvolutionCollector 也试图优化此工具
      toolStatsTracker.markOptimized(toolName)

      const elapsedMs = Date.now() - startedAt

      log('INFO', 'tool_config_optimization_applied', {
        toolName,
        changeType,
        snapshotId,
        durationMs: elapsedMs,
        currentErrorRate,
      })

      return {
        problemId: problem.id,
        success: true,
        summary: [
          `工具 "${toolName}" 配置已优化（${changeType}）`,
          `变更: ${reason}`,
          `评估快照: ${snapshotId}`,
          `将在下个进化周期评估并自动回滚（如效果不佳）`,
          `耗时: ${elapsedMs}ms`,
        ].join('\n'),
        durationMs: elapsedMs,
        output: JSON.stringify({
          toolName,
          changeType,
          reason,
          snapshotId,
          before: currentConfig,
          after: toolConfigManager.getConfig(toolName),
        }),
      }
    } catch (err: any) {
      log('ERROR', 'tool_config_optimization_executor_error', {
        problemId: problem.id,
        error: err.message,
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `执行配置优化异常: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: err.message,
      }
    } finally {
      this.busy = false
    }
  }

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * 根据优化类型构建配置变更参数
   */
  private buildConfigChange(
    suggestion: string,
    metadata: Record<string, string>,
  ): {
    changeType: ConfigChangeType | null
    newValues: Partial<ToolTunableConfig>
    reason: string
  } {
    switch (suggestion) {
      case 'boost_priority': {
        const delta = parseInt(metadata.priorityDelta ?? '2', 10)
        return {
          changeType: 'priority',
          newValues: { priorityDelta: delta },
          reason: `自动调优: 工具性能优秀（错误率 ${((1 - parseFloat(metadata.currentErrorRate ?? '0')) * 100).toFixed(0)}%, 延迟 ${metadata.avgLatencyMs ?? '?'}ms），提升优先级 +${delta}`,
        }
      }

      case 'reduce_priority': {
        const penalty = Math.abs(parseInt(metadata.priorityDelta ?? '-3', 10))
        return {
          changeType: 'priority',
          newValues: { priorityDelta: -penalty },
          reason: `自动调优: 工具错误率 ${(parseFloat(metadata.currentErrorRate ?? '0') * 100).toFixed(0)}%（${metadata.totalCalls} 次调用），降低优先级 -${penalty}`,
        }
      }

      case 'adjust_timeout': {
        const timeoutMs = parseInt(metadata.suggestedTimeoutMs ?? '30000', 10)
        return {
          changeType: 'timeout',
          newValues: { timeoutMs },
          reason: `自动调优: 工具延迟较高（P95 ${metadata.p95LatencyMs ?? '?'}ms），设置超时 ${timeoutMs}ms`,
        }
      }

      case 'reduce_priority_trend': {
        return {
          changeType: 'priority',
          newValues: { priorityDelta: -2 },
          reason: `自动调优: 工具成功率趋势恶化（${(parseFloat(metadata.currentRate ?? '0') * 100).toFixed(0)}% → ${(parseFloat(metadata.previousRate ?? '0') * 100).toFixed(0)}%），降低优先级 -2`,
        }
      }

      case 'consider_disable': {
        return {
          changeType: 'disable',
          newValues: { enabled: false, priorityDelta: -10 },
          reason: `自动调优: 工具错误率 ${(parseFloat(metadata.currentErrorRate ?? '0') * 100).toFixed(0)}%，暂时禁用`,
        }
      }

      default:
        return { changeType: null, newValues: {}, reason: '' }
    }
  }

  /**
   * 检查工具的当前配置是否已处于目标状态
   */
  private isAlreadyApplied(current: ToolTunableConfig, changeType: ConfigChangeType, newValues: Partial<ToolTunableConfig>): boolean {
    switch (changeType) {
      case 'priority':
        return current.priorityDelta === (newValues.priorityDelta ?? 0)
      case 'timeout':
        return current.timeoutMs === (newValues.timeoutMs ?? null)
      case 'disable':
        return current.enabled === false
      case 'enable':
        return current.enabled === true
      case 'reset':
        return current.priorityDelta === 0 && current.timeoutMs === null && current.maxRetries === null && current.enabled === true
      default:
        return false
    }
  }
}
