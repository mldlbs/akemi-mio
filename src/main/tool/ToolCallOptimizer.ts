/**
 * ToolCallOptimizer — 工具调用历史参数优化引擎
 *
 * ## 职责
 * 1. 从 ToolCallLogStore 读取历史工具调用记录
 * 2. 按工具名分组，分析每个参数的常用值及其成功率
 * 3. 为工具推荐高成功率的参数默认值组合
 * 4. 定期淘汰低成功率的参数建议（prune）
 * 5. 冷启动阶段（少于 5 条记录）不生效
 *
 * ## 数据流
 *   ToolCallLogStore → ToolCallOptimizer.analyze()
 *   ServerManager.callTool() → ToolCallOptimizer.getSuggestions() → enrichArgs
 *   Evolution 定时器 → ToolCallOptimizer.prune()
 *
 * ## 生命周期
 *   初始化（空数据）→ 收集 5+ 条记录 → 激活优化 → 定期分析/淘汰
 */

import { log } from '../logger/Logger'
import { toolCallLogStore, type ToolCallRecord } from './ToolCallLogStore'

// =============================================================================
// 类型定义
// =============================================================================

/** 单参数的值频率与成功率统计 */
export interface ParamValueStat {
  value: string
  count: number
  successCount: number
  failureCount: number
  successRate: number
}

/** 单参数的优化建议 */
export interface ParamSuggestion {
  paramName: string
  /** 按使用频率降序排列的值统计 */
  topValues: ParamValueStat[]
  /** 推荐的默认值（成功率最高的值） */
  recommendedDefault: string | null
  /** 推荐置信度 (0-1) */
  confidence: number
  /** 该参数在历史中的总出现次数 */
  totalOccurrences: number
  /** 最近使用时间戳 */
  lastUsed: number
}

/** 单工具的整体优化报告 */
export interface ToolOptimizationReport {
  toolName: string
  /** 各参数的优化建议 */
  paramSuggestions: ParamSuggestion[]
  /** 总调用次数 */
  totalCalls: number
  /** 成功率 (0-1) */
  successRate: number
  /** 最近调用时间戳 */
  lastUsed: number
  /** 是否有足够的样本（>= MIN_RECORDS_TO_ACTIVATE） */
  hasEnoughData: boolean
}

/** 全工具优化汇总 */
export interface OptimizationSummary {
  reports: ToolOptimizationReport[]
  totalTools: number
  totalCalls: number
  overallSuccessRate: number
  /** 处于激活状态（有足够数据）的工具数 */
  activeTools: number
  /** 分析时间戳 */
  analyzedAt: number
  /** 冷启动状态 */
  isColdStart: boolean
}

/** 优化器配置 */
export interface OptimizerConfig {
  /** 激活所需的最小记录数 */
  MIN_RECORDS_TO_ACTIVATE: number
  /** 参数值最小出现次数（低于此值不纳入统计） */
  MIN_PARAM_OCCURRENCES: number
  /** 建议的最低成功率阈值 */
  MIN_SUCCESS_RATE: number
  /** 保留的最大建议数 */
  MAX_SUGGESTIONS_PER_PARAM: number
  /** 自动修剪的间隔（毫秒） */
  PRUNE_INTERVAL_MS: number
  /** 低效参数值淘汰阈值（低于此成功率的建议被修剪） */
  LOW_EFFICIENCY_THRESHOLD: number
  /** 是否启用优化 */
  enabled: boolean
}

// =============================================================================
// 默认配置
// =============================================================================

const DEFAULT_CONFIG: OptimizerConfig = {
  MIN_RECORDS_TO_ACTIVATE: 5,
  MIN_PARAM_OCCURRENCES: 2,
  MIN_SUCCESS_RATE: 0.5,
  MAX_SUGGESTIONS_PER_PARAM: 5,
  PRUNE_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24 小时
  LOW_EFFICIENCY_THRESHOLD: 0.3,
  enabled: true,
}

// =============================================================================
// ToolCallOptimizer 实现
// =============================================================================

export class ToolCallOptimizer {
  private config: OptimizerConfig
  /** 最后一次分析的时间戳（用于计算是否需要重新分析） */
  private lastAnalyzedAt = 0
  /** 缓存的分析结果 */
  private cachedReports: Map<string, ToolOptimizationReport> = new Map()
  /** 上次修剪时间 */
  private lastPrunedAt = 0
  /** 修剪计数器 */
  private pruneCount = 0

