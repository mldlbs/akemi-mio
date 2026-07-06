/**
 * BehaviorWeightingService — 短期行为驱动的记忆加权
 *
 * 根据用户最近 N 次交互中体现的当前兴趣领域，对记忆检索结果进行动态加权，
 * 使相关性更高的记忆在检索结果中更加突出。
 *
 * 核心流程：
 * 1. 从 InteractionTracker 获取最近 N 次交互记录
 * 2. 提取每条交互的主题标签，按时间衰减加权聚合为兴趣分布
 * 3. 检索时计算记忆主题与当前兴趣分布的相似度
 * 4. 将相似度作为 boost 因子应用到记忆的有效得分中
 *
 * 配置参数：
 * - interestWindowSize: 分析窗口大小（默认 16）
 * - recencyDecayRate: 时间衰减速率（0-1，默认 0.92，每步衰减）
 * - baseBoostFactor: 基础提升因子（默认 0.3，最大额外加分）
 * - minInterestStrength: 最小兴趣强度阈值（默认 2，低于此值不触发加权）
 */

import { log } from '../logger/Logger'
import type { InteractionRecord } from './types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 分析窗口大小：最近 N 次交互 */
const DEFAULT_INTEREST_WINDOW_SIZE = 16

/** 时间衰减速率（每步，即按交互序列位置衰减） */
const DEFAULT_RECENCY_DECAY_RATE = 0.92

/** 基础提升因子：相似度满匹配时的最大额外加分 */
const DEFAULT_BASE_BOOST_FACTOR = 0.3

/** 最小兴趣强度：兴趣分布中某主题的权重低于此值不参与加权 */
const DEFAULT_MIN_INTEREST_STRENGTH = 2.0

/** 兴趣更新间隔（毫秒）：避免每次检索都重新计算 */
const DEFAULT_UPDATE_INTERVAL_MS = 60_000 // 每 60 秒更新一次

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface InterestProfile {
  /** 主题 → 加权频率（考虑时间衰减） */
  topicWeights: Map<string, number>
  /** 总加权交互次数 */
  totalWeight: number
  /** 上次更新时间 */
  lastUpdated: number
}

export interface BehaviorWeightingConfig {
  /** 分析窗口大小 */
  interestWindowSize: number
  /** 时间衰减速率（0-1，每步） */
  recencyDecayRate: number
  /** 基础提升因子（0-1） */
  baseBoostFactor: number
  /** 最小兴趣强度阈值 */
  minInterestStrength: number
  /** 兴趣更新间隔（ms） */
  updateIntervalMs: number
}

export const DEFAULT_CONFIG: BehaviorWeightingConfig = {
  interestWindowSize: DEFAULT_INTEREST_WINDOW_SIZE,
  recencyDecayRate: DEFAULT_RECENCY_DECAY_RATE,
  baseBoostFactor: DEFAULT_BASE_BOOST_FACTOR,
  minInterestStrength: DEFAULT_MIN_INTEREST_STRENGTH,
  updateIntervalMs: DEFAULT_UPDATE_INTERVAL_MS,
}

// ══════════════════════════════════════════
//  BehaviorWeightingService
// ══════════════════════════════════════════

export class BehaviorWeightingService {
  private config: BehaviorWeightingConfig
  private cachedProfile: InterestProfile | null = null

