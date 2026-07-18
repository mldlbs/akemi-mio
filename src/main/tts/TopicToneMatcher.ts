/**
 * TopicToneMatcher — 话题语调匹配器
 *
 * 连接话题系统与 TTS 语音参数：
 *   1. 当 TTS 以某组参数（voice/rate/pitch）播报特定话题时 → 记录关联
 *   2. 后续遇到相同话题时 → 自动匹配之前使用的语音参数
 *   3. 利用 TopicTransitionPredictor 的话题预测辅助匹配
 *
 * 设计目标：
 * - 针对相同话题，自动匹配记忆中设定的语调，实现语音连贯性
 * - 用户感觉系统"记得"上次讨论该话题时的说话方式
 * - 话题-语调关联随使用次数增加而强化
 *
 * 数据持久化：
 * - 通过 MemoryService 的 user_profile（key 前缀 `topic_tone:`）存储
 * - 每个话题一条记录，包含 voice/rate/pitch 参数
 */

import { log } from '../logger/Logger'
import type { MemoryService } from '../memory/MemoryService'
import type { EmotionTtsParams } from './types'

/** Memory 用户画像 key 前缀 */
const PREF_KEY_PREFIX = 'topic_tone:'

/** 默认置信度阈值 */
const MIN_CONFIDENCE = 0.4

/** 记忆增强系数：每次匹配相同话题的提升值 */
const MATCH_BOOST = 0.1

/** 最高置信度上限 */
const MAX_CONFIDENCE = 1.0

// ═══════════════════════════════════════════════
//  类型（内部使用）
// ═══════════════════════════════════════════════

interface TopicToneEntry {
  params: EmotionTtsParams
  confidence: number
  lastMatchedAt: number
}

// ═══════════════════════════════════════════════
//  TopicToneMatcher
// ═══════════════════════════════════════════════

export class TopicToneMatcher {
  private memoryService: MemoryService | null = null

  /** 内存缓存：topic → TopicToneEntry */
  private topicToneMap = new Map<string, TopicToneEntry>()

  constructor() {
    log('INFO', 'topic_tone_matcher_created')
  }

