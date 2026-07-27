/**
 * MCPCacheOptimizationCollector — MCP 工具缓存策略优化采集器
 *
 * ## 职责
 * 分析 MCP 工具调用延迟数据，识别可通过缓存策略优化提升性能的工具：
 * 1. 高延迟 MCP 工具（avg > 2s）→ 建议加入缓存并设置适当 TTL
 * 2. 高频重复调用工具（相同参数多次调用）→ 建议开启缓存
 * 3. 缓存命中率高但 TTL 过短的工具 → 建议延长 TTL
 * 4. 缓存命中率低但延迟高的工具 → 建议调整缓存策略
 *
 * ## 与 ToolAnalyticsCollector 的职责分工
 * - ToolAnalyticsCollector: 生成优先级/超时/禁用配置建议（关注整体性能指标）
 * - MCPCacheOptimizationCollector: 专门分析缓存策略优化机会（关注缓存效率）
 *   两者互补：前者决定「用什么配置」，后者决定「缓存什么、缓存多久」
 *
 * ## 数据流
 *   ToolAnalytics.analyzeTool() + ToolCallLogStore.query() + ToolCallMemoryCache.getStats()
 *   → MCPCacheOptimizationCollector.collect()
 *   → Problem[]
 *   → PipelineOrchestrator
 *   → MCPCacheOptimizationExecutor.execute()
 *
 * ## 判断条件
 * - 高延迟未缓存: avgLatency > 2s 且工具不在 cacheableTools 中 → 建议开启缓存
 * - 高频重复: 相同参数签名出现 3+ 次且未缓存 → 建议开启缓存
 * - TTL 过短: 缓存命中率高（> 80%）且平均调用间隔 > TTL → 建议延长 TTL
 * - 只读确定性: 工具只读（命名特征）且高延迟 → 建议缓存
 */
import { log } from '../../logger/Logger'
import type { SignalCollector, Problem } from './types'
import { toolAnalytics } from '../../tool/ToolAnalytics'
import { toolCallLogStore } from '../../tool/ToolCallLogStore'
import { toolCallMemoryCache } from '../../tool/ToolCallMemoryCache'

// =============================================================================
// 配置常量
// =============================================================================

const CONFIG = {
  /** 最小样本数：少于该值不生成优化建议 */
  MIN_SAMPLES: 5,
  /** 高延迟阈值（avg > 此毫秒数，建议缓存） */
  HIGH_LATENCY_MS: 2000,
  /** 极高高延迟阈值（avg > 此毫秒数，强烈建议缓存） */
  VERY_HIGH_LATENCY_MS: 10000,
  /** 高频重复阈值：相同参数签名出现此次数以上建议缓存 */
  HIGH_FREQ_REPEAT: 3,
  /** 高缓存命中率阈值 */
  HIGH_HIT_RATE: 0.8,
  /** 最小运行间隔（毫秒） */
  MIN_INTERVAL_MS: 60 * 60 * 1000, // 1 小时
  /** 单次采集最大问题数 */
  MAX_PROBLEMS_PER_RUN: 5,
  /** 工具冷却时间（优化后在此时间内不再生成建议） */
  TOOL_COOLDOWN_MS: 12 * 60 * 60 * 1000, // 12 小时
}

/** 默认只读工具命名模式（匹配只读操作的工具） */
const READONLY_TOOL_PATTERNS = [
  /^get_/,
  /^list_/,
  /^search_/,
  /^query_/,
  /^fetch_/,
  /^read_/,
  /^retrieve_/,
  /^check_/,
  /^describe_/,
  /^status$/,
  /^health$/,
  /_status$/,
  /_info$/,
]

/** 默认写入工具（不应该缓存） */
const WRITE_TOOL_PATTERNS = [
  /^set_/,
  /^write_/,
  /^create_/,
  /^update_/,
  /^delete_/,
  /^remove_/,
  /^send_/,
  /^post_/,
  /^upload_/,
  /^save_/,
]

// =============================================================================
// MCPCacheOptimizationCollector
// =============================================================================

export class MCPCacheOptimizationCollector implements SignalCollector {
  readonly name = 'mcp-cache-optimization-collector'
  readonly source = 'tool' as const

  private lastRun = 0
  /** 工具 → 上次生成问题的时间戳（冷却列表） */
  private toolCooldowns = new Map<string, number>()

