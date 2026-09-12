/**
 * RadarFeedbackService — 雷达反馈记忆优化服务
 *
 * 将用户对雷达抓取结果的反馈记录到 Memory 系统，
 * 通过分析负面反馈占比自动调整抓取策略，提升内容质量。
 *
 * 使用方式：
 * - 用户在 Bot 推送雷达结果后回复"错误/过时/不相关"等关键词
 * - LLM 检测到反馈后调用 radar_feedback 工具
 * - 本服务将反馈存入 Memory，后续 radar_scan 自动跳过负面反馈多的源
 */

import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'
import { log } from '@akemi-mio/core/logger/Logger'

// =============================================================================
// 常量 & 类型
// =============================================================================

/** Memory 中反馈条目 key 前缀 */
const FEEDBACK_KEY_PREFIX = 'radar_feedback'

/** 负面反馈占比阈值：超过此值自动跳过该源 */
const DEFAULT_NEGATIVE_THRESHOLD = 0.3

/** 统计回溯窗口（小时） */
const DEFAULT_LOOKBACK_HOURS = 24

/** 支持的反馈类型（负面 + 正面） */
export type RadarFeedbackType =
  | 'error' // 错误：内容有事实性错误
  | 'outdated' // 过时：信息已过期
  | 'irrelevant' // 不相关：与用户兴趣无关
  | 'useful' // 有用：正向反馈

/** 反馈事件结构 */
export interface RadarFeedbackEvent {
  source: string
  type: RadarFeedbackType
  content: string
  timestamp: string
  isNegative: boolean
}

/** 每个源的反馈统计 */
export interface SourceFeedbackStat {
  total: number
  negative: number
  positive: number
  negativeRatio: number
  recentEvents: RadarFeedbackEvent[]
}

/** 反馈统计总览 */
export interface RadarFeedbackStats {
  totalEvents: number
  totalNegative: number
  overallNegativeRatio: number
  perSource: Record<string, SourceFeedbackStat>
  skippedSources: string[]
  threshold: number
  lookbackHours: number
}

// =============================================================================
// RadarFeedbackService
// =============================================================================

export class RadarFeedbackService {
  private negativeThreshold = DEFAULT_NEGATIVE_THRESHOLD

  /**
   * 调整负面反馈阈值（0-1），供维护者通过工具动态修改
   */
  setThreshold(threshold: number): void {
    this.negativeThreshold = Math.max(0, Math.min(1, threshold))
    log('INFO', 'radar_feedback_threshold_updated', { threshold: this.negativeThreshold })
  }

  getThreshold(): number {
    return this.negativeThreshold
  }

  /**
   * 记录一条雷达反馈到 Memory 系统。
   *
   * 存储两条记录：
   * 1. 完整反馈条目（含详情）— type=user_fact, tier=semi
   * 2. 如果为负面反馈，额外存储负面标记（便于快速查询）— type=user_fact, tier=semi
   *
   * @param source  采集源名称（如 hackernews, rss, weibo-hot 等）
   * @param type    反馈类型
   * @param content 反馈具体内容/用户原话
   */
  recordFeedback(source: string, type: RadarFeedbackType, content: string): void {
    const ms = getMemoryService()
    if (!ms) {
      log('WARN', 'radar_feedback_memory_unavailable', { source, type })
      return
    }

    const isNegative = type === 'error' || type === 'outdated' || type === 'irrelevant'
    const timestamp = new Date().toISOString()
    const truncatedContent = content.slice(0, 200)

    // 1. 完整反馈条目
    const feedbackEntry = `[${FEEDBACK_KEY_PREFIX}:${source}] 反馈:${type} — 来源:${source} — 详情:${truncatedContent} — 时间:${timestamp}`
    ms.addEntry('user_fact', feedbackEntry, 0.8, { tier: 'semi' })

    // 2. 负面反馈标记（便于快速统计查询）
    if (isNegative) {
      const markerEntry = `[${FEEDBACK_KEY_PREFIX}:negative:${source}] ${type} at ${timestamp}`
      ms.addEntry('user_fact', markerEntry, 0.9, { tier: 'semi' })
    }

    log('INFO', 'radar_feedback_recorded', {
      source,
      type,
      isNegative,
      contentPreview: truncatedContent.slice(0, 50),
    })
  }