  constructor(config?: Partial<BehaviorWeightingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 获取当前配置的只读副本 */
  getConfig(): Readonly<BehaviorWeightingConfig> {
    return this.config
  }

  /** 更新配置 */
  updateConfig(partial: Partial<BehaviorWeightingConfig>): void {
    this.config = { ...this.config, ...partial }
    // 配置变更时清除缓存，强制重新计算
    this.cachedProfile = null
  }

  // ══════════════════════════════════════════
  //  兴趣分布计算
  // ══════════════════════════════════════════

  /**
   * 从最近交互记录中计算当前兴趣分布。
   * 使用时间衰减加权：越近的交互权重越高。
   *
   * @param interactions 交互记录列表（按时间升序）
   * @param forceRefresh 强制刷新缓存
   */
  computeInterestProfile(
    interactions: InteractionRecord[],
    forceRefresh = false,
  ): InterestProfile {
    // 缓存逻辑：避免频繁重新计算
    const now = Date.now()
    if (
      !forceRefresh &&
      this.cachedProfile &&
      now - this.cachedProfile.lastUpdated < this.config.updateIntervalMs
    ) {
      return this.cachedProfile
    }

    const windowSize = this.config.interestWindowSize
    const decayRate = this.config.recencyDecayRate

    // 取最近 N 次交互
    const recent = interactions.slice(-windowSize)
    const topicWeights = new Map<string, number>()
    let totalWeight = 0

    // 按位置计算衰减权重：最近的位置权重最高
    for (let i = 0; i < recent.length; i++) {
      const position = recent.length - 1 - i // 0 = 最旧, n-1 = 最新
      const recencyWeight = Math.pow(decayRate, position)

      const record = recent[i]
      if (!record.topics || record.topics.length === 0) continue

      for (const topic of record.topics) {
        const current = topicWeights.get(topic) || 0
        topicWeights.set(topic, current + recencyWeight)
        totalWeight += recencyWeight
      }
    }

    const profile: InterestProfile = {
      topicWeights,
      totalWeight,
      lastUpdated: now,
    }

    this.cachedProfile = profile

    if (topicWeights.size > 0) {
      log('INFO', 'behavior_interest_profile_computed', {
        topics: topicWeights.size,
        totalWeight: totalWeight.toFixed(2),
        windowSize,
        topTopics: [...topicWeights.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([t, w]) => `${t}(${w.toFixed(2)})`),
      })
    }

    return profile
  }

  /**
   * 获取兴趣分布中的前 K 个主题（用于调试和显示）
   */
  getTopInterests(profile: InterestProfile, k = 5): string[] {
    return [...profile.topicWeights.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([topic]) => topic)
  }

  // ══════════════════════════════════════════
  //  主题相似度计算
  // ══════════════════════════════════════════

  /**
   * 计算记忆主题与当前兴趣分布的相似度 boost 因子。
   *
   * 算法：
   * 1. 计算记忆主题集合与兴趣主题集合的交集
   * 2. 对交集中的每个主题，累加其在兴趣分布中的权重
   * 3. 使用 overlap 系数归一化：交集权重 / max(记忆主题数, 1)
   * 4. 乘以基础提升因子得到最终 boost
   *
   * @param memoryTopics 记忆的主题标签列表
   * @param profile 当前兴趣分布
   * @returns boost 因子 (0 ~ baseBoostFactor)
   */
  getTopicSimilarityBoost(
    memoryTopics: string[],
    profile: InterestProfile,
  ): number {
    if (!memoryTopics || memoryTopics.length === 0) return 0
    if (profile.topicWeights.size === 0) return 0

    const minStrength = this.config.minInterestStrength
    let intersectionWeight = 0

    for (const topic of memoryTopics) {
      const weight = profile.topicWeights.get(topic)
      if (weight !== undefined && weight >= minStrength) {
        intersectionWeight += weight
      }
    }

    if (intersectionWeight === 0) return 0

    // Overlap 系数：交集权重 / 记忆主题数（避免记忆主题多时 boost 过高）
    const overlapCoefficient = intersectionWeight / Math.max(memoryTopics.length, 1)

    // 归一化到 0~1 再乘以基础提升因子
    // 使用 tanh 做平滑上限，避免极端值
    const normalizedOverlap = Math.tanh(overlapCoefficient)
    const boost = normalizedOverlap * this.config.baseBoostFactor

    return boost
  }

  /**
   * 计算行为加权后的有效得分。
   *
   * @param baseScore 基础得分（来自 getEffectiveScore 等）
   * @param memoryTopics 记忆主题标签
   * @param profile 当前兴趣分布
   * @returns 加权后的得分 (0~1)
   */
  getWeightedScore(
    baseScore: number,
    memoryTopics: string[],
    profile: InterestProfile,
  ): number {
    const boost = this.getTopicSimilarityBoost(memoryTopics, profile)
    // 得分 = 基础分 + 兴趣 boost，上限为 1.0
    return Math.min(1.0, baseScore + boost)
  }

  // ══════════════════════════════════════════
  //  兴趣分布调试
  // ══════════════════════════════════════════

  /**
   * 获取兴趣分布的可读摘要（用于日志和调试）
   */
  getInterestSummary(profile: InterestProfile): string {
    if (profile.topicWeights.size === 0) return '(无活跃兴趣)'
    const top = this.getTopInterests(profile, 5)
    return top.join(' > ')
  }

  /** 清除缓存（强制下次检索重新计算） */
  invalidateCache(): void {
    this.cachedProfile = null
  }
}
