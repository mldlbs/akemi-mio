/**
 * FailurePatternAnalyzer — 工具调用失败模式分析器
 *
 * 职责：
 * 1. 从 ToolCallLogStore 读取历史调用记录
 * 2. 识别超越简单错误率阈值的具体失败模式
 * 3. 发现特定参数值与特定错误类型的关联（如：path 含特殊字符 → ENOENT）
 * 4. 为每种模式匹配最合适的修复模板
 *
 * 与 ToolStatsTracker 的区别：
 * - ToolStatsTracker：计算每个工具的错误率和频次（宏观视角）
 * - FailurePatternAnalyzer：发现特定参数模式下的失败规律（微观视角）
 *
 * 模式类型：
 * - ARGUMENT_ERROR: 特定参数值导致参数校验错误
 * - TIMEOUT_ERROR: 特定参数范围导致超时
 * - TRANSIENT_ERROR: 特定参数模式下间歇性失败
 * - TOOL_MISSING: 工具在某些环境下不可用
 * - PERMISSION_ERROR: 特定路径/命令的权限不足
 * - HIGH_FREQUENCY_ERROR: 无明显参数模式但高频率失败
 */

import { log } from '../logger/Logger'
import { toolCallLogStore, type ToolCallRecord } from './ToolCallLogStore'
import { ToolErrorType } from './ToolErrorType'

// =============================================================================
// 类型定义
// =============================================================================

export type FailurePatternType =
  | 'argument_error'
  | 'timeout_error'
  | 'transient_error'
  | 'tool_missing'
  | 'permission_error'
  | 'high_frequency_error'
  | 'cache_error'

export type FixTemplateType = 'retry_wrapper' | 'param_validator' | 'timeout_wrapper' | 'error_handler' | 'fallback_tool' | 'cache_wrapper'

/** 参数模式片段：某个参数的值模式与该模式下的失败率 */
export interface ArgPatternMatch {
  param: string
  valuePattern: string // 值的描述，如 "包含特殊字符"、"空字符串"、"路径超出工作区"
  failureRate: number  // 该模式下调用失败的比率
  sampleCount: number
  sampleError: string  // 样本错误消息
}

/** 识别出的失败模式 */
export interface FailurePattern {
  id: string
  toolName: string
  type: FailurePatternType
  /** 模式描述 */
  description: string
  /** 匹配的具体参数模式（如果有） */
  argPatterns: ArgPatternMatch[]
  /** 该模式出现次数 */
  frequency: number
  /** 总调用次数（包含成功和失败） */
  totalCalls: number
  /** 该模式下的失败率 */
  failureRate: number
  /** 建议的修复模板类型 */
  suggestedFix: FixTemplateType
  /** 分析置信度 (0-1) */
  confidence: number
  /** 样本错误消息（前三） */
  sampleErrors: string[]
  /** 建议的修复描述 */
  fixDescription: string
  /** 受影响的参数列表 */
  affectedParams: string[]
}

// =============================================================================
// 配置
// =============================================================================

const ANALYSIS_CONFIG = {
  /** 最小样本数：少于该数量不做模式分析 */
  MIN_SAMPLES: 3,
  /** 参数值频繁度阈值：参数某个值的出现次数超过此值才视为模式 */
  MIN_ARG_FREQUENCY: 2,
  /** 参数模式失败率阈值：超过此值才报告 */
  ARG_FAILURE_RATE_THRESHOLD: 0.5,
  /** 高频错误最小失败次数 */
  HIGH_FREQ_MIN_FAILURES: 5,
  /** 最大返回模式数 */
  MAX_PATTERNS: 10,
}

// =============================================================================
// FailurePatternAnalyzer 实现
// =============================================================================

