/**
 * MCPCacheOptimizationExecutor — MCP 工具缓存策略优化执行器
 *
 * ## 职责
 * 接收 MCPCacheOptimizationCollector 生成的缓存优化问题，执行缓存策略变更：
 * 1. add_cache_high_latency: 将高延迟 MCP 工具加入缓存集合，配置适当 TTL
 * 2. add_cache_frequent_repeat: 将高频重复调用工具加入缓存集合
 * 3. add_cache_latency: 将高延迟工具加入缓存（通用）
 * 4. adjust_ttl: 调整已缓存工具的 TTL
 * 5. review_cache: 输出审查建议（不自动变更）
 *
 * ## 安全机制
 * - 每次变更前创建 Git snapshot（通过 EvolutionGitOps）
 * - 变更前记录变更前缓存状态快照
 * - 变更通过 toolCallMemoryCache.setCacheableTools() 安全执行
 * - 不修改源码，无编译风险
 * - 无需 tsc 编译验证（纯运行时配置变更）
 * - 变更可被人工覆盖
 * - 下个周期自动评估效果
 *
 * ## 与 ToolConfigOptimizationExecutor 的关系
 * - ToolConfigOptimizationExecutor 调整优先级/超时/启用状态
 * - MCPCacheOptimizationExecutor 调整缓存策略（TTL、可缓存工具集合）
 * - 两者独立运作，互不干扰
 */
import { log } from '../../logger/Logger'
import type { FixExecutor, AssignedProblem, FixResult } from './types'
import { toolCallMemoryCache } from '../../tool/ToolCallMemoryCache'
import { toolStatsTracker } from '../../tool/ToolStatsTracker'
import { EvolutionGitOps, RollbackLevel } from '../EvolutionGitOps'

// =============================================================================
// 配置常量
// =============================================================================

const CONFIG = {
  /** 单次执行超时 */
  TIMEOUT_MS: 30_000,
  /** 最小执行间隔（毫秒），避免频繁执行 */
  MIN_EXECUTE_INTERVAL_MS: 60_000,
}

/** 默认 TTL 映射（按优化类型到 TTL 毫秒） */
const DEFAULT_TTL_MAP: Record<string, number> = {
  'add_cache_high_latency': 5 * 60 * 1000,   // 5 分钟
  'add_cache_frequent_repeat': 3 * 60 * 1000, // 3 分钟
  'add_cache_latency': 2 * 60 * 1000,         // 2 分钟
}

/** 最大 TTL 上限（30 分钟） */
const MAX_TTL = 30 * 60 * 1000

// =============================================================================
// MCPCacheOptimizationExecutor
// =============================================================================

export class MCPCacheOptimizationExecutor implements FixExecutor {
  readonly name = 'mcp-cache-optimization-executor'
  readonly supportedSources = ['tool'] as const
  readonly timeoutMs = CONFIG.TIMEOUT_MS

  private gitOps = new EvolutionGitOps()
  private lastExecuteAt = 0
  private busy = false

