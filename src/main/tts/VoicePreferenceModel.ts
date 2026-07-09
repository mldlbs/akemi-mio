/**
 * VoicePreferenceModel — 隐式反馈驱动的语音偏好学习模型
 *
 * 职责：
 *   1. 维护 TTS 输出历史记录和对应的用户隐式反馈（重听/跳过/打断等）
 *   2. 每 N 次输出运行加权平均分析，学习用户偏好的 voice/rate/pitch 组合
 *   3. 返回参数推荐，供 TtsService 渐进式调整
 *
 * 设计原则：
 *   - 轻量级：纯数值运算，不依赖外部 ML 库
 *   - 冷启动友好：样本不足时返回默认值
 *   - 渐进调整：推荐变化幅度受 blendWeight 限制，避免突变
 *   - 可回退：启用 fallback 机制，当推荐置信度不足时使用默认值
 */

import { log } from '../logger/Logger'
import type {
  EmotionTtsParams,
  TtsOutputRecord,
  ImplicitFeedbackAction,
  PreferenceRecommendation,
  ImplicitFeedbackConfig,
} from './types'
import {
  DEFAULT_IMPLICIT_FEEDBACK_CONFIG,
  IMPLICIT_FEEDBACK_WEIGHTS,
} from './types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 默认情感 TTS 参数（冷启动/回退） */
const DEFAULT_PARAMS: EmotionTtsParams = {
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+10%',
  pitch: '+8Hz',
  label: '隐式学习·默认',
}

/** 解析率数值 "+15%" → 15, "-5%" → -5 */
function parseRate(rate: string): number {
  return parseInt(rate.replace(/[^0-9-]/g, '')) || 0
}

/** 解析音调数值 "+8Hz" → 8, "-3Hz" → -3 */
function parsePitch(pitch: string): number {
  return parseInt(pitch.replace(/[^0-9-]/g, '')) || 0
}

/** 率数值 → 分类标签 */
function classifyRate(val: number): 'slow' | 'normal' | 'fast' {
  if (val < 0) return 'slow'
  if (val > 12) return 'fast'
  return 'normal'
}

/** 音调数值 → 分类标签 */
function classifyPitch(val: number): 'low' | 'normal' | 'high' {
  if (val < 0) return 'low'
  if (val > 8) return 'high'
  return 'normal'
}

// ══════════════════════════════════════════
//  VoicePreferenceModel
// ══════════════════════════════════════════

export class VoicePreferenceModel {
  /** TTS 输出历史记录 */
  private history: TtsOutputRecord[] = []

  /** 当前配置 */
  private config: ImplicitFeedbackConfig

  /** 上次推荐的参数（用于防止突变） */
  private lastRecommendedParams: EmotionTtsParams | null = null

  /** 自上次模型更新以来的新输出计数 */
  private pendingUpdateCount = 0

  /** 模型是否已初始化（有足够样本） */
  private initialized = false

  /** 当前推荐结果缓存 */
  private currentRecommendation: PreferenceRecommendation | null = null

  /** 累计样本数（包含已清理的历史） */
  private totalSamples = 0

  constructor(config?: Partial<ImplicitFeedbackConfig>) {
    this.config = { ...DEFAULT_IMPLICIT_FEEDBACK_CONFIG, ...config }
  }

  // ── 数据采集 ──

  /**
   * 记录一次 TTS 输出。
   * 在 TTS 开始播放时调用，记录使用的参数。
   * @returns outputId 供后续关联反馈动作
   */
  recordOutput(params: EmotionTtsParams, textSnippet: string): string {
    const outputId = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const record: TtsOutputRecord = {
      outputId,
      timestamp: Date.now(),
      params: { ...params },
      textSnippet: textSnippet.slice(0, 100),
      actions: [],
      cumulativeScore: 0,
    }
    this.history.push(record)
    this.totalSamples++
    this.pendingUpdateCount++

    // 限制历史大小
    if (this.history.length > this.config.maxHistorySize) {
      this.history = this.history.slice(-this.config.maxHistorySize)
    }

    // 达到更新间隔时触发模型重新计算
    if (this.pendingUpdateCount >= this.config.updateInterval) {
      this.updateModel()
    }

    return outputId
  }

  /**
   * 记录用户对某次 TTS 输出的隐式反馈动作。
   * @param outputId recordOutput 返回的 ID
   * @param action 用户行为类型
   */
  recordAction(outputId: string, action: ImplicitFeedbackAction): void {
    const record = this.history.find((r) => r.outputId === outputId)
    if (!record) {
      log('WARN', 'implicit_feedback_record_not_found', { outputId, action })
      return
    }

    record.actions.push({ action, timestamp: Date.now() })

    // 更新累计分数
    const weight = IMPLICIT_FEEDBACK_WEIGHTS[action]
    record.cumulativeScore += weight

    log('INFO', 'implicit_feedback_recorded', {
      outputId: outputId.slice(-8),
      action,
      weight,
      cumulativeScore: record.cumulativeScore.toFixed(1),
      params: record.params.label,
    })

    // 每次有反馈时也递增更新计数（加速学习）
    this.pendingUpdateCount++
    if (this.pendingUpdateCount >= this.config.updateInterval) {
      this.updateModel()
    }
  }

