/**
 * PeriodicPatternAnalyzer — 周期行为模式分析器
 *
 * 从 ToolCallLogStore 中读取历史工具调用记录，按时间维度分桶统计，
 * 提取小时级别的周期性调用模式（例如："每天上午 9-10 点高频使用 grep"）。
 *
 * ## 数据流
 *   ToolCallLogStore → PeriodicPatternAnalyzer.analyze()
 *   BehaviorPredictor.loadPeriodicPatterns() → 供 session-start 预测
 *
 * ## 输出
 *   每个工具在每个小时桶的出现次数和概率分布，
 *   可用于预测当前时段用户最可能需要的工具。
 *
 * ## 资源保护
 * - 最小数据量保护：少于 20 条记录不分析
 * - 有界分析窗口：最多分析最近 7 天的记录
 * - 冷启动保护：数据不足时返回空结果
 */

import { log } from '../logger/Logger'
import { toolCallLogStore } from '../tool/ToolCallLogStore'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 分析窗口：最多分析最近 7 天（毫秒） */
const ANALYSIS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** 最小记录数：低于此值不进行分析 */
const MIN_RECORDS = 20

/** 小时内分桶：将 60 分钟分为 4 个 15 分钟桶 */
const BUCKETS_PER_HOUR = 4

/** 小时桶的分钟跨度 */
const MINUTES_PER_BUCKET = 60 / BUCKETS_PER_HOUR

/** 工具被认定为"高频"的最小出现次数 */
const MIN_TOOL_OCCURRENCES = 3

/** 周期性置信度阈值：工具在某时段的出现比例超过此值才视为周期模式 */
const PERIODIC_CONFIDENCE_THRESHOLD = 0.15

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 单个工具在某个小时桶的统计数据 */
export interface HourBucketStat {
  /** 小时 (0-23) */
  hour: number
  /** 15 分钟桶序号 (0-3) */
  bucket: number
  /** 该桶内的调用次数 */
  count: number
  /** 该桶占总调用次数的比例 (0-1) */
  proportion: number
}

/** 单工具的周期模式 */
export interface PeriodicToolPattern {
  /** 工具名 */
  toolName: string
  /** 总调用次数 */
  totalCalls: number
  /** 在该工具调用中，按小时桶分布的统计 */
  hourlyBuckets: HourBucketStat[]
  /** 高频时段列表（比例 > PERIODIC_CONFIDENCE_THRESHOLD 的桶） */
  peakBuckets: HourBucketStat[]
  /** 该工具是否呈现显著的周期性 */
  hasPeriodicity: boolean
  /** 周期强度 (0-1)：基于峰值集中度 */
  periodicityStrength: number
}

/** 周期分析完整结果 */
export interface PeriodicAnalysisResult {
  /** 每个工具的周期模式 */
  toolPatterns: PeriodicToolPattern[]
  /** 按小时聚合：每个小时桶内最可能使用的工具列表 */
  topToolsByHour: Map<string, Array<{ toolName: string; probability: number }>>
  /** 分析覆盖的记录数 */
  totalRecords: number
  /** 分析覆盖的天数 */
  daysCovered: number
  /** 数据是否充足 */
  hasSufficientData: boolean
  /** 生成时间戳 */
  generatedAt: number
}

// ══════════════════════════════════════════
//  配置
// ══════════════════════════════════════════

export interface PeriodicPatternConfig {
  analysisWindowMs?: number
  minRecords?: number
  minToolOccurrences?: number
  periodicConfidenceThreshold?: number
}

const DEFAULT_CONFIG: Required<PeriodicPatternConfig> = {
  analysisWindowMs: ANALYSIS_WINDOW_MS,
  minRecords: MIN_RECORDS,
  minToolOccurrences: MIN_TOOL_OCCURRENCES,
  periodicConfidenceThreshold: PERIODIC_CONFIDENCE_THRESHOLD,
}

// ══════════════════════════════════════════
//  实现
// ══════════════════════════════════════════

export class PeriodicPatternAnalyzer {
  private config: Required<PeriodicPatternConfig>
  /** 缓存的分析结果（避免频繁重建） */
  private cachedResult: PeriodicAnalysisResult | null = null
  /** 缓存生成时间 */
  private cachedAt = 0
  /** 缓存 TTL：5 分钟 */
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000