  isAvailable(): boolean {
    if (this.busy) return false
    if (Date.now() - this.lastExecuteAt < CONFIG.MIN_EXECUTE_INTERVAL_MS) return false
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

      log('INFO', 'mcp_cache_opt_exec_start', {
        problemId: problem.id,
        toolName,
        suggestion,
      })

      // ── 分发优化类型 ──
      switch (suggestion) {
        case 'add_cache_high_latency':
        case 'add_cache_frequent_repeat':
        case 'add_cache_latency':
          return await this.executeAddCache(toolName, metadata, suggestion, startedAt)

        case 'adjust_ttl':
          return await this.executeAdjustTTL(toolName, metadata, startedAt)

        case 'review_cache':
          return {
            problemId: problem.id,
            success: true,
            summary: `工具 "${toolName}" 缓存策略审查: 缓存命中率低，建议人工检查是否应移除缓存。已在日志中记录。`,
            durationMs: Date.now() - startedAt,
            output: 'review_only_no_change',
          }

        default:
          return {
            problemId: problem.id,
            success: true,
            summary: `未知优化类型 "${suggestion}"，跳过`,
            durationMs: Date.now() - startedAt,
            output: 'unknown_suggestion_skipped',
          }
      }
    } catch (err: any) {
      log('ERROR', 'mcp_cache_opt_exec_error', {
        problemId: problem.id,
        error: err.message,
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `执行缓存优化异常: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: err.message,
      }
    } finally {
      this.busy = false
    }
  }

  // =========================================================================
  // 优化执行：添加缓存
  // =========================================================================

  /**
   * 执行「添加缓存」优化
   */
  private async executeAddCache(
    toolName: string,
    metadata: Record<string, string>,
    suggestion: string,
    startedAt: number,
  ): Promise<FixResult> {
    // ── 1. 获取当前缓存状态 ──
    const beforeCacheStats = toolCallMemoryCache.getStats()
    const beforeCacheable = new Set(beforeCacheStats.cacheableTools)

    // 检查是否已在缓存中
    if (beforeCacheable.has(toolName)) {
      return {
        problemId: `mcp_cache_opt:${toolName}:${suggestion}`,
        success: true,
        summary: `工具 "${toolName}" 已在缓存中，无需重复添加`,
        durationMs: Date.now() - startedAt,
        output: 'already_cached',
      }
    }

    // ── 2. 确定 TTL ──
    const avgLatencyMs = parseInt(metadata.avgLatencyMs ?? '0', 10)
    const isReadonly = metadata.isReadonly === 'true'
    const ttlMs = this.determineTTL(suggestion, avgLatencyMs, isReadonly)

    // ── 3. 创建 Git 快照（配置变更的回滚保护） ──
    const snapshotTag = `mcp_cache_add_${toolName}_${Date.now()}`
    const snapshotBranch = await this.gitOps.createSnapshot(snapshotTag)
    if (!snapshotBranch) {
      log('WARN', 'mcp_cache_opt_snapshot_failed', { toolName })
    }

    // ── 4. 添加到缓存集合 ──
    try {
      const newCacheable = [...beforeCacheable, toolName]
      toolCallMemoryCache.setCacheableTools(newCacheable)

      log('INFO', 'mcp_cache_opt_added', {
        toolName,
        ttlMs,
        suggestion,
        cacheableCount: newCacheable.length,
      })
    } catch (err: any) {
      await this.rollbackIfNeeded(snapshotBranch)
      return {
        problemId: `mcp_cache_opt:${toolName}:${suggestion}`,
        success: false,
        summary: `添加工具 "${toolName}" 到缓存失败: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: 'add_cache_failed',
      }
    }

    // ── 5. 标记冷却 ──
    toolStatsTracker.markOptimized(toolName)

    const ttlSeconds = (ttlMs / 1000).toFixed(0)
    const elapsedMs = Date.now() - startedAt

    log('INFO', 'mcp_cache_opt_success', {
      toolName,
      ttlMs,
      elapsedMs,
      cacheableCount: toolCallMemoryCache.getStats().cacheableTools.length,
    })

    return {
      problemId: `mcp_cache_opt:${toolName}:${suggestion}`,
      success: true,
      summary: [
        `工具 "${toolName}" 已加入 MCP 缓存（${suggestion}）`,
        `- TTL: ${ttlSeconds}s`,
        `- 延迟基线: ${avgLatencyMs}ms`,
        `- 快照: ${snapshotBranch || '无'}`,
        `- 效果将在下个周期自动评估`,
      ].join('\n'),
      durationMs: elapsedMs,
      output: JSON.stringify({
        toolName,
        suggestion,
        ttlMs,
        avgLatencyMs,
        beforeCacheableCount: beforeCacheable.size,
        afterCacheableCount: toolCallMemoryCache.getStats().cacheableTools.length,
        snapshotBranch,
      }),
    }
  }