export class FailurePatternAnalyzer {
  /**
   * 分析指定工具的历史调用记录，识别失败模式
   */
  analyzeTool(toolName: string, maxSamples: number = 50): FailurePattern[] {
    const patterns: FailurePattern[] = []

    // 获取失败记录
    const failedCalls = toolCallLogStore.getRawFailedCalls(toolName, maxSamples)
    if (failedCalls.length < ANALYSIS_CONFIG.MIN_SAMPLES) {
      return []
    }

    // 获取成功记录（用于对比分析）
    const successCalls = toolCallLogStore.getHistoricalSuccessfulCalls(toolName, maxSamples)
    const allCalls = [...failedCalls, ...successCalls]

    // =========================================================
    // 1. ARGUMENT_ERROR 模式：按参数值分组分析
    // =========================================================
    const argPatterns = this.analyzeArgPatterns(failedCalls, allCalls, toolName)
    if (argPatterns.length > 0) {
      const worstPattern = argPatterns.reduce((a, b) => (a.failureRate > b.failureRate ? a : b))
      const affectedParams = [...new Set(argPatterns.map((p) => p.param))]
      patterns.push({
        id: `fp:${toolName}:argument`,
        toolName,
        type: 'argument_error',
        description: `工具 "${toolName}" 的参数模式问题: ${worstPattern.param}=${worstPattern.valuePattern} 的失败率为 ${(worstPattern.failureRate * 100).toFixed(0)}%`,
        argPatterns,
        frequency: failedCalls.length,
        totalCalls: allCalls.length,
        failureRate: failedCalls.length / Math.max(allCalls.length, 1),
        suggestedFix: 'param_validator',
        confidence: Math.min(worstPattern.failureRate, 0.95),
        sampleErrors: [...new Set(failedCalls.slice(0, 3).map((r) => r.error).filter(Boolean) as string[])],
        fixDescription: `为 "${toolName}" 添加参数校验，检查 ${affectedParams.join(', ')} 的合法性`,
        affectedParams,
      })
    }

    // =========================================================
    // 2. TIMEOUT_ERROR 模式
    // =========================================================
    const timeoutCalls = failedCalls.filter(
      (r) => r.errorType === ToolErrorType.TRANSIENT && r.error?.toLowerCase().includes('timeout'),
    )
    if (timeoutCalls.length >= ANALYSIS_CONFIG.MIN_SAMPLES) {
      patterns.push({
        id: `fp:${toolName}:timeout`,
        toolName,
        type: 'timeout_error',
        description: `工具 "${toolName}" 出现 ${timeoutCalls.length} 次超时，占失败总数的 ${((timeoutCalls.length / failedCalls.length) * 100).toFixed(0)}%`,
        argPatterns: [],
        frequency: timeoutCalls.length,
        totalCalls: allCalls.length,
        failureRate: timeoutCalls.length / Math.max(allCalls.length, 1),
        suggestedFix: 'timeout_wrapper',
        confidence: Math.min(timeoutCalls.length / failedCalls.length, 0.9),
        sampleErrors: [...new Set(timeoutCalls.slice(0, 3).map((r) => r.error).filter(Boolean) as string[])],
        fixDescription: `为 "${toolName}" 添加超时控制和重试机制`,
        affectedParams: [],
      })
    }

    // =========================================================
    // 3. TRANSIENT_ERROR 模式
    // =========================================================
    const transientCalls = failedCalls.filter(
      (r) => r.errorType === ToolErrorType.TRANSIENT && !r.error?.toLowerCase().includes('timeout'),
    )
    if (transientCalls.length >= ANALYSIS_CONFIG.MIN_SAMPLES) {
      patterns.push({
        id: `fp:${toolName}:transient`,
        toolName,
        type: 'transient_error',
        description: `工具 "${toolName}" 出现 ${transientCalls.length} 次临时性错误（如网络中断、连接重置）`,
        argPatterns: [],
        frequency: transientCalls.length,
        totalCalls: allCalls.length,
        failureRate: transientCalls.length / Math.max(allCalls.length, 1),
        suggestedFix: 'retry_wrapper',
        confidence: Math.min(transientCalls.length / failedCalls.length, 0.85),
        sampleErrors: [...new Set(transientCalls.slice(0, 3).map((r) => r.error).filter(Boolean) as string[])],
        fixDescription: `为 "${toolName}" 添加自动重试机制（指数退避，最多 3 次）`,
        affectedParams: [],
      })
    }

    // =========================================================
    // 4. PERMISSION_ERROR 模式
    // =========================================================
    const permCalls = failedCalls.filter((r) => r.errorType === ToolErrorType.PERMISSION)
    if (permCalls.length >= ANALYSIS_CONFIG.MIN_SAMPLES) {
      patterns.push({
        id: `fp:${toolName}:permission`,
        toolName,
        type: 'permission_error',
        description: `工具 "${toolName}" 出现 ${permCalls.length} 次权限错误`,
        argPatterns: [],
        frequency: permCalls.length,
        totalCalls: allCalls.length,
        failureRate: permCalls.length / Math.max(allCalls.length, 1),
        suggestedFix: 'error_handler',
        confidence: Math.min(permCalls.length / failedCalls.length, 0.9),
        sampleErrors: [...new Set(permCalls.slice(0, 3).map((r) => r.error).filter(Boolean) as string[])],
        fixDescription: `改进 "${toolName}" 的权限错误提示和降级处理`,
        affectedParams: [],
      })
    }

    // =========================================================
    // 5. CACHE_ERROR 模式：同一参数重复调用且响应一致
    //    高频重复执行相同查询的工具适合添加缓存
    // =========================================================
    const cachePattern = this.analyzeCachePattern(failedCalls, allCalls, toolName)
    if (cachePattern) {
      patterns.push(cachePattern)
    }

    // =========================================================
    // 6. HIGH_FREQUENCY_ERROR 模式：无明显参数模式但高频失败
    // =========================================================
    const remainingFailures = failedCalls.length -
      patterns.reduce((sum, p) => sum + p.frequency, 0)
    if (remainingFailures >= ANALYSIS_CONFIG.HIGH_FREQ_MIN_FAILURES) {
      patterns.push({
        id: `fp:${toolName}:high_freq`,
        toolName,
        type: 'high_frequency_error',
        description: `工具 "${toolName}" 有 ${remainingFailures} 次未归类失败，总错误率 ${(failedCalls.length / Math.max(allCalls.length, 1) * 100).toFixed(0)}%`,
        argPatterns: [],
        frequency: remainingFailures,
        totalCalls: allCalls.length,
        failureRate: remainingFailures / Math.max(allCalls.length, 1),
        suggestedFix: 'error_handler',
        confidence: 0.6,
        sampleErrors: [...new Set(failedCalls.slice(0, 3).map((r) => r.error).filter(Boolean) as string[])],
        fixDescription: `综合改进 "${toolName}" 的错误处理和健壮性`,
        affectedParams: [],
      })
    }

    return patterns.slice(0, ANALYSIS_CONFIG.MAX_PATTERNS)
  }

