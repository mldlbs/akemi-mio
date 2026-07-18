/**
 * PreferenceEnhancer — 记忆朗读个性化增强模块
 *
 * 在 TTS 调用链中插入偏好增强，综合以下维度提升语音输出体验：
 *
 * 1. 发音字典（PronunciationDictionary）
 *    对用户曾纠错的单词，自动使用修正后的发音
 *
 * 2. 话题语调匹配（TopicToneMatcher）
 *    针对相同话题，自动匹配记忆中设定的语调（voice/rate/pitch）
 *
 * 3. 会话问候（SessionGreeting）
 *    新会话开始时生成问候语，提及上次聊天的关键点
 *
 * 设计目标：
 * - 一次注入，多处受益：TtsService 和 ChatExecutor 只需调用本模块
 * - 故障隔离：所有方法 catch 内部异常，不传播到调用方
 * - 轻量内存缓存：避免每次查询 MemoryService，减少性能开销
 *
 * 接入方式：
 *   preferenceEnhancer.setMemoryService(memoryService)
 *   preferenceEnhancer.loadFromMemory()
 *
 * 使用方式：
 *   // 增强 TTS 文本（应用发音修正）
 *   const enhanced = preferenceEnhancer.enhanceText(rawText)
 *
 *   // 增强 TTS 参数（匹配话题语调）
 *   const params = preferenceEnhancer.enhanceParams(topics, baseParams)
 *
 *   // 获取会话问候
 *   const greeting = preferenceEnhancer.getSessionGreeting()
 */

import { log } from '../logger/Logger'
import type { MemoryService } from '../memory/MemoryService'
import type { EmotionTtsParams, EnhancementResult } from './types'
import { pronunciationDictionary } from './PronunciationDictionary'
import { topicToneMatcher } from './TopicToneMatcher'
import { sessionGreeting } from './SessionGreeting'
/** 话题语调混合权重（匹配到的历史参数占最终参数的权重） */
const TOPIC_TONE_BLEND_WEIGHT = 0.75

/** 话题语调默认标签前缀 */
const TOPIC_TONE_LABEL_PREFIX = '忆·话题'

// ═══════════════════════════════════════════════
//  PreferenceEnhancer
// ═══════════════════════════════════════════════

export class PreferenceEnhancer {
  /** 当前会话的话题缓存（由外部 setCurrentTopics 更新） */
  private currentTopics: string[] = []

  /** 外部传入的预测话题（来自 TopicTransitionPredictor） */
  private predictedTopics: string[] = []

  constructor() {
    log('INFO', 'preference_enhancer_created')
  }

  // ════════════════════════════════════════════
  //  DI / 初始化
  // ════════════════════════════════════════════

  /**
   * 注入 MemoryService 引用并传播到子模块。
   * 由 AppRuntime 在服务初始化阶段调用。
   */
  setMemoryService(ms: MemoryService): void {
    pronunciationDictionary.setMemoryService(ms)
    topicToneMatcher.setMemoryService(ms)
    sessionGreeting.setMemoryService(ms)
    log('INFO', 'preference_enhancer_memory_attached')
  }

  /** 从 Memory 重新加载所有子模块的数据 */
  loadFromMemory(): void {
    pronunciationDictionary.loadFromMemory()
    topicToneMatcher.loadFromMemory()
    log('INFO', 'preference_enhancer_loaded')
  }

  /**
   * 设置当前会话的话题列表。
   * 由 ChatExecutor 在每轮交互后更新。
   */
  setCurrentTopics(topics: string[]): void {
    this.currentTopics = [...topics]
  }

  /**
   * 设置预测的下一个话题（来自 TopicTransitionPredictor）。
   */
  setPredictedTopics(topics: string[]): void {
    this.predictedTopics = [...topics]
  }

  // ════════════════════════════════════════════
  //  发音字典
  // ════════════════════════════════════════════

  /**
   * 对 TTS 输入文本应用发音修正。
   *
   * @param text 原始文本
   * @returns 修正后的文本
   */
  enhanceText(text: string): string {
    if (!text) return text
    try {
      return pronunciationDictionary.applyToText(text)
    } catch (err) {
      log('WARN', 'preference_enhancer_text_failed', { error: String(err) })
      return text
    }
  }

  // ════════════════════════════════════════════
  //  话题语调匹配
  // ════════════════════════════════════════════

