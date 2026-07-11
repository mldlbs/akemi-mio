/**
 * MetricsCollector — 通用按维度聚合的指标收集器
 *
 * 核心抽象：按维度（key）收集原始数据点，自动计算每个维度的聚合统计量。
 * 替代各模块中手动维护 Record<string, {count, sum, ...}> 和滚动平均计算的模式。
 *
 * 用法：
 *   const mc = new MetricsCollector<string>({ slidingWindowSize: 10 })
 *   mc.record('model-a', 150)   // 延迟 150ms
 *   mc.record('model-a', 200)   // 延迟 200ms
 *   mc.getStats('model-a')
 *   // { count: 2, sum: 350, avg: 175, min: 150, max: 200 }
 *
 *   // 滑动窗口平均值（最近 10 个数据点）
 *   mc.getSlidingAvg('model-a')  // 175
 *
 * 设计原则：
 * - 无偏见：不关心指标的业务含义，只负责数值聚合
 * - 按维度隔离：不同 key 的统计互不影响
 * - 滑动窗口：支持最近 N 个数据点的滚动统计
 * - 可观测：支持导出所有维度的完整统计快照
 *
 * 来源分析（PiperTTS + Plan:TypeScript）：
 * - PiperOrchestrator.synthesisStats — 按模型统计合成次数/成功/失败/延迟
 * - TtsPiperBridge.recentLatencies — 滑动窗口延迟统计
 * - LearningVocabularyManager.getProgress() — 按分类统计掌握度
 */
import { SlidingWindow } from '../patterns/SlidingWindow'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 单一维度的聚合统计数据 */
export interface MetricStats {
  /** 数据点总数 */
  count: number
  /** 数值总和 */
  sum: number
  /** 算术平均值 */
  avg: number
  /** 最小值 */
  min: number
  /** 最大值 */
  max: number
  /** 最近一次记录的值 */
  last: number
  /** 最后更新时间戳 */
  lastUpdated: number
}

/** 聚合配置 */
export interface MetricsCollectorOptions {
  /** 滑动窗口大小（默认 0 = 不启用滑动窗口） */
  slidingWindowSize?: number
  /** 是否在记录时自动输出调试日志 */
  verbose?: boolean
  /** 日志分类名前缀 */
  loggerName?: string
}

/** 完整统计快照（包含滑动窗口信息） */
export interface MetricSnapshot {
  /** 各维度的聚合统计 */
  perKey: Record<string, MetricStats>
  /** 总计（所有维度汇总） */
  total: {
    /** 总记录次数 */
    records: number
    /** 成功次数（仅 recordSuccess 调用计入） */
    successes: number
    /** 失败次数（仅 recordFailure 或 record 时通过 options 标记） */
    failures: number
  }
}

// ══════════════════════════════════════════
//  MetricsCollector
// ══════════════════════════════════════════

export class MetricsCollector<TKey extends string = string> {
  /** 按维度的原始统计数据 */
  private readonly stats = new Map<TKey, MetricStats>()

  /** 按维度的滑动窗口 */
  private readonly slidingWindows: Map<TKey, SlidingWindow<number>> = new Map()

  /** 滑动窗口大小（0 = 不启用） */
  private readonly slidingWindowSize: number

  /** 总记录次数 */
  private totalRecords = 0
  /** 成功次数 */
  private totalSuccesses = 0
  /** 失败次数 */
  private totalFailures = 0

  private readonly loggerName: string
  private readonly verbose: boolean

  constructor(options?: MetricsCollectorOptions) {
    this.slidingWindowSize = options?.slidingWindowSize ?? 0
    this.verbose = options?.verbose ?? false
    this.loggerName = options?.loggerName ?? 'metrics'
  }

  // ════════════════════════════════════════
  //  数据记录
  // ════════════════════════════════════════

  /**
   * 记录一个数值数据点。
   *
   * @param key 维度标识
   * @param value 数值（必须 >= 0）
   * @param options 可选标记（isSuccess / isFailure 用于统计成功/失败次数）
   */
  record(key: TKey, value: number, options?: { isSuccess?: boolean; isFailure?: boolean }): void {
    if (value < 0) return

    // 更新统计数据
    const existing = this.stats.get(key) ?? this.createEmptyStats()
    existing.count++
    existing.sum += value
    existing.avg = existing.sum / existing.count
    existing.min = Math.min(existing.min, value)
    existing.max = Math.max(existing.max, value)
    existing.last = value
    existing.lastUpdated = Date.now()
    this.stats.set(key, existing)