  /**
   * 分析参数模式：按参数名+值的组合统计失败率
   */
  private analyzeArgPatterns(
    failedCalls: ToolCallRecord[],
    allCalls: ToolCallRecord[],
    toolName: string,
  ): ArgPatternMatch[] {
    const patterns: ArgPatternMatch[] = []

    // 收集所有字符串参数及其值
    const argValueFrequency = new Map<string, Map<string, { fail: number; total: number }>>()

    for (const call of allCalls) {
      for (const [key, value] of Object.entries(call.args)) {
        if (key.startsWith('_')) continue // 跳过元数据参数
        if (typeof value !== 'string') continue

        // 对路径参数使用简化值
        const simplified = this.simplifyArgValue(key, value)

        if (!argValueFrequency.has(key)) {
          argValueFrequency.set(key, new Map())
        }
        const innerMap = argValueFrequency.get(key)!
        if (!innerMap.has(simplified)) {
          innerMap.set(simplified, { fail: 0, total: 0 })
        }
        const entry = innerMap.get(simplified)!
        entry.total++
        if (!call.success) {
          entry.fail++
        }
      }
    }

    // 找出高频失败模式
    for (const [param, values] of argValueFrequency) {
      for (const [valuePattern, stats] of values) {
        if (stats.total < ANALYSIS_CONFIG.MIN_ARG_FREQUENCY) continue
        if (stats.fail < 1) continue
        const failureRate = stats.fail / stats.total
        if (failureRate < ANALYSIS_CONFIG.ARG_FAILURE_RATE_THRESHOLD) continue

        // 从失败记录中找到一条样本错误
        const sampleFailed = failedCalls.find((r) => {
          const v = r.args[param]
          return typeof v === 'string' && this.simplifyArgValue(param, v) === valuePattern
        })

        patterns.push({
          param,
          valuePattern,
          failureRate,
          sampleCount: stats.total,
          sampleError: sampleFailed?.error || '',
        })
      }
    }

    return patterns.sort((a, b) => b.failureRate - a.failureRate).slice(0, 5)
  }