  shouldRun(): boolean {
    return Date.now() - this.lastRun >= CONFIG.MIN_INTERVAL_MS
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const problems: Problem[] = []

    try {
      // ── 阶段 1: 获取全量工具分析报告 ──
      const summary = toolAnalytics.analyzeAll()

      if (summary.totalCalls < CONFIG.MIN_SAMPLES) {
        log('INFO', 'mcp_cache_opt_collector_insufficient_data', {
          totalCalls: summary.totalCalls,
        })
        return []
      }

      log('INFO', 'mcp_cache_opt_collector_analysis', {
        totalTools: summary.totalTools,
        totalCalls: summary.totalCalls,
      })

      // ── 阶段 2: 获取当前缓存状态快照 ──
      const cacheStats = toolCallMemoryCache.getStats()
      const currentlyCached = new Set(cacheStats.cacheableTools)

      // ── 阶段 3: 逐个工具分析缓存优化机会 ──
      for (const report of summary.reports) {
        // 跳过样本不足的工具
        if (report.totalCalls < CONFIG.MIN_SAMPLES) continue

        // 检查冷却
        if (this.isOnCooldown(report.toolName)) continue

        // 跳过明确不允许缓存的写入工具
        if (this.isWriteTool(report.toolName)) continue

        const isCached = currentlyCached.has(report.toolName)
        const isReadonly = this.isReadonlyTool(report.toolName)

        let problem: Problem | null = null

        // ── 条件 A: 高延迟 + 只读 + 未缓存 → 强烈建议缓存 ──
        if (!isCached && isReadonly && report.latency) {
          if (report.latency.avg > CONFIG.VERY_HIGH_LATENCY_MS) {
            problem = this.buildCacheProblem(report, 'add_cache_high_latency', 'critical')
          } else if (report.latency.avg > CONFIG.HIGH_LATENCY_MS) {
            problem = this.buildCacheProblem(report, 'add_cache_high_latency', 'warning')
          }
        }

        // ── 条件 B: 高频重复调用（相同参数多次）→ 建议缓存 ──
        if (!isCached && !problem) {
          const repeatCount = this.detectRepeatedCalls(report.toolName)
          if (repeatCount >= CONFIG.HIGH_FREQ_REPEAT) {
            problem = this.buildCacheProblem(report, 'add_cache_frequent_repeat', 'warning',
              `检测到 ${repeatCount} 次重复调用（相同参数），开启缓存可消除 ${repeatCount - 1} 次重复执行`)
          }
        }

        // ── 条件 C: 高延迟 + 未缓存（通用）→ 建议缓存 ──
        if (!isCached && !problem && report.latency && report.latency.avg > CONFIG.HIGH_LATENCY_MS) {
          problem = this.buildCacheProblem(report, 'add_cache_latency', 'info')
        }

        // ── 条件 D: 已缓存但 TTL 过短 → 建议延长 TTL ──
        if (isCached && !problem && cacheStats.hitRate >= CONFIG.HIGH_HIT_RATE) {
          const ttlSuggestion = this.suggestTtlExtension(report.toolName, report.latency)
          if (ttlSuggestion) {
            problem = this.buildTtlProblem(report, ttlSuggestion)
          }
        }

        // ── 条件 E: 已缓存但命中率极低 → 建议检查缓存策略 ──
        if (isCached && !problem && cacheStats.hitRate < 0.2 && report.totalCalls > 10) {
          problem = this.buildCacheReviewProblem(report)
        }

        if (problem) {
          problems.push(problem)
          this.toolCooldowns.set(report.toolName, Date.now() + CONFIG.TOOL_COOLDOWN_MS)
        }

        if (problems.length >= CONFIG.MAX_PROBLEMS_PER_RUN) break
      }

      log('INFO', 'mcp_cache_opt_collector_done', {
        problemsFound: problems.length,
        tools: problems.map((p) => p.context.metadata?.toolName).join(', '),
      })

      return problems
    } catch (err: any) {
      log('ERROR', 'mcp_cache_opt_collector_error', { error: err.message })
      return []
    }
  }

  // =========================================================================
  // 内部方法：问题构建
  // =========================================================================