  /**
   * 根据当前话题匹配历史语调参数。
   *
   * 当有匹配时，将匹配到的参数与基础参数混合：
   * - voice: 使用历史记录的 voice（话题相关的音色设定）
   * - rate/pitch: 按 TOPIC_TONE_BLEND_WEIGHT 混合
   *
   * @param baseParams 当前基础 TTS 参数（来自内容/情感分析链）
   * @param topics 可选的话题列表（不传则使用缓存的 currentTopics）
   * @returns 匹配后的 TTS 参数
   */
  enhanceParams(baseParams: EmotionTtsParams, topics?: string[]): EmotionTtsParams {
    const useTopics = topics ?? this.currentTopics
    if (!useTopics || useTopics.length === 0) return baseParams

    try {
      const match = topicToneMatcher.getToneForTopicsWithPrediction(useTopics, this.predictedTopics)
      if (!match) return baseParams

      // 混合参数：优先使用历史 voice，rate/pitch 加权混合
      const currentRate = parseInt(baseParams.rate.replace(/[^0-9-]/g, '')) || 0
      const currentPitch = parseInt(baseParams.pitch.replace(/[^0-9-]/g, '')) || 0
      const matchedRate = parseInt(match.params.rate.replace(/[^0-9-]/g, '')) || 0
      const matchedPitch = parseInt(match.params.pitch.replace(/[^0-9-]/g, '')) || 0

      const blendedRate = Math.round(
        currentRate * (1 - TOPIC_TONE_BLEND_WEIGHT) + matchedRate * TOPIC_TONE_BLEND_WEIGHT,
      )
      const blendedPitch = Math.round(
        currentPitch * (1 - TOPIC_TONE_BLEND_WEIGHT) + matchedPitch * TOPIC_TONE_BLEND_WEIGHT,
      )

      // 夹到安全范围
      const clampedRate = Math.max(-50, Math.min(50, blendedRate))
      const clampedPitch = Math.max(-20, Math.min(20, blendedPitch))

      const enhanced: EmotionTtsParams = {
        // voice 优先使用历史记录的音色（话题相关的个性化音色）
        voice: match.params.voice || baseParams.voice,
        rate: `${clampedRate >= 0 ? '+' : ''}${clampedRate}%`,
        pitch: `${clampedPitch >= 0 ? '+' : ''}${clampedPitch}Hz`,
        label: `${TOPIC_TONE_LABEL_PREFIX}·${match.matchedTopic}`,
      }

      log('INFO', 'preference_enhancer_params_applied', {
        topic: match.matchedTopic,
        voice: enhanced.voice,
        rate: enhanced.rate,
        pitch: enhanced.pitch,
        confidence: match.confidence,
      })

      return enhanced
    } catch (err) {
      log('WARN', 'preference_enhancer_params_failed', { error: String(err) })
      return baseParams
    }
  }

  // ════════════════════════════════════════════
  //  会话问候
  // ════════════════════════════════════════════

  /**
   * 获取会话开场问候语。
   * 仅在第一次调用时生成，之后返回 null。
   *
   * @returns 问候文本，或 null
   */
  getSessionGreeting(): string | null {
    try {
      const result = sessionGreeting.generateAndMark()
      if (result) {
        return result.greeting
      }
      return null
    } catch (err) {
      log('WARN', 'preference_enhancer_greeting_failed', { error: String(err) })
      return null
    }
  }

  /** 重置会话问候状态 */
  resetGreetingState(): void {
    sessionGreeting.resetSession()
  }

  // ════════════════════════════════════════════
  //  记录接口
  // ════════════════════════════════════════════

  /**
   * 记录用户的发音纠正。
   *
   * @param word 原始词
   * @param corrected 修正后发音
   * @param confidence 置信度
   */
  recordCorrection(word: string, corrected: string, confidence = 0.7): void {
    pronunciationDictionary.addCorrection(word, corrected, confidence)
  }

  /**
   * 记录当前 TTS 参数与话题的关联。
   * 应在每次 TTS 合成后调用，以建立话题-语调映射。
   *
   * @param topics 当前话题
   * @param params 使用的 TTS 参数
   * @param confidence 置信度（基于用户交互反馈等）
   */
  recordTopicTone(topics: string[], params: EmotionTtsParams, confidence = 0.6): void {
    if (!topics || topics.length === 0) return

    try {
      for (const topic of topics) {
        topicToneMatcher.recordToneForTopic(topic, params, confidence)
      }
    } catch (err) {
      log('WARN', 'preference_enhancer_record_topic_tone_failed', { error: String(err) })
    }
  }

  // ════════════════════════════════════════════
  //  一键增强
  // ════════════════════════════════════════════

  /**
   * 综合增强：对文本应用发音修正 + 对参数应用话题语调匹配。
   *
   * 这是 TTS 调用链中的主要入口点，替代分步调用。
   *
   * @param text 原始 TTS 文本
   * @param baseParams 基础 TTS 参数
   * @param topics 当前话题列表（可选）
   * @returns 增强结果
   */
  enhance(text: string, baseParams: EmotionTtsParams, topics?: string[]): EnhancementResult {
    const useTopics = topics ?? this.currentTopics

    // 1. 发音修正
    const enhancedText = this.enhanceText(text)
    const correctionsApplied = enhancedText !== text

    // 2. 话题语调匹配
    const enhancedParams = this.enhanceParams(baseParams, useTopics)
    const topicToneMatched =
      enhancedParams.label.startsWith(TOPIC_TONE_LABEL_PREFIX) ||
      enhancedParams.label !== baseParams.label

    // 构建描述
    const descParts: string[] = []
    if (correctionsApplied) descParts.push('发音修正')
    if (topicToneMatched) descParts.push('话题语调')
    const description = descParts.length > 0 ? descParts.join('+') : '无增强'

    return {
      text: enhancedText,
      params: enhancedParams,
      topics: useTopics,
      correctionsApplied,
      topicToneMatched,
      description,
    }
  }
}

/** 模块级单例 */
export const preferenceEnhancer = new PreferenceEnhancer()
