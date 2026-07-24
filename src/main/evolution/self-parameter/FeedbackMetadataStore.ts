/**
 * FeedbackMetadataStore — 带时间戳的用户反馈元数据存储
 *
 * 持久化存储用户交互反馈的时间序列数据，支持：
 * - 记录满意度（点赞/踩）
 * - 记录任务成功/失败
 * - 记录用户中断
 * - 记录重复提问
 * - 按时间窗口查询和聚合
 * - 自动清理过期数据
 *
 * 数据存储为 JSON 文件（WORKSPACE.evolution/parameter_feedback.json）
 * 遵循项目中 FeedbackTracker 的持久化模式。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { log } from '../../logger/Logger'
import { WORKSPACE } from '../../config'
import type { FeedbackDataPoint, FeedbackMetricCategory, FeedbackMetricAnalysis, FeedbackStoreData } from './types'

// ═══════════════════════════════════════════════
//  常量和默认配置
// ═══════════════════════════════════════════════

const STORE_FILE = join(WORKSPACE.evolution, 'parameter_feedback.json')
const STORE_VERSION = 1

/** 默认数据保留期限：30 天 */
const DEFAULT_RETENTION_DAYS = 30

/** 分析窗口大小（小时） */
const ANALYSIS_WINDOW_HOURS = 24

/** 对比窗口大小（前一个 ANALYSIS_WINDOW_HOURS 小时段） */
const COMPARISON_WINDOW_HOURS = 24

/** 触发告警的 z-score 阈值 */
const CONCERN_Z_SCORE_THRESHOLD = 1.5

// ═══════════════════════════════════════════════
//  FeedbackMetadataStore
// ═══════════════════════════════════════════════

export class FeedbackMetadataStore {
  private dataPoints: FeedbackDataPoint[] = []
  private retentionDays = DEFAULT_RETENTION_DAYS

  /** 初始化：从磁盘加载数据 */
  init(): void {
    this.load()
    log('INFO', 'feedback_store_init', {
      dataPoints: this.dataPoints.length,
      retentionDays: this.retentionDays,
    })
  }

  // ═══════════════════════════════════════════════
  //  数据记录
  // ═══════════════════════════════════════════════

  /** 记录一个反馈数据点 */
  record(input: {
    metric: string
    value: number
    category: FeedbackMetricCategory
    context?: string
  }): void {
    const point: FeedbackDataPoint = {
      timestamp: Date.now(),
      metric: input.metric,
      value: input.value,
      category: input.category,
      context: input.context,
    }
    this.dataPoints.push(point)
    this.prune()
    this.save()

    log('INFO', 'feedback_store_recorded', {
      metric: input.metric,
      value: input.value,
      category: input.category,
      totalPoints: this.dataPoints.length,
    })
  }

  /** 批量记录多个数据点 */
  recordBatch(points: Array<{
    metric: string
    value: number
    category: FeedbackMetricCategory
    context?: string
  }>): void {
    const now = Date.now()
    for (const p of points) {
      this.dataPoints.push({
        timestamp: now,
        metric: p.metric,
        value: p.value,
        category: p.category,
        context: p.context,
      })
    }
    this.prune()
    this.save()

    log('INFO', 'feedback_store_batch_recorded', {
      count: points.length,
      totalPoints: this.dataPoints.length,
    })
  }

  // ═══════════════════════════════════════════════
  //  数据查询
  // ═══════════════════════════════════════════════

  /** 获取所有数据点 */
  getAll(): FeedbackDataPoint[] {
    return [...this.dataPoints]
  }

  /** 获取指定分类的数据点 */
  getByCategory(category: FeedbackMetricCategory): FeedbackDataPoint[] {
    return this.dataPoints.filter((p) => p.category === category)
  }

  /** 获取指定指标的数据点 */
  getByMetric(metric: string): FeedbackDataPoint[] {
    return this.dataPoints.filter((p) => p.metric === metric)
  }

  /** 获取指定时间范围内的数据点 */
  getInTimeRange(start: number, end: number): FeedbackDataPoint[] {
    return this.dataPoints.filter((p) => p.timestamp >= start && p.timestamp <= end)
  }

  /** 获取最近 N 小时内的数据点 */
  getRecent(hours: number): FeedbackDataPoint[] {
    const cutoff = Date.now() - hours * 3_600_000
    return this.dataPoints.filter((p) => p.timestamp >= cutoff)
  }

  /** 获取两个不重叠的时间窗口的聚合数据用于对比分析 */
  getWindowsForAnalysis(
    windowHours: number = ANALYSIS_WINDOW_HOURS,
    comparisonHours: number = COMPARISON_WINDOW_HOURS,
  ): {
    current: FeedbackDataPoint[]
    previous: FeedbackDataPoint[]
  } {
    const now = Date.now()
    const currentStart = now - windowHours * 3_600_000
    const previousStart = currentStart - comparisonHours * 3_600_000

    return {
      current: this.dataPoints.filter((p) => p.timestamp >= currentStart),
      previous: this.dataPoints.filter((p) => p.timestamp >= previousStart && p.timestamp < currentStart),
    }
  }