  constructor(config?: PeriodicPatternConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 执行周期性分析。
   * 返回按小时桶聚合的工具调用模式。
   * 结果缓存 5 分钟，避免频繁重建。
   */
  analyze(): PeriodicAnalysisResult {
    const now = Date.now()

    // 缓存命中检查
    if (this.cachedResult && now - this.cachedAt < PeriodicPatternAnalyzer.CACHE_TTL_MS) {
      return this.cachedResult
    }

    // 从 ToolCallLogStore 读取记录
    const since = now - this.config.analysisWindowMs
    const records = toolCallLogStore.query({
      success: true, // 只分析成功的调用
      since,
    })

    if (records.length < this.config.minRecords) {
      const empty: PeriodicAnalysisResult = {
        toolPatterns: [],
        topToolsByHour: new Map(),
        totalRecords: records.length,
        daysCovered: 0,
        hasSufficientData: false,
        generatedAt: now,
      }
      this.cachedResult = empty
      this.cachedAt = now
      return empty
    }

    // 按工具 + 小时桶分组统计
    const toolHourMap = new Map<string, Map<string, number>>()
    const toolTotalMap = new Map<string, number>()

    for (const record of records) {
      const date = new Date(record.timestamp)
      const hour = date.getHours()
      const minute = date.getMinutes()
      const bucket = Math.floor(minute / MINUTES_PER_BUCKET)
      const hourKey = `${hour}:${bucket}`

      if (!toolHourMap.has(record.toolName)) {
        toolHourMap.set(record.toolName, new Map())
        toolTotalMap.set(record.toolName, 0)
      }

      const hourMap = toolHourMap.get(record.toolName)!
      hourMap.set(hourKey, (hourMap.get(hourKey) || 0) + 1)
      toolTotalMap.set(record.toolName, toolTotalMap.get(record.toolName)! + 1)
    }

    // 构建每个工具的周期模式
    const toolPatterns: PeriodicToolPattern[] = []

    for (const [toolName, hourMap] of toolHourMap) {
      const totalCalls = toolTotalMap.get(toolName) || 0
      if (totalCalls < this.config.minToolOccurrences) continue

      const hourlyBuckets: HourBucketStat[] = []
      let maxCount = 0

      // 为所有 96 个可能的桶（24h × 4 buckets）生成统计数据
      for (let h = 0; h < 24; h++) {
        for (let b = 0; b < BUCKETS_PER_HOUR; b++) {
          const key = `${h}:${b}`
          const count = hourMap.get(key) || 0
          if (count > maxCount) maxCount = count

          hourlyBuckets.push({
            hour: h,
            bucket: b,
            count,
            proportion: totalCalls > 0 ? count / totalCalls : 0,
          })
        }
      }

      // 找出超过置信度阈值的 peak 桶
      const peakBuckets = hourlyBuckets.filter(
        (hb) => hb.proportion >= this.config.periodicConfidenceThreshold,
      )

      // 计算周期强度：基于 peak 桶的集中度
      // 若调用集中在少数桶 → 周期性强
      // 若调用均匀分布 → 周期性弱
      const peakConcentration = peakBuckets.reduce((s, hb) => s + hb.proportion, 0)
      // 归一化：假设 peak 桶最多占总数的 80%
      const periodicityStrength = Math.min(peakConcentration / 0.8, 1)

      const hasPeriodicity = peakBuckets.length > 0 && periodicityStrength > 0.2

      toolPatterns.push({
        toolName,
        totalCalls,
        hourlyBuckets,
        peakBuckets,
        hasPeriodicity,
        periodicityStrength,
      })
    }

    // 按周期强度降序排列
    toolPatterns.sort((a, b) => b.periodicityStrength - a.periodicityStrength)

    // 构建按小时查询的顶级工具列表
    const topToolsByHour = new Map<string, Array<{ toolName: string; probability: number }>>()

    for (let h = 0; h < 24; h++) {
      for (let b = 0; b < BUCKETS_PER_HOUR; b++) {
        const key = `${h}:${b}`
        const toolsInBucket: Array<{ toolName: string; probability: number }> = []

        for (const pattern of toolPatterns) {
          const bucket = pattern.hourlyBuckets.find((hb) => hb.hour === h && hb.bucket === b)
          if (bucket && bucket.proportion > 0) {
            toolsInBucket.push({
              toolName: pattern.toolName,
              probability: bucket.proportion,
            })
          }
        }

        // 按概率降序排列
        toolsInBucket.sort((a, b) => b.probability - a.probability)
        topToolsByHour.set(key, toolsInBucket.slice(0, 10)) // 保留 top-10
      }
    }

    // 计算覆盖天数
    const timestamps = records.map((r) => r.timestamp).sort()
    const daysCovered = timestamps.length > 1
      ? Math.round((timestamps[timestamps.length - 1] - timestamps[0]) / (24 * 60 * 60 * 1000))
      : 0

    const result: PeriodicAnalysisResult = {
      toolPatterns,
      topToolsByHour,
      totalRecords: records.length,
      daysCovered,
      hasSufficientData: true,
      generatedAt: now,
    }

    this.cachedResult = result
    this.cachedAt = now

    log('INFO', 'periodic_pattern_analyzed', {
      tools: toolPatterns.length,
      periodic: toolPatterns.filter((p) => p.hasPeriodicity).length,
      records: records.length,
      days: daysCovered,
    })

    return result
  }

  /**
   * 获取当前小时桶的推荐工具列表。
   * 用于 session-start 预测。
   */
  getRecommendedToolsForNow(limit = 5): Array<{ toolName: string; probability: number }> {
    const now = new Date()
    const hour = now.getHours()
    const minute = now.getMinutes()
    const bucket = Math.floor(minute / MINUTES_PER_BUCKET)
    const key = `${hour}:${bucket}`

    const result = this.analyze()
    return result.topToolsByHour.get(key)?.slice(0, limit) || []
  }

  /**
   * 获取在某个特定小时的推荐工具列表。
   * 用于测试或"what-if"分析。
   */
  getRecommendedToolsForHour(hour: number, limit = 5): Array<{ toolName: string; probability: number }> {
    if (hour < 0 || hour > 23) return []

    // 取该小时的所有桶中出现概率最高的工具
    const result = this.analyze()
    const seen = new Set<string>()
    const aggregated: Array<{ toolName: string; totalProbability: number }> = []

    for (let b = 0; b < BUCKETS_PER_HOUR; b++) {
      const key = `${hour}:${b}`
      const tools = result.topToolsByHour.get(key) || []
      for (const t of tools) {
        if (seen.has(t.toolName)) continue
        seen.add(t.toolName)
        aggregated.push({ toolName: t.toolName, totalProbability: t.probability })
      }
    }

    aggregated.sort((a, b) => b.totalProbability - a.totalProbability)
    return aggregated.slice(0, limit).map((a) => ({
      toolName: a.toolName,
      probability: a.totalProbability,
    }))
  }

  /**
   * 获取工具在特定小时的周期强度。
   * 返回该工具在 24 小时内按小时聚合的调用分布。
   */
  getToolHourlyProfile(toolName: string): Array<{ hour: number; count: number; proportion: number }> | null {
    const result = this.analyze()
    const pattern = result.toolPatterns.find((p) => p.toolName === toolName)
    if (!pattern) return null

    // 按小时聚合
    const hourlyMap = new Map<number, { count: number; proportion: number }>()
    for (const hb of pattern.hourlyBuckets) {
      const existing = hourlyMap.get(hb.hour) || { count: 0, proportion: 0 }
      existing.count += hb.count
      existing.proportion += hb.proportion
      hourlyMap.set(hb.hour, existing)
    }

    return Array.from(hourlyMap.entries())
      .map(([hour, data]) => ({ hour, ...data }))
      .sort((a, b) => a.hour - b.hour)
  }

  /** 清除缓存，强制下次分析重新计算 */
  clearCache(): void {
    this.cachedResult = null
    this.cachedAt = 0
  }

  /** 获取分析器统计 */
  getStats(): { cached: boolean; cacheAgeMs: number; lastResult: boolean } {
    return {
      cached: this.cachedResult !== null,
      cacheAgeMs: this.cachedAt > 0 ? Date.now() - this.cachedAt : 0,
      lastResult: this.cachedResult?.hasSufficientData ?? false,
    }
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const periodicPatternAnalyzer = new PeriodicPatternAnalyzer()