  /**
   * 构建「建议开启缓存」的问题
   */
  private buildCacheProblem(
    report: any,
    suggestion: string,
    severity: 'critical' | 'warning' | 'info',
    customReason?: string,
  ): Problem {
    const isReadonly = this.isReadonlyTool(report.toolName)
    const suggestedTTL = this.suggestDefaultTTL(report)
    const reason = customReason || this.buildCacheReason(report)

    return {
      id: `mcp_cache_opt:${report.toolName}:${suggestion}:${Date.now()}`,
      source: 'tool',
      severity: severity === 'critical' ? 'error' : severity === 'warning' ? 'warning' : 'info',
      title: `MCP 工具 "${report.toolName}" ${this.buildTitle(report, suggestion)}`,
      description: reason,
      estimatedCostChars: 80,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: {
        raw: [
          `MCP 工具缓存优化分析:`,
          `工具名: ${report.toolName}`,
          `平均延迟: ${report.latency?.avg ?? '?'}ms`,
          `P95 延迟: ${report.latency?.p95 ?? '?'}ms`,
          `总调用: ${report.totalCalls} 次`,
          `成功率: ${((1 - report.errorRate) * 100).toFixed(1)}%`,
          `优化类型: ${suggestion}`,
          `建议 TTL: ${suggestedTTL}ms`,
          `工具性质: ${isReadonly ? '只读（适合缓存）' : '读写混合（需谨慎缓存）'}`,
        ].join('\n'),
        metadata: {
          toolName: report.toolName,
          suggestion,
          avgLatencyMs: String(report.latency?.avg ?? 0),
          p95LatencyMs: String(report.latency?.p95 ?? 0),
          totalCalls: String(report.totalCalls),
          successRate: String(1 - report.errorRate),
          suggestedTTL: String(suggestedTTL),
          isReadonly: String(isReadonly),
        },
      },
    }
  }

  /**
   * 构建「建议调整 TTL」的问题
   */
  private buildTtlProblem(
    report: any,
    ttlSuggestion: { currentTTL: number; suggestedTTL: number; reason: string },
  ): Problem {
    return {
      id: `mcp_cache_opt:${report.toolName}:adjust_ttl:${Date.now()}`,
      source: 'tool',
      severity: 'info',
      title: `MCP 工具 "${report.toolName}" 缓存 TTL 可优化`,
      description: ttlSuggestion.reason,
      estimatedCostChars: 50,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: {
        raw: [
          `MCP 工具缓存 TTL 优化分析:`,
          `工具名: ${report.toolName}`,
          `当前 TTL: ${ttlSuggestion.currentTTL}ms`,
          `建议 TTL: ${ttlSuggestion.suggestedTTL}ms`,
          `原因: ${ttlSuggestion.reason}`,
        ].join('\n'),
        metadata: {
          toolName: report.toolName,
          suggestion: 'adjust_ttl',
          currentTTL: String(ttlSuggestion.currentTTL),
          suggestedTTL: String(ttlSuggestion.suggestedTTL),
          reason: ttlSuggestion.reason,
        },
      },
    }
  }

  /**
   * 构建「缓存策略需审查」的问题
   */
  private buildCacheReviewProblem(report: any): Problem {
    return {
      id: `mcp_cache_opt:${report.toolName}:review_cache:${Date.now()}`,
      source: 'tool',
      severity: 'info',
      title: `MCP 工具 "${report.toolName}" 缓存命中率低，建议检查缓存策略`,
      description: `工具 "${report.toolName}" 的缓存命中率低于 20%，但已开启缓存。可能原因是参数变化频繁或不适合缓存。建议检查是否应移除缓存或调整缓存键的构建方式。`,
      estimatedCostChars: 60,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: {
        raw: [
          `MCP 工具缓存命中率分析:`,
          `工具名: ${report.toolName}`,
          `总调用: ${report.totalCalls} 次`,
          `缓存命中率: < 20%`,
          `平均延迟: ${report.latency?.avg ?? '?'}ms`,
          `建议: 检查是否需要移除此工具的缓存`,
        ].join('\n'),
        metadata: {
          toolName: report.toolName,
          suggestion: 'review_cache',
          totalCalls: String(report.totalCalls),
          avgLatencyMs: String(report.latency?.avg ?? 0),
        },
      },
    }
  }

  // =========================================================================
  // 内部方法：辅助逻辑
  // =========================================================================

  /**
   * 判断工具是否为只读（适合缓存）
   */
  private isReadonlyTool(toolName: string): boolean {
    return READONLY_TOOL_PATTERNS.some((p) => p.test(toolName))
  }

  /**
   * 判断工具是否为写入工具（不适合缓存）
   */
  private isWriteTool(toolName: string): boolean {
    return WRITE_TOOL_PATTERNS.some((p) => p.test(toolName))
  }

  /**
   * 检测相同参数签名的重复调用次数
   */
  private detectRepeatedCalls(toolName: string): number {
    const records = toolCallLogStore.query({
      toolName,
      success: true,
      limit: 20,
    })

    if (records.length < 2) return 0

    // 按参数签名分组
    const sigCounts = new Map<string, number>()
    for (const r of records) {
      const sig = this.buildArgSignature(r.args)
      sigCounts.set(sig, (sigCounts.get(sig) || 0) + 1)
    }

    // 返回最频繁的参数签名的重复次数
    let maxCount = 0
    for (const count of sigCounts.values()) {
      if (count > maxCount) maxCount = count
    }

    return maxCount
  }