  // ═══════════════════════════════════════════════
  //  指标分析
  // ═══════════════════════════════════════════════

  /**
   * 对所有分类执行指标分析。
   * 对每个分类计算当前窗口和对比窗口的均值，分析趋势。
   */
  analyzeMetrics(): FeedbackMetricAnalysis[] {
    const analyses: FeedbackMetricAnalysis[] = []

    // 获取每个分类的聚合指标
    const categories: FeedbackMetricCategory[] = [
      'user_satisfaction',
      'task_success',
      'interruption',
      'latency',
      'repeat_question',
      'error_frequency',
    ]

    for (const category of categories) {
      const analysis = this.analyzeMetricCategory(category)
      if (analysis) analyses.push(analysis)
    }

    return analyses
  }

  /** 分析特定分类的指标 */
  private analyzeMetricCategory(category: FeedbackMetricCategory): FeedbackMetricAnalysis | null {
    const { current, previous } = this.getWindowsForAnalysis()

    const currentPoints = current.filter((p) => p.category === category)
    const previousPoints = previous.filter((p) => p.category === category)

    if (currentPoints.length === 0) return null

    const currentMean = this.mean(currentPoints.map((p) => p.value))
    // 对需要平均的指标（如 latency）取均值，对比率类（如 success_rate）也取均值
    const previousMean = previousPoints.length > 0
      ? this.mean(previousPoints.map((p) => p.value))
      : currentMean // 无历史数据则视为稳定

    const trend = this.determineTrend(category, currentMean, previousMean, currentPoints, previousPoints)

    const isConcerning = this.isMetricConcerning(category, currentMean, trend, currentPoints)

    const suggestion = isConcerning
      ? this.suggestAction(category, currentMean, trend)
      : undefined

    const metricName = this.getMetricName(category)

    return {
      metric: metricName,
      category,
      windowHours: ANALYSIS_WINDOW_HOURS,
      currentValue: currentMean,
      previousValue: previousMean,
      trend,
      sampleCount: currentPoints.length,
      isConcerning,
      suggestion,
    }
  }

  /** 判断趋势方向 */
  private determineTrend(
    category: FeedbackMetricCategory,
    currentMean: number,
    previousMean: number,
    currentPoints: FeedbackDataPoint[],
    previousPoints: FeedbackDataPoint[],
  ): FeedbackMetricAnalysis['trend'] {
    // 数据量不足
    if (currentPoints.length < 3) return 'stable'
    if (previousPoints.length < 3) return 'stable'

    const delta = currentMean - previousMean
    const absDelta = Math.abs(delta)

    // 波动性检测：如果当前窗口的标准差较大，标记为 volatile
    const stddev = this.stddev(currentPoints.map((p) => p.value))
    const mean = currentMean
    const cv = mean > 0 ? stddev / mean : stddev // 变异系数

    if (cv > 0.5 && currentPoints.length > 5) return 'volatile'

    // 阈值判断
    const threshold = 0.05 // 5% 变化视为有意义

    // 对于"越高越好"的指标（满意度、成功率）
    const higherIsBetter: FeedbackMetricCategory[] = ['user_satisfaction', 'task_success']
    // 对于"越低越好"的指标（中断率、延迟、重复提问、错误率）
    const lowerIsBetter: FeedbackMetricCategory[] = ['interruption', 'latency', 'repeat_question', 'error_frequency']

    if (higherIsBetter.includes(category)) {
      if (delta > threshold) return 'improving'
      if (delta < -threshold) return 'degrading'
    }

    if (lowerIsBetter.includes(category)) {
      if (delta < -threshold) return 'improving'
      if (delta > threshold) return 'degrading'
    }

    return 'stable'
  }

  /** 判断指标是否令人担忧 */
  private isMetricConcerning(
    category: FeedbackMetricCategory,
    currentValue: number,
    trend: FeedbackMetricAnalysis['trend'],
    points: FeedbackDataPoint[],
  ): boolean {
    // 趋势恶化直接告警
    if (trend === 'degrading') return true

    // 波动性高且数据充足
    if (trend === 'volatile' && points.length >= 5) return true

    // 绝对值超过经验阈值
    switch (category) {
      case 'user_satisfaction':
        return currentValue < 0.5 // 满意度低于 50%
      case 'task_success':
        return currentValue < 0.7 // 成功率低于 70%
      case 'interruption':
        return currentValue > 0.3 // 中断率高于 30%
      case 'latency':
        return currentValue > 10_000 // 延迟超过 10 秒（毫秒）
      case 'repeat_question':
        return currentValue > 0.2 // 重复提问率高于 20%
      case 'error_frequency':
        return currentValue > 0.15 // 错误率高于 15%
    }
  }

