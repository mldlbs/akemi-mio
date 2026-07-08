/**
 * ContextualTtsAdvisor — 交互情境自适应语音顾问
 *
 * 综合用户交互节奏（interaction cadence）和时段感知（time-of-day），
 * 生成情境敏感的 TTS 参数推荐。与现有的 BehaviorEmotionDetector、
 * ToneProfileAnalyzer、VoiceStyleMap 协同工作。
 *
 * 检测维度：
 *   1. 交互节奏 (cadence): rapid / normal / low
 *      - rapid:  最近 N 次交互间隔均短于阈值 → 用户急迫/高频操作
 *      - low:    最近交互距今已过很长时间 → 用户低频/回归
 *      - normal: 介于两者之间
 *   2. 时段感知 (dayPeriod): morning / afternoon / evening / late_night
 *      - 深夜时段自动降低语速和音调，避免打扰
 *
 * 集成点：
 *   - ChatExecutor.run() → advisor.recordInteraction() 记录每次用户交互
 *   - ChatExecutor.applySentimentToTts() → advisor.getRecommendation() 获取推荐
 *   - IPC handler → advisor.setEnabled() 切换自动/手动模式（系统托盘）
 */

import { log } from '../logger/Logger'
import type {
  InteractionCadence,
  DayPeriod,
  InteractionIntervalStats,
  InteractionContext,
  EmotionTtsParams,
} from './types'
import { CADENCE_TTS_MAP, DAY_PERIOD_TTS_MAP } from './types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 交互间隔分析窗口（最近 N 次交互） */
const INTERVAL_WINDOW_SIZE = 12

/** 急迫检测：短间隔阈值（秒），间隔低于此值视为快速交互 */
const RAPID_INTERVAL_THRESHOLD_SEC = 30

/** 急迫检测：连续快速交互次数阈值（达到此值判定为 rapid） */
const RAPID_BURST_THRESHOLD = 4

/** 低频检测：最后一次交互距今超过此时间（秒）视为低频回归 */
const LOW_INTERACTION_GAP_SEC = 300 // 5 分钟

/** 低频检测：平均间隔超过此时间（秒）视为低频 */
const LOW_MEAN_INTERVAL_SEC = 120 // 2 分钟

/** 最大保留的交互记录数 */
const MAX_INTERACTION_RECORDS = INTERVAL_WINDOW_SIZE * 3

/** 置信度所需的最小交互次数（低于此值返回低置信度） */
const MIN_INTERACTIONS_FOR_CONFIDENCE = 3

// ══════════════════════════════════════════
//  时段定义
// ══════════════════════════════════════════

/** 深夜开始时间（小时，24h） */
const LATE_NIGHT_START_HOUR = 23
/** 深夜结束时间（小时，24h） */
const LATE_NIGHT_END_HOUR = 6
/** 早晨开始时间 */
const MORNING_START_HOUR = 6
/** 下午开始时间 */
const AFTERNOON_START_HOUR = 12
/** 傍晚开始时间 */
const EVENING_START_HOUR = 18

// ══════════════════════════════════════════
//  ContextualTtsAdvisor
// ══════════════════════════════════════════

export class ContextualTtsAdvisor {
  /** 交互时间戳列表（Unix ms） */
  private interactionTimestamps: number[] = []

  /** 是否启用（用户可通过系统托盘切换自动/手动模式） */
  private enabled = true

  /** 上次推荐结果缓存 */
  private lastRecommendation: InteractionContext | null = null
  private lastRecommendationTime = 0
  /** 缓存有效期（ms） */
  private readonly CACHE_TTL_MS = 5000

  // ── 生命周期 ──