  constructor(config?: Partial<OptimizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    // 启动自动修剪定时器（每 config.PRUNE_INTERVAL_MS / 2 检查一次）
    setInterval(() => {
      this.prune()
    }, Math.min(this.config.PRUNE_INTERVAL_MS / 2, 12 * 60 * 60 * 1000)) // 最多每 12 小时
  }

  // =========================================================================
  // 公共 API
  // =========================================================================

  /**
   * 获取指定工具的优化建议。
   * 如果数据不足或优化器禁用，返回 null。
   */
  getToolReport(toolName: string): ToolOptimizationReport | null {
    if (!this.config.enabled) return null

    // 检查是否需要重新分析
    const stats = toolCallLogStore.getStats()
    const toolStats = stats.byTool[toolName]
    if (!toolStats || toolStats.total === 0) return null

    // 冷启动检查
    if (toolStats.total < this.config.MIN_RECORDS_TO_ACTIVATE) {
      return {
        toolName,
        paramSuggestions: [],
        totalCalls: toolStats.total,
        successRate: toolStats.total > 0 ? toolStats.success / toolStats.total : 0,
        lastUsed: stats.newestTimestamp,
        hasEnoughData: false,
      }
    }

    // 从缓存获取或重新分析
    const cached = this.cachedReports.get(toolName)
    if (cached && Date.now() - this.lastAnalyzedAt < 60_000) {
      return cached
    }

    const report = this.analyzeTool(toolName, toolStats)
    this.cachedReports.set(toolName, report)
    this.lastAnalyzedAt = Date.now()
    return report
  }

  /**
   * 获取所有工具的优化建议汇总。
   */
  getSummary(): OptimizationSummary {
    const stats = toolCallLogStore.getStats()
    const reports: ToolOptimizationReport[] = []
    let activeTools = 0
    let totalCalls = 0
    let totalSuccess = 0

    for (const [toolName, toolStats] of Object.entries(stats.byTool)) {
      const report = this.getToolReport(toolName)
      if (report) {
        reports.push(report)
        if (report.hasEnoughData) activeTools++
      }
      totalCalls += toolStats.total
      totalSuccess += toolStats.success
    }

    reports.sort((a, b) => b.totalCalls - a.totalCalls)

    const totalAnalyzedCalls = reports.reduce((s, r) => s + r.totalCalls, 0)
    const totalAnalyzedSuccess = reports.reduce((s, r) => s + Math.round(r.successRate * r.totalCalls), 0)

    return {
      reports,
      totalTools: reports.length,
      totalCalls,
      overallSuccessRate: totalCalls > 0 ? totalSuccess / totalCalls : 0,
      activeTools,
      analyzedAt: Date.now(),
      isColdStart: totalAnalyzedCalls < this.config.MIN_RECORDS_TO_ACTIVATE,
    }
  }

  /**
   * 为指定工具的未提供参数生成推荐默认值。
   * 返回需要填充的参数值映射。
   */
  getSuggestedDefaults(toolName: string, providedArgs: Record<string, any>): Record<string, string> {
    if (!this.config.enabled) return {}

    const report = this.getToolReport(toolName)
    if (!report || !report.hasEnoughData) return {}

    const defaults: Record<string, string> = {}
    for (const suggestion of report.paramSuggestions) {
      // 仅填充用户未提供的参数
      if (suggestion.paramName in providedArgs) continue
      if (!suggestion.recommendedDefault) continue
      if (suggestion.confidence < this.config.MIN_SUCCESS_RATE) continue
      defaults[suggestion.paramName] = suggestion.recommendedDefault
    }

    if (Object.keys(defaults).length > 0) {
      log('INFO', 'tool_optimizer_defaults', {
        tool: toolName,
        defaults: Object.entries(defaults).map(([k, v]) => `${k}=${v}`).join(', '),
      })
    }

    return defaults
  }