  /** 生成建议操作文本 */
  private suggestAction(
    category: FeedbackMetricCategory,
    currentValue: number,
    trend: FeedbackMetricAnalysis['trend'],
  ): string {
    switch (category) {
      case 'user_satisfaction':
        return `用户满意度 ${(currentValue * 100).toFixed(0)}%${trend === 'degrading' ? '（持续下降）' : '（偏低）'}，建议降低 Agent 温度以增加回复确定性`
      case 'task_success':
        return `任务成功率 ${(currentValue * 100).toFixed(0)}%${trend === 'degrading' ? '（持续下降）' : '（偏低）'}，建议检查工具调用参数超时时间`
      case 'interruption':
        return `用户中断率 ${(currentValue * 100).toFixed(0)}%${trend === 'degrading' ? '（持续上升）' : '（偏高）'}，建议缩短回复长度或提高语速`
      case 'latency':
        return `响应延迟 ${(currentValue / 1000).toFixed(1)}s${trend === 'degrading' ? '（持续增加）' : '（偏高）'}，建议减小缓存 TTL 或调整对话超时`
      case 'repeat_question':
        return `重复提问率 ${(currentValue * 100).toFixed(0)}%${trend === 'degrading' ? '（持续上升）' : '（偏高）'}，建议增加回复详细度或调整温度`
      case 'error_frequency':
        return `错误率 ${(currentValue * 100).toFixed(0)}%${trend === 'degrading' ? '（持续上升）' : '（偏高）'}，建议检查工具缓存和超时设置`
    }
  }

  /** 获取分类的人类可读名称 */
  private getMetricName(category: FeedbackMetricCategory): string {
    const names: Record<FeedbackMetricCategory, string> = {
      user_satisfaction: '用户满意度',
      task_success: '任务成功率',
      interruption: '用户中断率',
      latency: '响应延迟',
      repeat_question: '重复提问率',
      error_frequency: '错误频率',
    }
    return names[category]
  }

  // ═══════════════════════════════════════════════
  //  数据维护
  // ═══════════════════════════════════════════════

  /** 清理超过保留期限的旧数据 */
  private prune(): void {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
    const before = this.dataPoints.length
    this.dataPoints = this.dataPoints.filter((p) => p.timestamp >= cutoff)
    const pruned = before - this.dataPoints.length
    if (pruned > 0) {
      log('INFO', 'feedback_store_pruned', { pruned, remaining: this.dataPoints.length })
    }
  }

  /** 手动触发清理 */
  pruneNow(retentionDays?: number): number {
    if (retentionDays !== undefined) this.retentionDays = retentionDays
    const before = this.dataPoints.length
    this.prune()
    this.save()
    return before - this.dataPoints.length
  }

  /** 获取数据点总数 */
  get size(): number {
    return this.dataPoints.length
  }

  /** 获取统计摘要 */
  getStats(): { total: number; byCategory: Record<string, number>; retentionDays: number } {
    const byCategory: Record<string, number> = {}
    for (const p of this.dataPoints) {
      byCategory[p.category] = (byCategory[p.category] || 0) + 1
    }
    return {
      total: this.dataPoints.length,
      byCategory,
      retentionDays: this.retentionDays,
    }
  }

  // ═══════════════════════════════════════════════
  //  持久化
  // ═══════════════════════════════════════════════

  private load(): void {
    try {
      if (!existsSync(STORE_FILE)) {
        this.dataPoints = []
        return
      }
      const raw = readFileSync(STORE_FILE, 'utf-8')
      const data: FeedbackStoreData = JSON.parse(raw)
      if (Array.isArray(data.dataPoints)) {
        this.dataPoints = data.dataPoints
      }
      log('INFO', 'feedback_store_loaded', { dataPoints: this.dataPoints.length })
    } catch (err: any) {
      log('WARN', 'feedback_store_load_failed', { error: err.message })
      this.dataPoints = []
    }
  }

  private save(): void {
    try {
      const dir = dirname(STORE_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data: FeedbackStoreData = {
        version: STORE_VERSION,
        updatedAt: Date.now(),
        dataPoints: this.dataPoints,
      }
      writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err: any) {
      log('WARN', 'feedback_store_save_failed', { error: err.message })
    }
  }

  // ═══════════════════════════════════════════════
  //  统计工具
  // ═══════════════════════════════════════════════

  private mean(values: number[]): number {
    if (values.length === 0) return 0
    return values.reduce((s, v) => s + v, 0) / values.length
  }

  private stddev(values: number[]): number {
    if (values.length < 2) return 0
    const m = this.mean(values)
    const squaredDiffs = values.map((v) => (v - m) ** 2)
    return Math.sqrt(squaredDiffs.reduce((s, d) => s + d, 0) / (values.length - 1))
  }
}

/** 全局单例 */
export const feedbackMetadataStore = new FeedbackMetadataStore()