  /** 启用/禁用情境自适应语音（用户通过系统托盘切换） */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.lastRecommendation = null
      this.lastRecommendationTime = 0
    }
    log('INFO', 'contextual_tts_enabled', { enabled })
  }

  isEnabled(): boolean {
    return this.enabled
  }

  // ── 数据采集 ──

  /**
   * 记录一次用户交互（消息发送或工具调用）。
   * 应在每次用户输入到达时调用。
   */
  recordInteraction(): void {
    this.interactionTimestamps.push(Date.now())
    if (this.interactionTimestamps.length > MAX_INTERACTION_RECORDS) {
      this.interactionTimestamps = this.interactionTimestamps.slice(-MAX_INTERACTION_RECORDS)
    }
    // 使缓存失效
    this.lastRecommendation = null
  }

  // ── 情境分析 ──

  /**
   * 获取当前交互情境的 TTS 参数推荐。
   *
   * 5 秒内有缓存直接返回。
   * 综合交互节奏（权重 60%）和时段（权重 40%）生成推荐。
   */
  getRecommendation(): InteractionContext {
    if (!this.enabled) {
      return this.neutralContext('disabled')
    }

    const now = Date.now()
    if (this.lastRecommendation && (now - this.lastRecommendationTime) < this.CACHE_TTL_MS) {
      return this.lastRecommendation
    }

    const intervalStats = this.computeIntervalStats()
    const cadence = this.classifyCadence(intervalStats)
    const dayPeriod = this.classifyDayPeriod()

    // 计算置信度
    const hasEnoughData = intervalStats.interactionCount >= MIN_INTERACTIONS_FOR_CONFIDENCE
    const confidence = hasEnoughData ? Math.min(1, intervalStats.interactionCount / INTERVAL_WINDOW_SIZE) : 0.15

    // 混合 cadence 参数和 dayPeriod 参数
    const cadenceParams = CADENCE_TTS_MAP[cadence]
    const dayParams = DAY_PERIOD_TTS_MAP[dayPeriod]

    const cadenceRate = parseInt(cadenceParams.rate.replace(/[^0-9-]/g, '')) || 0
    const dayRate = parseInt(dayParams.rate.replace(/[^0-9-]/g, '')) || 0
    const cadencePitch = parseInt(cadenceParams.pitch.replace(/[^0-9-]/g, '')) || 0
    const dayPitch = parseInt(dayParams.pitch.replace(/[^0-9-]/g, '')) || 0

    // 深夜时段加强时段权重（70%），更柔和
    let cadenceWeight = 0.6
    let dayWeight = 0.4
    if (dayPeriod === 'late_night') {
      cadenceWeight = 0.3
      dayWeight = 0.7
    }

    const finalRate = Math.round(cadenceRate * cadenceWeight + dayRate * dayWeight)
    const finalPitch = Math.round(cadencePitch * cadenceWeight + dayPitch * dayWeight)

    const ttsParams: EmotionTtsParams = {
      voice: cadenceWeight > dayWeight ? cadenceParams.voice : dayParams.voice,
      rate: `${finalRate >= 0 ? '+' : ''}${finalRate}%`,
      pitch: `${finalPitch >= 0 ? '+' : ''}${finalPitch}Hz`,
      label: `${cadenceParams.label}·${dayParams.label}`,
    }

    const description = this.buildDescription(cadence, dayPeriod, intervalStats)

    // 仅在有意义的变化时记录日志
    if (confidence > 0.3 && (cadence !== 'normal' || dayPeriod === 'late_night')) {
      log('INFO', 'contextual_tts_recommendation', {
        cadence,
        dayPeriod,
        confidence: confidence.toFixed(2),
        meanIntervalSec: intervalStats.meanIntervalSec.toFixed(1),
        rapidBurstCount: intervalStats.rapidBurstCount,
        voice: ttsParams.voice,
        rate: ttsParams.rate,
        pitch: ttsParams.pitch,
        label: ttsParams.label,
      })
    }

    const result: InteractionContext = {
      cadence,
      dayPeriod,
      intervalStats,
      ttsParams,
      confidence: Math.round(confidence * 100) / 100,
      description,
    }

    this.lastRecommendation = result
    this.lastRecommendationTime = now
    return result
  }

  /**
   * 获取推荐的 TTS 参数（便捷方法）。
   */
  getRecommendedTtsParams(): EmotionTtsParams {
    return this.getRecommendation().ttsParams
  }

  // ── 私有：交互间隔统计 ──

  /**
   * 计算交互间隔统计。
   * 基于时间戳数组计算均值、中位数、最近间隔等。
   */
  private computeIntervalStats(): InteractionIntervalStats {
    const now = Date.now()
    const timestamps = this.interactionTimestamps.slice(-INTERVAL_WINDOW_SIZE)

    if (timestamps.length < 2) {
      const lastGap = timestamps.length === 1
        ? (now - timestamps[0]) / 1000
        : 0
      return {
        meanIntervalSec: 0,
        medianIntervalSec: 0,
        lastInteractionSec: lastGap,
        interactionCount: timestamps.length,
        intervals: [],
        rapidBurstCount: 0,
      }
    }

    // 计算相邻交互间隔（秒）
    const intervals: number[] = []
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push((timestamps[i] - timestamps[i - 1]) / 1000)
    }

    // 均值
    const meanIntervalSec = intervals.reduce((s, v) => s + v, 0) / intervals.length

    // 中位数
    const sorted = [...intervals].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const medianIntervalSec = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid]

    // 最后一次交互距今
    const lastInteractionSec = (now - timestamps[timestamps.length - 1]) / 1000

    // 急迫检测：从最近开始往前数，连续低于阈值的交互次数
    let rapidBurstCount = 0
    for (let i = intervals.length - 1; i >= 0; i--) {
      if (intervals[i] < RAPID_INTERVAL_THRESHOLD_SEC) {
        rapidBurstCount++
      } else {
        break
      }
    }

    return {
      meanIntervalSec: Math.round(meanIntervalSec * 10) / 10,
      medianIntervalSec: Math.round(medianIntervalSec * 10) / 10,
      lastInteractionSec: Math.round(lastInteractionSec * 10) / 10,
      interactionCount: timestamps.length,
      intervals,
      rapidBurstCount,
    }
  }

  // ── 私有：交互节奏分类 ──

  /**
   * 基于间隔统计分类交互节奏。
   *
   * 规则优先级：
   *   1. 连续快速交互次数 >= 阈值 → rapid
   *   2. 最后交互距今 > 低频阈值 且平均间隔 > 低频均值阈值 → low
   *   3. 其他 → normal
   */
  private classifyCadence(stats: InteractionIntervalStats): InteractionCadence {
    if (stats.interactionCount < MIN_INTERACTIONS_FOR_CONFIDENCE) {
      return 'normal'
    }

    // rapid: 连续快速交互
    if (stats.rapidBurstCount >= RAPID_BURST_THRESHOLD) {
      return 'rapid'
    }

    // low: 长时间未交互 + 平均间隔长
    if (stats.lastInteractionSec > LOW_INTERACTION_GAP_SEC &&
        stats.meanIntervalSec > LOW_MEAN_INTERVAL_SEC) {
      return 'low'
    }

    return 'normal'
  }

  // ── 私有：时段分类 ──

  /**
   * 根据当前系统时间分类时段。
   */
  private classifyDayPeriod(): DayPeriod {
    const hour = new Date().getHours()

    if (hour >= LATE_NIGHT_START_HOUR || hour < LATE_NIGHT_END_HOUR) {
      return 'late_night'
    }
    if (hour >= MORNING_START_HOUR && hour < AFTERNOON_START_HOUR) {
      return 'morning'
    }
    if (hour >= AFTERNOON_START_HOUR && hour < EVENING_START_HOUR) {
      return 'afternoon'
    }
    return 'evening'
  }

  // ── 私有：描述生成 ──

  /**
   * 生成人类可读的情境描述。
   */
  private buildDescription(
    cadence: InteractionCadence,
    dayPeriod: DayPeriod,
    stats: InteractionIntervalStats,
  ): string {
    const cadenceLabel: Record<InteractionCadence, string> = {
      rapid: '高频交互',
      normal: '正常节奏',
      low: '低频交互',
    }
    const periodLabel: Record<DayPeriod, string> = {
      morning: '早晨',
      afternoon: '午后',
      evening: '傍晚',
      late_night: '深夜',
    }

    let desc = `${periodLabel[dayPeriod]}·${cadenceLabel[cadence]}`
    if (stats.interactionCount >= MIN_INTERACTIONS_FOR_CONFIDENCE) {
      desc += ` | 均隔${stats.meanIntervalSec.toFixed(0)}s`
    }
    return desc
  }

  // ── 状态查询 ──

  /** 获取当前交互间隔统计（供调试/UI 展示） */
  getIntervalStats(): InteractionIntervalStats {
    return this.computeIntervalStats()
  }

  /** 获取当前时段 */
  getDayPeriod(): DayPeriod {
    return this.classifyDayPeriod()
  }

  /** 获取所有支持的情境映射（供调试/UI 展示） */
  getAllMappings(): {
    cadences: Array<{ cadence: InteractionCadence; params: EmotionTtsParams }>
    periods: Array<{ period: DayPeriod; params: EmotionTtsParams }>
  } {
    const cadenceKeys: InteractionCadence[] = ['rapid', 'normal', 'low']
    const periodKeys: DayPeriod[] = ['morning', 'afternoon', 'evening', 'late_night']

    return {
      cadences: cadenceKeys.map((c) => ({ cadence: c, params: CADENCE_TTS_MAP[c] })),
      periods: periodKeys.map((p) => ({ period: p, params: DAY_PERIOD_TTS_MAP[p] })),
    }
  }

  /** 重置所有运行时数据 */
  reset(): void {
    this.interactionTimestamps = []
    this.lastRecommendation = null
    this.lastRecommendationTime = 0
  }

  // ── 私有工具方法 ──

  /** 生成中性/禁用结果 */
  private neutralContext(reason: string): InteractionContext {
    return {
      cadence: 'normal',
      dayPeriod: this.classifyDayPeriod(),
      intervalStats: {
        meanIntervalSec: 0,
        medianIntervalSec: 0,
        lastInteractionSec: 0,
        interactionCount: 0,
        intervals: [],
        rapidBurstCount: 0,
      },
      ttsParams: { ...CADENCE_TTS_MAP['normal'] },
      confidence: 0,
      description: `${reason}`,
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 ChatExecutor 使用 */
export const contextualTtsAdvisor = new ContextualTtsAdvisor()
