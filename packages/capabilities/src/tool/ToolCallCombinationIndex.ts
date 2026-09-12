/**
 * ToolCallCombinationIndex — 工具调用参数组合索引
 *
 * 职责：
 * 1. 从 ToolCallLogStore 中索引工具调用的参数组合
 * 2. 按成功频率对参数组合评分排序
 * 3. 提供查询接口：getTopCombinations(toolName) → 最常用的成功参数组合
 *
 * 使用方式：
 *   const suggestions = toolCallCombinationIndex.getTopCombinations('ReadFileTool', 5)
 *   // → [{ args: { path: '/tmp/x.txt' }, frequency: 8, successRate: 1.0, rating: 8.0 }]
 *
 * 数据流向：
 *   ToolCallLogStore.record() → (自动积累)
 *   ToolCallCombinationIndex.getTopCombinations() → (查询时实时构建索引)
 *   IPC → renderer ToolParamSuggestions 组件
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { toolCallLogStore, type ToolCallRecord } from './ToolCallLogStore'

// =============================================================================
// 类型定义
// =============================================================================

/**
 * 参数组合统计条目
 */
export interface ParamCombination {
  /** 参数组合（完整参数快照） */
  args: Record<string, any>
  /** 出现频次 */
  frequency: number
  /** 成功率 (0-1) */
  successRate: number
  /** 综合评分 = successRate * log(1 + frequency) * recencyFactor */
  rating: number
  /** 最近一次调用的时间戳 */
  lastUsed: number
  /** 首次被观察到的时间戳 */
  firstSeen: number
}

/**
 * 参数组合查询选项
 */
export interface CombinationQueryOptions {
  /** 最大返回数（默认 5） */
  limit?: number
  /** 最低成功率过滤（默认 0.3） */
  minSuccessRate?: number
  /** 最低频次过滤（默认 1） */
  minFrequency?: number
  /** 时间窗口（毫秒，默认 7 天） */
  windowMs?: number
  /** 是否排除超大参数（默认 true） */
  excludeLargeArgs?: boolean
}

// =============================================================================
// 默认配置
// =============================================================================

const DEFAULT_OPTIONS: Required<CombinationQueryOptions> = {
  limit: 5,
  minSuccessRate: 0.3,
  minFrequency: 1,
  windowMs: 7 * 24 * 60 * 60 * 1000, // 7 天
  excludeLargeArgs: true,
}

/** 参数值最大长度（超过将被截断用于指纹） */
const MAX_PARAM_VALUE_LENGTH = 200

/** 参数组合指纹中最多包含的参数个数 */
const MAX_FINGERPRINT_PARAMS = 8

// =============================================================================
// ToolCallCombinationIndex 实现
// =============================================================================

export class ToolCallCombinationIndex {
  private options: Required<CombinationQueryOptions>