  /**
   * 根据工具特性建议默认 TTL
   */
  private suggestDefaultTTL(report: any): number {
    // 极高延迟 + 只读 → 长 TTL（10分钟）
    if (this.isReadonlyTool(report.toolName) && report.latency?.avg > CONFIG.VERY_HIGH_LATENCY_MS) {
      return 10 * 60 * 1000
    }
    // 高延迟 + 只读 → 中 TTL（5分钟）
    if (this.isReadonlyTool(report.toolName) && report.latency?.avg > CONFIG.HIGH_LATENCY_MS) {
      return 5 * 60 * 1000
    }
    // 高延迟 → 短 TTL（2分钟）
    if (report.latency?.avg > CONFIG.HIGH_LATENCY_MS) {
      return 2 * 60 * 1000
    }
    // 默认
    return 60 * 1000
  }

  /**
   * 构建缓存建议的原因描述
   */
  private buildCacheReason(report: any): string {
    const parts: string[] = []
    parts.push(`工具 "${report.toolName}" `)

    if (report.latency) {
      parts.push(`平均延迟 ${report.latency.avg}ms`)
      if (report.latency.p95) {
        parts.push(`(P95 ${report.latency.p95}ms)`)
      }
    }

    if (this.isReadonlyTool(report.toolName)) {
      parts.push('，工具为只读操作，适合缓存')
    } else {
      parts.push('，建议开启缓存以减少重复调用')
    }

    const suggestedTTL = this.suggestDefaultTTL(report)
    parts.push(`。建议 TTL: ${(suggestedTTL / 1000).toFixed(0)}s`)

    return parts.join('')
  }

  /**
   * 构建问题标题后缀
   */
  private buildTitle(report: any, suggestion: string): string {
    switch (suggestion) {
      case 'add_cache_high_latency':
        return '延迟较高，建议开启缓存'
      case 'add_cache_frequent_repeat':
        return '重复调用频繁，建议开启缓存'
      case 'add_cache_latency':
        return '可开启缓存以优化性能'
      default:
        return '建议优化缓存策略'
    }
  }

  /**
   * 建议 TTL 延长的具体值
   */
  private suggestTtlExtension(
    toolName: string,
    latency: any,
  ): { currentTTL: number; suggestedTTL: number; reason: string } | null {
    // 获取当前缓存配置
    const config = toolCallMemoryCache.getConfig()

    // 缓存条目中查找此工具的 TTL
    const entries = toolCallMemoryCache.getCacheSnapshot(toolName)
    if (entries.length === 0) return null

    // 计算实际平均 TTL
    const avgTTL = entries.reduce((s, e) => s + (e.expiresAt - e.createdAt), 0) / entries.length
    const avgHitCount = entries.reduce((s, e) => s + e.hitCount, 0) / entries.length

    // 如果命中率 > 80% 且平均命中 > 1，说明缓存很有价值
    if (avgHitCount >= 1 && avgTTL > 0) {
      const suggestedTTL = Math.round(avgTTL * 2) // 建议翻倍
      // 但不超过 30 分钟
      const cappedTTL = Math.min(suggestedTTL, 30 * 60 * 1000)

      if (cappedTTL > avgTTL + 1000) {
        return {
          currentTTL: Math.round(avgTTL),
          suggestedTTL: cappedTTL,
          reason: `缓存命中率高（平均 ${avgHitCount.toFixed(1)} 次命中），当前 TTL ${Math.round(avgTTL / 1000)}s 可延长至 ${Math.round(cappedTTL / 1000)}s 以减少重复调用`,
        }
      }
    }

    return null
  }

  /**
   * 从工具参数构建签名（用于检测重复调用）
   */
  private buildArgSignature(args: Record<string, any>): string {
    const parts: string[] = []
    for (const [key, value] of Object.entries(args)) {
      if (key.startsWith('_')) continue
      if (typeof value === 'string') {
        parts.push(`${key}=${value.slice(0, 60)}`)
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        parts.push(`${key}=${String(value)}`)
      }
    }
    return parts.sort().join('&')
  }

  /**
   * 检查工具是否在冷却中
   */
  private isOnCooldown(toolName: string): boolean {
    const until = this.toolCooldowns.get(toolName)
    if (!until) return false
    if (Date.now() > until) {
      this.toolCooldowns.delete(toolName)
      return false
    }
    return true
  }
}