  /** 注入 MemoryService 引用（由 PreferenceEnhancer 设置） */
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
    this.loadFromMemory()
    log('INFO', 'topic_tone_matcher_memory_attached')
  }

  // ════════════════════════════════════════════
  //  数据加载
  // ════════════════════════════════════════════

  /**
   * 从 MemoryService 加载所有话题语调设置。
   */
  loadFromMemory(): void {
    if (!this.memoryService) return

    try {
      const ms = this.memoryService
      const prefs = ms.getUserPreferences()
      const loaded = new Map<string, TopicToneEntry>()

      for (const pref of prefs) {
        if (!pref.key.startsWith(PREF_KEY_PREFIX)) continue

        const topic = pref.key.slice(PREF_KEY_PREFIX.length)
        if (!topic) continue

        // value 存储格式: "voice|rate|pitch|label"
        const parts = String(pref.value).split('|')
        if (parts.length >= 3) {
          loaded.set(topic, {
            params: {
              voice: parts[0],
              rate: parts[1],
              pitch: parts[2],
              label: parts[3] || `话题·${topic}`,
            },
            confidence: pref.confidence,
            lastMatchedAt: pref.updatedAt,
          })
        }
      }

      this.topicToneMap = loaded
      log('INFO', 'topic_tone_loaded', { count: this.topicToneMap.size })
    } catch (err) {
      log('WARN', 'topic_tone_load_failed', { error: String(err) })
    }
  }

  // ════════════════════════════════════════════
  //  记录
  // ════════════════════════════════════════════

  /**
   * 记录 TTS 对某个话题使用的语音参数。
   * 当同一话题再次出现时，这些参数将被自动匹配。
   *
   * @param topic 话题标签
   * @param params 使用的 TTS 参数
   * @param confidence 置信度（基于用户反馈等因素，默认 0.6）
   */
  recordToneForTopic(topic: string, params: EmotionTtsParams, confidence = 0.6): void {
    if (!topic || !params) return

    try {
      const existing = this.topicToneMap.get(topic)
      const newConfidence = existing
        ? Math.min(MAX_CONFIDENCE, existing.confidence + MATCH_BOOST)
        : confidence

      this.topicToneMap.set(topic, {
        params: { ...params },
        confidence: newConfidence,
        lastMatchedAt: Date.now(),
      })

      // 持久化
      if (this.memoryService) {
        const value = `${params.voice}|${params.rate}|${params.pitch}|${params.label}`
        this.memoryService.saveUserPreference({
          key: `${PREF_KEY_PREFIX}${topic}`,
          value,
          confidence: newConfidence,
          category: 'preference',
          source: 'topic_tone_match',
          updatedAt: Date.now(),
        })
      }

      log('INFO', 'topic_tone_recorded', {
        topic,
        voice: params.voice,
        rate: params.rate,
        pitch: params.pitch,
        confidence: newConfidence,
      })
    } catch (err) {
      log('WARN', 'topic_tone_record_failed', { error: String(err) })
    }
  }

  // ════════════════════════════════════════════
  //  匹配
  // ════════════════════════════════════════════

  /**
   * 根据当前话题列表，匹配最佳的历史语调参数。
   *
   * 匹配策略：
   * 1. 遍历所有话题，找高置信度（>= MIN_CONFIDENCE）的匹配
   * 2. 多个话题匹配时，选置信度最高的
   * 3. 无匹配时返回 null
   *
   * @param currentTopics 当前对话的话题标签列表
   * @returns 匹配到的参数和置信度，或 null
   */
  getToneForTopics(
    currentTopics: string[],
  ): { params: EmotionTtsParams; confidence: number; matchedTopic: string } | null {
    if (!currentTopics || currentTopics.length === 0 || this.topicToneMap.size === 0) {
      return null
    }

    try {
      let best: { topic: string; entry: TopicToneEntry } | null = null

      for (const topic of currentTopics) {
        const entry = this.topicToneMap.get(topic)
        if (!entry || entry.confidence < MIN_CONFIDENCE) continue

        if (!best || entry.confidence > best.entry.confidence) {
          best = { topic, entry }
        }
      }

      if (best) {
        log('INFO', 'topic_tone_matched', {
          topic: best.topic,
          voice: best.entry.params.voice,
          rate: best.entry.params.rate,
          pitch: best.entry.params.pitch,
          confidence: best.entry.confidence,
        })

        return {
          params: { ...best.entry.params },
          confidence: best.entry.confidence,
          matchedTopic: best.topic,
        }
      }

      return null
    } catch (err) {
      log('WARN', 'topic_tone_match_error', { error: String(err) })
      return null
    }
  }

  /**
   * 从当前话题预测中获取建议语调。
   * 同时检查当前话题和预测的下一个话题。
   *
   * @param currentTopics 当前话题
   * @param predictedTopics 预测的下一个话题（来自 TopicTransitionPredictor）
   * @returns 匹配到的参数和置信度，或 null
   */
  getToneForTopicsWithPrediction(
    currentTopics: string[],
    predictedTopics?: string[],
  ): { params: EmotionTtsParams; confidence: number; matchedTopic: string } | null {
    // 先从当前话题匹配
    const match = this.getToneForTopics(currentTopics)
    if (match) return match

    // 当前话题无匹配时，尝试预测话题
    if (predictedTopics && predictedTopics.length > 0) {
      const predictedMatch = this.getToneForTopics(predictedTopics)
      if (predictedMatch) {
        log('INFO', 'topic_tone_matched_via_prediction', {
          topic: predictedMatch.matchedTopic,
          confidence: predictedMatch.confidence,
        })
        return predictedMatch
      }
    }

    return null
  }

  /** 获取所有话题语调记录 */
  getAllTopicTones(): Array<{ topic: string; params: EmotionTtsParams; confidence: number }> {
    return Array.from(this.topicToneMap.entries())
      .filter(([_, entry]) => entry.confidence >= MIN_CONFIDENCE)
      .map(([topic, entry]) => ({
        topic,
        params: { ...entry.params },
        confidence: entry.confidence,
      }))
      .sort((a, b) => b.confidence - a.confidence)
  }

  /** 重置 */
  reset(): void {
    this.topicToneMap.clear()
    log('INFO', 'topic_tone_matcher_reset')
  }
}

/** 模块级单例 */
export const topicToneMatcher = new TopicToneMatcher()