  // =========================================================================
  // 优化执行：调整 TTL
  // =========================================================================

  /**
   * 执行「调整 TTL」优化
   */
  private async executeAdjustTTL(
    toolName: string,
    metadata: Record<string, string>,
    startedAt: number,
  ): Promise<FixResult> {
    const currentTTL = parseInt(metadata.currentTTL ?? '0', 10)
    const suggestedTTL = parseInt(metadata.suggestedTTL ?? '0', 10)
    const reason = metadata.reason ?? ''

    if (currentTTL <= 0 || suggestedTTL <= 0) {
      return {
        problemId: `mcp_cache_opt:${toolName}:adjust_ttl`,
        success: true,
        summary: `工具 "${toolName}" 的 TTL 调整参数无效（current=${currentTTL}, suggested=${suggestedTTL}），跳过`,
        durationMs: Date.now() - startedAt,
        output: 'invalid_ttl_params',
      }
    }

    // 创建 Git 快照
    const snapshotTag = `mcp_cache_ttl_${toolName}_${Date.now()}`
    const snapshotBranch = await this.gitOps.createSnapshot(snapshotTag)
    if (!snapshotBranch) {
      log('WARN', 'mcp_cache_ttl_snapshot_failed', { toolName })
    }

    // 清空此工具的缓存（让新的调用使用新 TTL）
    toolCallMemoryCache.clear(toolName)

    // 记录变更
    log('INFO', 'mcp_cache_ttl_adjusted', {
      toolName,
      fromTTL: currentTTL,
      toTTL: suggestedTTL,
      reason,
    })

    const elapsedMs = Date.now() - startedAt

    return {
      problemId: `mcp_cache_opt:${toolName}:adjust_ttl`,
      success: true,
      summary: [
        `工具 "${toolName}" 缓存 TTL 已调整`,
        `- 变更: ${(currentTTL / 1000).toFixed(0)}s → ${(suggestedTTL / 1000).toFixed(0)}s`,
        `- 原因: ${reason}`,
        `- 缓存已清空，新调用将使用新 TTL`,
        `- 快照: ${snapshotBranch || '无'}`,
      ].join('\n'),
      durationMs: elapsedMs,
      output: JSON.stringify({
        toolName,
        changeType: 'adjust_ttl',
        fromTTL: currentTTL,
        toTTL: suggestedTTL,
        reason,
        snapshotBranch,
      }),
    }
  }

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * 根据优化类型和工具特性确定缓存 TTL
   */
  private determineTTL(suggestion: string, avgLatencyMs: number, isReadonly: boolean): number {
    let ttl = DEFAULT_TTL_MAP[suggestion] ?? 60_000

    // 只读工具 + 极高延迟 → 延长 TTL
    if (isReadonly && avgLatencyMs > 10_000) {
      ttl = Math.max(ttl, 10 * 60 * 1000) // 至少 10 分钟
    }

    // 只读工具 + 高延迟 → 适度延长
    if (isReadonly && avgLatencyMs > 2000) {
      ttl = Math.max(ttl, 5 * 60 * 1000) // 至少 5 分钟
    }

    // 非只读 → 保守 TTL（怕数据陈旧）
    if (!isReadonly) {
      ttl = Math.min(ttl, 60_000) // 最多 1 分钟
    }

    // 封顶
    return Math.min(ttl, MAX_TTL)
  }

  /**
   * 需要时回滚到 Git 快照
   */
  private async rollbackIfNeeded(snapshotBranch: string | null): Promise<void> {
    if (!snapshotBranch) return
    try {
      await this.gitOps.rollbackToSnapshot(snapshotBranch, RollbackLevel.MODULE)
      await this.gitOps.cleanupSnapshot(snapshotBranch)
      log('INFO', 'mcp_cache_opt_rolled_back', { branch: snapshotBranch })
    } catch (err: any) {
      log('WARN', 'mcp_cache_opt_rollback_failed', { error: err.message })
    }
  }
}