  /**
   * 针对最近一次 TTS 输出记录反馈动作（便捷方法）。
   */
  recordActionForLatest(action: ImplicitFeedbackAction): void {
    if (this.history.length === 0) return
    const latest = this.history[this.history.length - 1]
    this.recordAction(latest.outputId, action)
  }

  // ── 模型更新 ──

  /**
   * 执行加权平均分析，更新参数推荐。
   *
   * 算法：
   * 1. 按 voice 分组，计算各 voice 的平均隐式分数
   * 2. 按 rate 范围（慢/适中/快）分组，计算平均分数
   * 3. 按 pitch 范围（低/适中/高）分组，计算平均分数
   * 4. 选择最高分的 voice + rate + pitch 组合
   * 5. 与上次推荐混合（平滑过渡）
   */
  updateModel(): void {
    this.pendingUpdateCount = 0

    // 收集所有有反馈记录的输出
    const scored = this.history.filter(
      (r) => r.actions.length > 0 || r.cumulativeScore !== 0,
    )
    if (scored.length < this.config.minSamplesForRecommendation) {
      if (this.initialized) {
        // 已经初始化但新数据不足：维持当前推荐但降低置信度
        this.currentRecommendation = this.currentRecommendation
          ? { ...this.currentRecommendation, confidence: Math.max(0.1, this.currentRecommendation.confidence - 0.05) }
          : null
      }
      return
    }

    // ── 按 voice 分组评分 ──
    const voiceScores: Record<string, { total: number; count: number }> = {}
    for (const r of scored) {
      const voice = r.params.voice
      if (!voiceScores[voice]) voiceScores[voice] = { total: 0, count: 0 }
      voiceScores[voice].total += r.cumulativeScore
      voiceScores[voice].count++
    }

    // 选择平均分最高的 voice
    let bestVoice = DEFAULT_PARAMS.voice
    let bestVoiceScore = -Infinity
    for (const [voice, { total, count }] of Object.entries(voiceScores)) {
      const avg = total / count
      if (avg > bestVoiceScore) {
        bestVoiceScore = avg
        bestVoice = voice
      }
    }

    // ── 按 rate 范围分组评分 ──
    const rateScores: Record<string, { total: number; count: number }> = {
      slow: { total: 0, count: 0 },
      normal: { total: 0, count: 0 },
      fast: { total: 0, count: 0 },
    }
    for (const r of scored) {
      const category = classifyRate(parseRate(r.params.rate))
      rateScores[category].total += r.cumulativeScore
      rateScores[category].count++
    }

    // 选择平均分最高的 rate 范围
    const rateCategory = this.pickBestCategory(
      rateScores,
      classifyRate(parseRate(DEFAULT_PARAMS.rate)),
    )

    // ── 按 pitch 范围分组评分 ──
    const pitchScores: Record<string, { total: number; count: number }> = {
      low: { total: 0, count: 0 },
      normal: { total: 0, count: 0 },
      high: { total: 0, count: 0 },
    }
    for (const r of scored) {
      const category = classifyPitch(parsePitch(r.params.pitch))
      pitchScores[category].total += r.cumulativeScore
      pitchScores[category].count++
    }

    // 选择平均分最高的 pitch 范围
    const pitchCategory = this.pickBestCategory(
      pitchScores,
      classifyPitch(parsePitch(DEFAULT_PARAMS.pitch)),
    )

    // ── 生成推荐参数 ──
    const recommendedRate = this.categoryToRateValue(rateCategory)
    const recommendedPitch = this.categoryToPitchValue(pitchCategory)
    const hasSufficientData = scored.length >= 10

    // 平滑过渡：与上次推荐混合
    let finalRate = recommendedRate
    let finalPitch = recommendedPitch

    if (this.lastRecommendedParams) {
      const lastRate = parseRate(this.lastRecommendedParams.rate)
      const lastPitch = parsePitch(this.lastRecommendedParams.pitch)

      // 限制单次变化幅度（最大 5% / 5Hz）
      finalRate = this.lerpWithLimit(lastRate, recommendedRate, this.config.blendWeight, 5)
      finalPitch = this.lerpWithLimit(lastPitch, recommendedPitch, this.config.blendWeight, 5)
    }

    // 使用最佳 voice，如果该 voice 样本不足则回退
    const bestVoiceData = voiceScores[bestVoice]
    const useVoice = bestVoiceData && bestVoiceData.count >= 2 ? bestVoice : DEFAULT_PARAMS.voice

    const recommended: EmotionTtsParams = {
      voice: useVoice,
      rate: `${finalRate >= 0 ? '+' : ''}${finalRate}%`,
      pitch: `${finalPitch >= 0 ? '+' : ''}${finalPitch}Hz`,
      label: `隐式学习·${this.classifyRateLabel(finalRate)}`,
    }

    // 置信度：基于样本量和对数衰减
    const confidence = Math.min(0.8, Math.log10(scored.length + 1) / 3 + 0.3)

    const reason = this.buildRecommendationReason(
      scored.length,
      bestVoice,
      rateCategory,
      pitchCategory,
      hasSufficientData,
    )

    this.currentRecommendation = {
      params: recommended,
      confidence: Math.round(confidence * 100) / 100,
      totalSamples: this.totalSamples,
      reason,
    }
    this.lastRecommendedParams = recommended
    this.initialized = true

    log('INFO', 'voice_preference_model_updated', {
      voice: recommended.voice,
      rate: recommended.rate,
      pitch: recommended.pitch,
      confidence: confidence.toFixed(2),
      samples: scored.length,
      totalSamples: this.totalSamples,
      reason,
    })
  }