    // 更新滑动窗口
    if (this.slidingWindowSize > 0) {
      let sw = this.slidingWindows.get(key)
      if (!sw) {
        sw = new SlidingWindow<number>(this.slidingWindowSize)
        this.slidingWindows.set(key, sw)
      }
      sw.add(value)
    }

    // 全局计数
    this.totalRecords++
    if (options?.isSuccess) this.totalSuccesses++
    if (options?.isFailure) this.totalFailures++
  }

  /**
   * 记录成功（数值 + 成功标记）。
   * 等价于 record(key, value, { isSuccess: true })
   */
  recordSuccess(key: TKey, value: number): void {
    this.record(key, value, { isSuccess: true })
  }

  /**
   * 记录失败（仅增加失败计数，无数值）。
   * 用于不需要具体数值，仅统计次数的失败场景。
   */
  recordFailure(key: TKey): void {
    this.totalRecords++
    this.totalFailures++
    this.record(key, 0, { isFailure: true })
  }

  // ════════════════════════════════════════
  //  查询接口
  // ════════════════════════════════════════

  /**
   * 获取指定维度的统计数据。
   * 如果该维度尚无数据，返回空统计（count=0）。
   */
  getStats(key: TKey): MetricStats {
    return this.stats.get(key) ?? this.createEmptyStats()
  }

  /**
   * 获取指定维度的平均值。
   * 如果该维度尚无数据，返回 0。
   */
  getAvg(key: TKey): number {
    const stat = this.stats.get(key)
    return stat ? stat.avg : 0
  }

  /**
   * 获取指定维度的最小值。
   */
  getMin(key: TKey): number {
    const stat = this.stats.get(key)
    return stat ? stat.min : 0
  }

  /**
   * 获取指定维度的最大值。
   */
  getMax(key: TKey): number {
    const stat = this.stats.get(key)
    return stat ? stat.max : 0
  }

  /**
   * 获取指定维度的最近值。
   */
  getLast(key: TKey): number {
    const stat = this.stats.get(key)
    return stat ? stat.last : 0
  }

  /**
   * 获取指定维度的滑动窗口平均值。
   * 需在构造时设置 slidingWindowSize > 0。
   * 如果未启用滑动窗口或尚无数据，返回 -1。
   */
  getSlidingAvg(key: TKey): number {
    const sw = this.slidingWindows.get(key)
    if (!sw || sw.size === 0) return -1
    return sw.getAverage()
  }

  /**
   * 获取指定维度的滑动窗口中的所有值。
   */
  getSlidingWindow(key: TKey): readonly number[] {
    const sw = this.slidingWindows.get(key)
    return sw ? sw.getAll() : []
  }

  /**
   * 获取指定维度的成功率（成功次数 / 总记录次数）。
   * 如果无数据，返回 1（默认无失败）。
   */
  getSuccessRate(key: TKey): number {
    const stat = this.stats.get(key)
    if (!stat || stat.count === 0) return 1
    // 如果没有显式标记成功/失败，默认全部成功
    const failuresFromTotal = this.totalFailures > 0 ? this.totalFailures / this.totalRecords * stat.count : 0
    return Math.max(0, 1 - failuresFromTotal / Math.max(stat.count, 1))
  }

  /**
   * 获取所有维度的完整统计快照。
   */
  getAllStats(): Record<string, MetricStats> {
    const result: Record<string, MetricStats> = {}
    for (const [key, stats] of this.stats.entries()) {
      result[key] = { ...stats }
    }
    return result
  }

  /**
   * 获取全局汇总快照（含各维度数据 + 总计）。
   */
  getSnapshot(): MetricSnapshot {
    return {
      perKey: this.getAllStats(),
      total: {
        records: this.totalRecords,
        successes: this.totalSuccesses,
        failures: this.totalFailures,
      },
    }
  }

  /**
   * 获取所有注册的维度键列表。
   */
  getKeys(): TKey[] {
    return Array.from(this.stats.keys())
  }

  // ════════════════════════════════════════
  //  管理接口
  // ════════════════════════════════════════

  /**
   * 清除指定维度的所有数据。
   */
  clearKey(key: TKey): void {
    this.stats.delete(key)
    this.slidingWindows.delete(key)
  }

  /**
   * 清除所有数据。
   */
  clear(): void {
    this.stats.clear()
    this.slidingWindows.clear()
    this.totalRecords = 0
    this.totalSuccesses = 0
    this.totalFailures = 0
  }

  // ════════════════════════════════════════
  //  内部
  // ════════════════════════════════════════

  private createEmptyStats(): MetricStats {
    return {
      count: 0,
      sum: 0,
      avg: 0,
      min: Infinity,
      max: -Infinity,
      last: 0,
      lastUpdated: 0,
    }
  }
}