  constructor(options?: CombinationQueryOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /**
   * 更新运行时配置
   */
  updateOptions(options: Partial<CombinationQueryOptions>): void {
    this.options = { ...this.options, ...options }
  }

  /**
   * 获取指定工具最常用的成功参数组合。
   *
   * 查询流程：
   * 1. 从 ToolCallLogStore 中筛选指定工具的所有记录
   * 2. 根据时间窗口过滤
   * 3. 对每条记录生成参数组合指纹
   * 4. 按指纹分组统计频次和成功率
   * 5. 按综合评分排序，返回 Top N
   *
   * @param toolName 工具名
   * @param limit 最大返回数（可选，覆盖默认）
   */
  getTopCombinations(toolName: string, limit?: number): ParamCombination[] {
    try {
      // 1. 从 ToolCallLogStore 获取该工具的所有记录
      const records = toolCallLogStore.query({
        toolName,
        limit: 2000, // 获取尽可能多的记录
      })

      if (records.length === 0) return []

      // 2. 按时间窗口过滤
      const cutoff = Date.now() - this.options.windowMs
      const filtered = records.filter((r) => r.timestamp >= cutoff)

      if (filtered.length === 0) return []

      // 3. 按指纹分组统计
      const groups = this.groupByFingerprint(filtered)

      // 4. 计算评分并排序
      const combinations = this.scoreCombinations(groups)

      // 5. 返回 Top N
      const topLimit = limit ?? this.options.limit
      return combinations.slice(0, Math.max(1, topLimit))
    } catch (err) {
      log('WARN', 'tool_combination_index_query_failed', {
        toolName,
        error: String(err),
      })
      return []
    }
  }

  /**
   * 获取多个工具的推荐参数组合。
   * 用于批量场景（如 Dashboard 概览）。
   */
  getMultiToolCombinations(toolNames: string[], options?: { perTool?: number }): Record<string, ParamCombination[]> {
    const perTool = options?.perTool ?? 3
    const result: Record<string, ParamCombination[]> = {}
    for (const name of toolNames) {
      result[name] = this.getTopCombinations(name, perTool)
    }
    return result
  }

  /**
   * 获取指定工具的统计摘要
   */
  getToolStats(toolName: string): {
    totalCalls: number
    uniqueCombinations: number
    topCombination: ParamCombination | null
  } {
    const records = toolCallLogStore.query({ toolName, limit: 2000 })
    const cutoff = Date.now() - this.options.windowMs
    const filtered = records.filter((r) => r.timestamp >= cutoff)
    const groups = this.groupByFingerprint(filtered)
    const scored = this.scoreCombinations(groups)

    return {
      totalCalls: filtered.length,
      uniqueCombinations: groups.size,
      topCombination: scored[0] ?? null,
    }
  }

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * 对工具调用记录按参数指纹分组。
   * 指纹 = 排序后的(参数名=截断值) 连接字符串。
   */
  private groupByFingerprint(
    records: ToolCallRecord[],
  ): Map<string, { args: Record<string, any>; successes: number; total: number; timestamps: number[] }> {
    const groups = new Map<string, { args: Record<string, any>; successes: number; total: number; timestamps: number[] }>()

    for (const record of records) {
      const fingerprint = this.createFingerprint(record.args)
      if (!fingerprint) continue

      let group = groups.get(fingerprint)
      if (!group) {
        group = {
          args: { ...record.args },
          successes: 0,
          total: 0,
          timestamps: [],
        }
        groups.set(fingerprint, group)
      }

      group.total++
      if (record.success) group.successes++
      group.timestamps.push(record.timestamp)
    }

    return groups
  }

  /**
   * 为参数组合生成指纹字符串。
   * 策略：取前 N 个参数，按参数名排序，值截断后拼接。
   * 忽略系统注入参数（_memoryContext 等）。
   */
  private createFingerprint(args: Record<string, any>): string | null {
    const entries = Object.entries(args)
      .filter(([key, value]) => {
        // 忽略系统注入参数
        if (key.startsWith('_')) return false
        // 忽略函数/对象类型参数
        if (typeof value === 'function' || typeof value === 'object' || value === null || value === undefined) {
          // 对象类型也保留，但做扁平化处理
          return true
        }
        return true
      })
      .slice(0, MAX_FINGERPRINT_PARAMS)

    if (entries.length === 0) return null

    // 按参数名排序确保一致性
    entries.sort(([a], [b]) => a.localeCompare(b))

    return entries
      .map(([key, value]) => {
        let str: string
        if (typeof value === 'object' && value !== null) {
          try {
            str = JSON.stringify(value)
          } catch {
            str = String(value)
          }
        } else {
          str = String(value)
        }
        // 截断过长值
        if (str.length > MAX_PARAM_VALUE_LENGTH) {
          str = str.slice(0, MAX_PARAM_VALUE_LENGTH) + '...'
        }
        return `${key}=${str}`
      })
      .join('&')
  }

  /**
   * 为分组后的组合计算综合评分。
   *
   * rating = successRate × log(1 + frequency) × recencyFactor
   *
   * - successRate: 成功比例 (0~1)
   * - log(1+frequency): 频次的对数缩放，避免高频组合压倒性占优
   * - recencyFactor: 最近使用过的组合获得更高权重
   */
  private scoreCombinations(
    groups: Map<string, { args: Record<string, any>; successes: number; total: number; timestamps: number[] }>,
  ): ParamCombination[] {
    const now = Date.now()
    const halfWindow = this.options.windowMs / 2

    const results: ParamCombination[] = []

    for (const [, group] of groups) {
      if (group.total < this.options.minFrequency) continue

      const successRate = group.total > 0 ? group.successes / group.total : 0
      if (successRate < this.options.minSuccessRate) continue

      // 近因因子：最近 halfWindow 内使用过的组合加分
      const maxTimestamp = Math.max(...group.timestamps)
      const recencyDelta = now - maxTimestamp
      const recencyFactor = recencyDelta < halfWindow ? 1.0 : 0.6

      const rating = successRate * Math.log(1 + group.total) * recencyFactor

      results.push({
        args: group.args,
        frequency: group.total,
        successRate,
        rating,
        lastUsed: maxTimestamp,
        firstSeen: Math.min(...group.timestamps),
      })
    }

    // 按 rating 降序排列
    results.sort((a, b) => b.rating - a.rating)

    // 可选：排除超大参数（大文本、base64 等）
    if (this.options.excludeLargeArgs) {
      return results.filter((c) => !this.hasOversizedArgs(c.args))
    }

    return results
  }

  /**
   * 检查参数中是否包含超大数据（通常意味着文件内容、base64 等，
   * 不适合直接作为默认值推荐）。
   */
  private hasOversizedArgs(args: Record<string, any>): boolean {
    for (const [, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > MAX_PARAM_VALUE_LENGTH) {
        return true
      }
      if (typeof value === 'object' && value !== null) {
        try {
          const str = JSON.stringify(value)
          if (str.length > MAX_PARAM_VALUE_LENGTH) return true
        } catch {
          return true
        }
      }
    }
    return false
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const toolCallCombinationIndex = new ToolCallCombinationIndex()