  // ── 查询接口 ──

  /**
   * 获取当前参数推荐。
   * 如果模型尚未初始化或数据不足，返回默认值推荐。
   */
  getRecommendation(): PreferenceRecommendation {
    if (!this.initialized || !this.currentRecommendation) {
      return {
        params: { ...DEFAULT_PARAMS },
        confidence: 0,
        totalSamples: this.totalSamples,
        reason: '样本不足，使用默认参数',
      }
    }
    return this.currentRecommendation
  }

  /** 是否已初始化（有足够数据产生推荐） */
  isInitialized(): boolean {
    return this.initialized
  }

  /** 获取历史记录数 */
  getHistorySize(): number {
    return this.history.length
  }

  /** 获取完整历史记录（供实验钩子 A/B 分析使用） */
  getHistory(): TtsOutputRecord[] {
    return [...this.history]
  }

  /** 获取总样本数 */
  getTotalSamples(): number {
    return this.totalSamples
  }

  /** 获取当前配置 */
  getConfig(): ImplicitFeedbackConfig {
    return { ...this.config }
  }

  /** 更新配置 */
  updateConfig(partial: Partial<ImplicitFeedbackConfig>): void {
    this.config = { ...this.config, ...partial }
    log('INFO', 'voice_preference_model_config_updated', { ...this.config })
  }

  /** 重置所有数据 */
  reset(): void {
    this.history = []
    this.lastRecommendedParams = null
    this.pendingUpdateCount = 0
    this.initialized = false
    this.currentRecommendation = null
    this.totalSamples = 0
    log('INFO', 'voice_preference_model_reset')
  }

  // ── 私有方法 ──

  /**
   * 从评分对象中选择最佳类别。
   * 如果某个类别无样本或分数相同，回退到默认类别。
   */
  private pickBestCategory(
    scores: Record<string, { total: number; count: number }>,
    defaultCategory: string,
  ): string {
    let best = defaultCategory
    let bestAvg = -Infinity

    for (const [cat, { total, count }] of Object.entries(scores)) {
      if (count === 0) continue
      const avg = total / count
      if (avg > bestAvg) {
        bestAvg = avg
        best = cat
      }
    }

    // 如果最佳类别的平均分也是负的，回退到默认
    if (bestAvg < 0) {
      return defaultCategory
    }

    return best
  }

  /** 类别 → 数值（rate 范围的中点值） */
  private categoryToRateValue(category: string): number {
    switch (category) {
      case 'slow': return -5
      case 'fast': return 18
      default: return 8
    }
  }

  /** 类别 → 数值（pitch 范围的中点值） */
  private categoryToPitchValue(category: string): number {
    switch (category) {
      case 'low': return -3
      case 'high': return 12
      default: return 5
    }
  }

  /**
   * 带限制的线性插值：从 current 向 target 移动 blendRatio 比例，
   * 但单步变化不超过 maxDelta。
   */
  private lerpWithLimit(
    current: number,
    target: number,
    blendRatio: number,
    maxDelta: number,
  ): number {
    const delta = (target - current) * blendRatio
    const clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, delta))
    return Math.round(current + clampedDelta)
  }

  /** 根据率值生成可读的速率标签 */
  private classifyRateLabel(val: number): string {
    if (val < -3) return '舒缓'
    if (val > 15) return '明快'
    if (val > 8) return '轻快'
    return '适中'
  }

  /** 生成推荐理由文本 */
  private buildRecommendationReason(
    sampleCount: number,
    voice: string,
    rateCategory: string,
    pitchCategory: string,
    sufficient: boolean,
  ): string {
    const voiceName = voice.replace('zh-CN-', '').replace('Neural', '')
    const rateLabel = { slow: '舒缓语速', normal: '适中语速', fast: '明快语速' }[rateCategory] || rateCategory
    const pitchLabel = { low: '低音调', normal: '适中音调', high: '高音调' }[pitchCategory] || pitchCategory

    if (!sufficient) {
      return `初步学习: ${voiceName} + ${rateLabel} + ${pitchLabel} (样本${sampleCount}条)`
    }
    return `隐式偏好: ${voiceName} + ${rateLabel} + ${pitchLabel} (${sampleCount}条反馈)`
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 TtsService 和 ChatExecutor 共享 */
export const voicePreferenceModel = new VoicePreferenceModel()