  /**
   * 查询指定源在最近 N 小时内的负面反馈占比。
   *
   * @param source 采集源名称
   * @param hours  回溯小时数（默认 24h）
   * @returns 负面占比 0-1，若无反馈记录返回 0
   */
  getSourceNegativeRatio(source: string, hours: number = DEFAULT_LOOKBACK_HOURS): number {
    const ms = getMemoryService()
    if (!ms) return 0

    const cutoff = Date.now() - hours * 3600 * 1000
    const entries = ms.getEntries()

    const sourcePrefix = `[${FEEDBACK_KEY_PREFIX}:${source}]`
    const negativePrefix = `[${FEEDBACK_KEY_PREFIX}:negative:${source}]`

    const total = entries.filter((e) => e.content.startsWith(sourcePrefix) && e.createdAt >= cutoff).length
    const negative = entries.filter((e) => e.content.startsWith(negativePrefix) && e.createdAt >= cutoff).length

    if (total === 0) return 0
    return negative / total
  }

  /**
   * 检查某源是否因负面反馈过多应被跳过。
   *
   * @param source 采集源名称
   * @returns true=应跳过该源
   */
  shouldSkipSource(source: string): boolean {
    const ratio = this.getSourceNegativeRatio(source)
    return ratio >= this.negativeThreshold
  }

  /**
   * 获取完整的反馈统计数据。
   *
   * @param hours 回溯小时数（默认 24h）
   * @returns 结构化统计数据
   */
  getFeedbackStats(hours: number = DEFAULT_LOOKBACK_HOURS): RadarFeedbackStats {
    const ms = getMemoryService()
    if (!ms) {
      return {
        totalEvents: 0,
        totalNegative: 0,
        overallNegativeRatio: 0,
        perSource: {},
        skippedSources: [],
        threshold: this.negativeThreshold,
        lookbackHours: hours,
      }
    }

    const cutoff = Date.now() - hours * 3600 * 1000
    const entries = ms.getEntries()

    // 正则匹配：完整反馈条目和负面标记条目
    const feedbackPattern = new RegExp(`^\\[${FEEDBACK_KEY_PREFIX}:(\\w[\\w-]*)\\] 反馈:(\\w+)`)
    const negativePattern = new RegExp(`^\\[${FEEDBACK_KEY_PREFIX}:negative:(\\w[\\w-]*)\\]`)

    // 收集所有有反馈的源
    const sources = new Set<string>()
    for (const e of entries) {
      if (e.createdAt < cutoff) continue
      const fm = e.content.match(feedbackPattern)
      if (fm) sources.add(fm[1])
    }

    const perSource: Record<string, SourceFeedbackStat> = {}
    const skippedSources: string[] = []
    let totalEvents = 0
    let totalNegative = 0

    for (const source of sources) {
      const sourcePrefix = `[${FEEDBACK_KEY_PREFIX}:${source}]`
      const negativePrefix = `[${FEEDBACK_KEY_PREFIX}:negative:${source}]`

      const sourceEntries = entries.filter((e) => e.content.startsWith(sourcePrefix) && e.createdAt >= cutoff)
      const negativeCount = entries.filter((e) => e.content.startsWith(negativePrefix) && e.createdAt >= cutoff).length

      const total = sourceEntries.length
      const positive = total - negativeCount
      totalEvents += total
      totalNegative += negativeCount

      const negativeRatio = total > 0 ? negativeCount / total : 0

      if (negativeRatio >= this.negativeThreshold) {
        skippedSources.push(source)
      }

      perSource[source] = {
        total,
        negative: negativeCount,
        positive,
        negativeRatio,
        recentEvents: sourceEntries.slice(-10).map((e) => {
          const typeMatch = e.content.match(feedbackPattern)
          return {
            source,
            type: (typeMatch?.[2] as RadarFeedbackType) || 'error',
            content: e.content,
            timestamp: new Date(e.createdAt).toISOString(),
            isNegative: e.content.startsWith(negativePrefix),
          }
        }),
      }
    }

    return {
      totalEvents,
      totalNegative,
      overallNegativeRatio: totalEvents > 0 ? totalNegative / totalEvents : 0,
      perSource,
      skippedSources,
      threshold: this.negativeThreshold,
      lookbackHours: hours,
    }
  }
}

/** 全局单例 */
export const radarFeedbackService = new RadarFeedbackService()