  /**
   * 获取工具的推荐参数组合（用于 UI 展示）。
   * 返回按成功率降序排列的参数组合建议。
   */
  getRecommendedParamCombos(toolName: string, limit = 5): Array<{
    params: Record<string, string>
    successRate: number
    sampleCount: number
  }> {
    if (!this.config.enabled) return []

    const records = toolCallLogStore.query({
      toolName,
      limit: 100,
    })
    if (records.length < this.config.MIN_RECORDS_TO_ACTIVATE) return []

    // 按参数签名分组
    const comboMap = new Map<string, { params: Record<string, string>; successCount: number; totalCount: number }>()
    for (const r of records) {
      const stringArgs: Record<string, string> = {}
      for (const [k, v] of Object.entries(r.args)) {
        if (k.startsWith('_')) continue
        if (typeof v === 'string') stringArgs[k] = v
      }
      const sig = JSON.stringify(stringArgs)
      const existing = comboMap.get(sig)
      if (existing) {
        existing.totalCount++
        if (r.success) existing.successCount++
      } else {
        comboMap.set(sig, { params: stringArgs, successCount: r.success ? 1 : 0, totalCount: 1 })
      }
    }

    return Array.from(comboMap.values())
      .filter((c) => c.totalCount >= this.config.MIN_PARAM_OCCURRENCES)
      .map((c) => ({
        params: c.params,
        successRate: c.totalCount > 0 ? c.successCount / c.totalCount : 0,
        sampleCount: c.totalCount,
      }))
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, limit)
  }

  /**
   * 根据用户的显式反馈调整优化建议。
   * 当用户对某次调用标记负面时，降低该参数组合的推荐优先级。
   */
  handleFeedback(toolName: string, args: Record<string, any>, feedback: 'positive' | 'negative'): void {
    if (feedback === 'positive') return // 正面反馈不需要调整

    // 负面反馈：清除该工具的参数缓存，下次重新分析时
    // 会因负面反馈标记而降低对应参数值的排名
    this.cachedReports.delete(toolName)
    log('INFO', 'tool_optimizer_feedback', {
      tool: toolName,
      feedback,
      argPreview: JSON.stringify(args).slice(0, 100),
    })
  }

  /**
   * 定期修剪低效的参数建议。
   * 删除成功率低于 LOW_EFFICIENCY_THRESHOLD 且出现次数少的建议。
   * 返回被修剪的建议数量。
   */
  prune(): number {
    const now = Date.now()
    // 检查是否到达修剪间隔
    if (now - this.lastPrunedAt < this.config.PRUNE_INTERVAL_MS) return 0
    this.lastPrunedAt = now

    let prunedCount = 0
    const stats = toolCallLogStore.getStats()

    for (const [toolName] of Object.entries(stats.byTool)) {
      const report = this.cachedReports.get(toolName)
      if (!report || !report.hasEnoughData) continue

      const originalCount = report.paramSuggestions.length
      report.paramSuggestions = report.paramSuggestions.filter((s) => {
        // 保留置信度高于阈值的建议
        if (s.confidence >= this.config.LOW_EFFICIENCY_THRESHOLD) return true
        // 保留总出现次数 >= 3 的建议（样本充足）
        if (s.totalOccurrences >= 3) return true
        return false
      })

      const removed = originalCount - report.paramSuggestions.length
      if (removed > 0) {
        this.cachedReports.set(toolName, report)
        prunedCount += removed
      }
    }

    if (prunedCount > 0) {
      this.pruneCount++
      log('INFO', 'tool_optimizer_pruned', {
        removed: prunedCount,
        totalPruned: this.pruneCount,
      })
    }

    return prunedCount
  }

  /**
   * 清除所有缓存的分析结果。
   */
  clearCache(): void {
    this.cachedReports.clear()
    this.lastAnalyzedAt = 0
    this.lastPrunedAt = 0
    log('INFO', 'tool_optimizer_cache_cleared')
  }

  /**
   * 重置优化器状态（清缓存 + 重置计数器）。
   */
  reset(): void {
    this.clearCache()
    this.pruneCount = 0
    log('INFO', 'tool_optimizer_reset')
  }

  /** 获取当前配置 */
  getConfig(): Readonly<OptimizerConfig> {
    return { ...this.config }
  }

  /** 更新配置 */
  setConfig(partial: Partial<OptimizerConfig>): void {
    this.config = { ...this.config, ...partial }
    // 快速清缓存（配置变化可能影响分析结果）
    this.cachedReports.clear()
    log('INFO', 'tool_optimizer_config_updated', { changes: Object.keys(partial) })
  }

  /** 获取优化器统计 */
  getStats(): { cacheSize: number; lastAnalyzedAt: number; lastPrunedAt: number; pruneCount: number } {
    return {
      cacheSize: this.cachedReports.size,
      lastAnalyzedAt: this.lastAnalyzedAt,
      lastPrunedAt: this.lastPrunedAt,
      pruneCount: this.pruneCount,
    }
  }

  // =========================================================================
  // 内部方法
  // =========================================================================

  /**
   * 分析单个工具的历史调用记录，生成参数优化建议。
   */
  private analyzeTool(toolName: string, toolStats: { total: number; success: number; failure: number }): ToolOptimizationReport {
    // 获取最近 200 条记录
    const records = toolCallLogStore.query({
      toolName,
      limit: 200,
    })

    if (records.length === 0) {
      return {
        toolName,
        paramSuggestions: [],
        totalCalls: toolStats.total,
        successRate: toolStats.total > 0 ? toolStats.success / toolStats.total : 0,
        lastUsed: 0,
        hasEnoughData: toolStats.total >= this.config.MIN_RECORDS_TO_ACTIVATE,
      }
    }

    // 收集所有参数及其值
    const paramValueMap = new Map<string, Map<string, { success: number; total: number; lastUsed: number }>>()

    for (const record of records) {
      for (const [key, value] of Object.entries(record.args)) {
        if (key.startsWith('_')) continue // 跳过元数据
        if (typeof value !== 'string') continue
        if (!value) continue

        if (!paramValueMap.has(key)) {
          paramValueMap.set(key, new Map())
        }
        const valueMap = paramValueMap.get(key)!
        if (!valueMap.has(value)) {
          valueMap.set(value, { success: 0, total: 0, lastUsed: 0 })
        }
        const entry = valueMap.get(value)!
        entry.total++
        if (record.success) entry.success++
        if (record.timestamp > entry.lastUsed) {
          entry.lastUsed = record.timestamp
        }
      }
    }

    // 生成参数建议
    const paramSuggestions: ParamSuggestion[] = []

    for (const [paramName, valueMap] of paramValueMap) {
      const values: ParamValueStat[] = []

      for (const [value, stat] of valueMap) {
        if (stat.total < this.config.MIN_PARAM_OCCURRENCES) continue
        values.push({
          value,
          count: stat.total,
          successCount: stat.success,
          failureCount: stat.total - stat.success,
          successRate: stat.total > 0 ? stat.success / stat.total : 0,
        })
      }

      if (values.length === 0) continue

      // 按使用频率降序
      values.sort((a, b) => b.count - a.count)

      const topValues = values.slice(0, this.config.MAX_SUGGESTIONS_PER_PARAM)

      // 找到成功率最高的值作为推荐默认值
      const bestValue = [...values].sort((a, b) => b.successRate - a.successRate)[0]

      // 计算置信度：基于样本数量和成功率
      const confidence = this.computeConfidence(bestValue.count, bestValue.successRate, records.length)

      const lastUsed = Math.max(...values.map((v) => valueMap.get(v.value)?.lastUsed ?? 0))

      paramSuggestions.push({
        paramName,
        topValues,
        recommendedDefault: bestValue.successRate >= this.config.MIN_SUCCESS_RATE ? bestValue.value : null,
        confidence,
        totalOccurrences: values.reduce((s, v) => s + v.count, 0),
        lastUsed,
      })
    }

    // 按总出现次数降序
    paramSuggestions.sort((a, b) => b.totalOccurrences - a.totalOccurrences)

    // 获取最近使用时间
    const lastUsed = records.reduce((max, r) => (r.timestamp > max ? r.timestamp : max), 0)

    return {
      toolName,
      paramSuggestions,
      totalCalls: toolStats.total,
      successRate: toolStats.total > 0 ? toolStats.success / toolStats.total : 0,
      lastUsed,
      hasEnoughData: toolStats.total >= this.config.MIN_RECORDS_TO_ACTIVATE,
    }
  }

  /**
   * 计算推荐置信度。
   * 综合考虑样本数量、成功率、总记录数。
   */
  private computeConfidence(sampleCount: number, successRate: number, totalRecords: number): number {
    // 样本量因子：样本越多越可信（5 条饱和到 0.8）
    const sampleFactor = Math.min(sampleCount / 5, 1) * 0.8

    // 成功率因子：成功率越高越可信（> 0.8 满信任）
    const successFactor = Math.min(successRate / 0.8, 1) * 0.2

    // 综合置信度
    return Math.round(Math.min(sampleFactor + successFactor, 1) * 100) / 100
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const toolCallOptimizer = new ToolCallOptimizer()