  /**
   * 简化参数值以进行模式匹配
   * 对路径参数使用类型分类而非具体路径
   */
  private simplifyArgValue(key: string, value: string): string {
    if (key === 'path' || key === 'file' || key === 'directory' || key.endsWith('Path') || key.endsWith('Dir')) {
      // 将路径分类
      if (value.startsWith('/') || value.includes(':\\')) return 'absolute_path'
      if (value.startsWith('.')) return 'relative_path'
      if (value.includes('*') || value.includes('?')) return 'glob_pattern'
      return 'simple_path'
    }
    // 对过长字符串截断
    if (value.length > 80) return value.slice(0, 80) + '...'
    return value
  }

  /**
   * 分析缓存模式：同一参数组合在短期内被重复调用
   * 适合添加缓存的场景：
   * 1. 同一工具、同一参数组合在短期内被调用多次
   * 2. 调用结果无明显变化（只读操作）
   * 3. 调用频率高，缓存能显著减少重复计算/IO
   */
  private analyzeCachePattern(
    failedCalls: ToolCallRecord[],
    allCalls: ToolCallRecord[],
    toolName: string,
  ): FailurePattern | null {
    // 按参数签名分组
    const argGroups = new Map<string, ToolCallRecord[]>()

    for (const call of allCalls) {
      const sig = this.buildArgSignature(call.args)
      if (!argGroups.has(sig)) {
        argGroups.set(sig, [])
      }
      argGroups.get(sig)!.push(call)
    }

    // 找出同一参数组合出现 >= 3 次的分组
    const cacheCandidates: Array<{ signature: string; count: number; timeSpanMs: number; errors: string[] }> = []
    for (const [sig, records] of argGroups) {
      if (records.length < 3) continue

      const sorted = records.sort((a, b) => a.timestamp - b.timestamp)
      const timeSpanMs = sorted[sorted.length - 1].timestamp - sorted[0].timestamp
      // 只在短时间内高频重复的场景推荐缓存（1 小时内）
      if (timeSpanMs > 3600_000) continue

      const errors = records.filter((r) => !r.success).map((r) => r.error).filter(Boolean) as string[]
      cacheCandidates.push({
        signature: sig,
        count: records.length,
        timeSpanMs,
        errors,
      })
    }

    if (cacheCandidates.length === 0) return null

    // 使用最频繁的重复分组
    const top = cacheCandidates.sort((a, b) => b.count - a.count)[0]
    const failureRate = top.errors.length / top.count

    const totalCandidates = cacheCandidates.reduce((s, c) => s + c.count, 0)
    return {
      id: `fp:${toolName}:cache`,
      toolName,
      type: 'cache_error',
      description: `工具 "${toolName}" 同一参数组合在 ${(top.timeSpanMs / 1000).toFixed(0)}s 内被调用 ${top.count} 次（共 ${cacheCandidates.length} 组候选项），适合添加缓存`,
      argPatterns: [],
      frequency: totalCandidates,
      totalCalls: allCalls.length,
      failureRate,
      suggestedFix: 'cache_wrapper',
      confidence: Math.min(cacheCandidates.length / Math.max(allCalls.length, 1) * 2, 0.85),
      sampleErrors: top.errors.slice(0, 3),
      fixDescription: `为 "${toolName}" 添加内存缓存，减少对相同参数组合的重复执行`,
      affectedParams: [],
    }
  }

  /**
   * 从工具参数中构建简短签名用于分组
   */
  private buildArgSignature(args: Record<string, any>): string {
    const parts: string[] = []
    for (const [key, value] of Object.entries(args)) {
      if (key.startsWith('_')) continue
      if (typeof value === 'string') {
        parts.push(`${key}=${value.slice(0, 80)}`)
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        parts.push(`${key}=${String(value)}`)
      } else if (value === null || value === undefined) {
        parts.push(`${key}=null`)
      } else {
        parts.push(`${key}=${JSON.stringify(value).slice(0, 80)}`)
      }
    }
    return parts.sort().join('&')
  }

  /**
   * 分析所有工具，返回所有发现的失败模式
   */
  analyzeAll(): FailurePattern[] {
    const stats = toolCallLogStore.getStats()
    const allPatterns: FailurePattern[] = []

    for (const toolName of Object.keys(stats.byTool)) {
      const patterns = this.analyzeTool(toolName)
      allPatterns.push(...patterns)
    }

    // 按失败率降序排列
    allPatterns.sort((a, b) => b.failureRate - a.failureRate)

    return allPatterns
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const failurePatternAnalyzer = new FailurePatternAnalyzer()
