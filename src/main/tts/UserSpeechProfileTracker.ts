/**
 * UserSpeechProfileTracker — 用户语音输入特征跟踪器
 *
 * ── 角色 ──
 * 记录用户每次语音交互的输入特征（语音时长、文字长度），
 * 计算用户平均语速（字/秒），结合声学特征（基频、能量），
 * 为 TTS 自适应提供推荐。
 *
 * ── 数据流 ──
 * ASR 转写完成 → recordInteraction(text, audioDurationMs, voiceEmotion?) → 滑动窗口
 *                                                                    ↓
 * TTS 合成前 ← getRecommendation() ← 计算最近 N 次交互的语速均值
 *              rateAdjustment 通过 UserBehaviorTtsContract 流入 PiperBehaviorSidecar
 * TTS 合成前 ← getAcousticRecommendation() ← 计算最近 N 次交互的声学画像
 *              pitchAdjustment 通过 UserBehaviorTtsContract 流入 PiperBehaviorSidecar
 *
 * ── 设计原则 ──
 * 1. 轻量无锁 — 单线程记录，不涉及异步操作
 * 2. 滑动窗口 — 仅保留最近 N 次交互，不持久化（随服务生命周期重置）
 * 3. 零侵入 — 不依赖任何 TTS/Behavior 模块，纯数据收集 + 计算
 * 4. 容错 — 短文本/短音频/空数据时优雅降级，无声学数据时回退到语速推荐
 */

import { log } from '../logger/Logger'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 单次语音交互记录 */
export interface SpeechInteraction {
  /** 交互时间戳 */
  timestamp: number
  /** ASR 识别文本 */
  text: string
  /** 文本字符数（不含首尾空白） */
  charCount: number
  /** 语音输入时长（毫秒） */
  audioDurationMs: number
  /** 语速（字符/秒） */
  speechRate: number
}

/** 声学特征记录（来自 ASR VoiceEmotion） */
export interface AcousticFeatureRecord {
  /** 交互时间戳 */
  timestamp: number
  /** 平均能量 0–1 */
  energy: number
  /** 平均基频 (Hz) */
  pitchHz: number
  /** 语速（声学帧/秒，与 chars/sec 互补） */
  speechRate: number
  /** 无声段比例 0–1 */
  silenceRatio: number
}

/** 语速倾向分类 */
export type SpeechPaceCategory = 'very_slow' | 'slow' | 'normal' | 'fast' | 'very_fast'

/** 基频倾向分类 */
export type PitchCategory = 'very_low' | 'low' | 'normal' | 'high' | 'very_high'

/** 能量倾向分类 */
export type EnergyCategory = 'very_low' | 'low' | 'normal' | 'high' | 'very_high'

/** 语音画像推荐 */
export interface SpeechProfileRecommendation {
  /** 语速调整百分比（负值=减速，正值=加速，范围 -30 ~ +30，0=不调整） */
  rateAdjustment: number
  /** 当前语速倾向类别 */
  paceCategory: SpeechPaceCategory
  /** 平均语速（字符/秒） */
  averageSpeechRate: number
  /** 用于计算的有效样本数 */
  sampleCount: number
  /** 推荐的人类可读描述 */
  reason: string
}

/** 声学画像推荐（语速 + 音调组合） */
export interface AcousticProfileRecommendation extends SpeechProfileRecommendation {
  /** 音调调整百分比（负值=降调，正值=升调，范围 -20 ~ +20，0=不调整） */
  pitchAdjustment: number
  /** 当前基频倾向类别 */
  pitchCategory: PitchCategory
  /** 当前能量倾向类别 */
  energyCategory: EnergyCategory
  /** 平均基频 (Hz) */
  averagePitchHz: number
  /** 平均能量 0–1 */
  averageEnergy: number
  /** 用于计算声学特征的有效样本数 */
  acousticSampleCount: number
}

/** 静默推荐（样本不足时的回退值） */
const SILENT_RECOMMENDATION: SpeechProfileRecommendation = {
  rateAdjustment: 0,
  paceCategory: 'normal',
  averageSpeechRate: 0,
  sampleCount: 0,
  reason: '样本不足（需至少 2 次语音交互）',
}

/** 静默声学推荐（样本不足时的回退值） */
const SILENT_ACOUSTIC_RECOMMENDATION: AcousticProfileRecommendation = {
  ...SILENT_RECOMMENDATION,
  pitchAdjustment: 0,
  pitchCategory: 'normal',
  energyCategory: 'normal',
  averagePitchHz: 0,
  averageEnergy: 0,
  acousticSampleCount: 0,
  reason: '声学样本不足（需至少 2 次声学特征记录）',
}

// ══════════════════════════════════════════
//  UserSpeechProfileTracker
// ══════════════════════════════════════════

export class UserSpeechProfileTracker {
  /** 滑动窗口中的交互记录 */
  private readonly interactions: SpeechInteraction[] = []

  /** 滑动窗口中的声学特征记录 */
  private readonly acousticFeatures: AcousticFeatureRecord[] = []

  /** 滑动窗口大小（保留最近多少次交互） */
  private readonly windowSize: number

  /** 用于语速自适应计算的有效窗口（取最近多少次计算均值） */
  private readonly recentWindow: number

  /** 最小文本长度（过滤噪声/幻觉） */
  private readonly minTextLength: number

  /** 最小音频时长（毫秒，过滤点击声等短促噪音） */
  private readonly minAudioDurationMs: number

  // ── 语速阈值（字符/秒，中文普通话参考值）──
  //
  // 参考：中文普通话日常交流语速约 3-5 字/秒
  // - very_slow:  < 2.0   → 用户说话很慢，偏好慢速 TTS
  // - slow:       2.0~3.0 → 用户偏慢
  // - normal:     3.0~5.0 → 正常语速
  // - fast:       5.0~7.0 → 用户偏快
  // - very_fast:  > 7.0   → 用户说话很快，偏好快速 TTS
  private static readonly RATE_THRESHOLDS = {
    verySlow: 2.0,
    slow: 3.0,
    fast: 5.0,
    veryFast: 7.0,
  } as const

  // ── 基频阈值（Hz，中文普通话参考值）──
  //
  // 参考：中文普通话基频范围约 80–400 Hz
  // - very_low:  < 100 Hz  → 很低沉
  // - low:        100–150  → 偏低
  // - normal:     150–250  → 正常范围
  // - high:       250–350  → 偏高
  // - very_high:  > 350    → 很高
  private static readonly PITCH_THRESHOLDS = {
    veryLow: 100,
    low: 150,
    high: 250,
    veryHigh: 350,
  } as const

  // ── 能量阈值（0–1 归一化）──
  //
  // - very_low:  < 0.2 → 很轻
  // - low:        0.2–0.4 → 偏轻
  // - normal:     0.4–0.6 → 正常
  // - high:       0.6–0.8 → 偏高
  // - very_high:  > 0.8 → 很高
  private static readonly ENERGY_THRESHOLDS = {
    veryLow: 0.2,
    low: 0.4,
    high: 0.6,
    veryHigh: 0.8,
  } as const

  constructor(options?: {
    windowSize?: number
    recentWindow?: number
    minTextLength?: number
    minAudioDurationMs?: number
  }) {
    this.windowSize = options?.windowSize ?? 20
    this.recentWindow = options?.recentWindow ?? 4
    this.minTextLength = options?.minTextLength ?? 2
    this.minAudioDurationMs = options?.minAudioDurationMs ?? 500
  }

  // ══════════════════════════════════════════
  //  记录接口
  // ══════════════════════════════════════════

  /**
   * 记录一次语音交互。
   *
   * @param text           ASR 识别出的文本
   * @param audioDurationMs 语音输入时长（毫秒）
   * @param acousticFeatures 可选声学特征（来自 ASR VoiceEmotion）
   *
   * 自动过滤：
   * - 空文本或纯空白
   * - 文本长度 < minTextLength（过滤噪声/单字幻觉）
   * - 音频时长 < minAudioDurationMs（过滤点击声/误触）
   */
  recordInteraction(
    text: string,
    audioDurationMs: number,
    acousticFeatures?: { energy: number; pitchHz: number; speechRate: number; silenceRatio: number },
  ): void {
    // ── 输入校验 ──
    const trimmed = text?.trim() ?? ''
    if (!trimmed) {
      log('DEBUG', 'speech_profile_skip_empty', { reason: '空文本' })
      return
    }
    if (trimmed.length < this.minTextLength) {
      log('DEBUG', 'speech_profile_skip_short', {
        text: trimmed,
        reason: `文本过短 (${trimmed.length} < ${this.minTextLength})`,
      })
      return
    }
    if (audioDurationMs < this.minAudioDurationMs) {
      log('DEBUG', 'speech_profile_skip_short_audio', {
        durationMs: audioDurationMs,
        reason: `音频过短 (${audioDurationMs}ms < ${this.minAudioDurationMs}ms)`,
      })
      return
    }

    // ── 计算语速 ──
    const durationSec = audioDurationMs / 1000
    const speechRate = trimmed.length / durationSec

    const interaction: SpeechInteraction = {
      timestamp: Date.now(),
      text: trimmed,
      charCount: trimmed.length,
      audioDurationMs,
      speechRate,
    }

    // ── 滑动窗口维护 ──
    this.interactions.push(interaction)
    if (this.interactions.length > this.windowSize) {
      this.interactions.shift()
    }

    log('DEBUG', 'speech_profile_interaction_recorded', {
      charCount: trimmed.length,
      durationMs: audioDurationMs,
      speechRate: speechRate.toFixed(2),
      windowSize: this.interactions.length,
    })

    // ── 声学特征记录 ──
    if (acousticFeatures) {
      this.recordAcousticFeatures(acousticFeatures)
    }
  }

  /**
   * 记录声学特征（可从 recordInteraction 自动调用，也可单独调用）。
   *
   * @param features 声学特征值
   */
  recordAcousticFeatures(features: { energy: number; pitchHz: number; speechRate: number; silenceRatio: number }): void {
    const record: AcousticFeatureRecord = {
      timestamp: Date.now(),
      energy: features.energy,
      pitchHz: features.pitchHz,
      speechRate: features.speechRate,
      silenceRatio: features.silenceRatio,
    }

    this.acousticFeatures.push(record)
    if (this.acousticFeatures.length > this.windowSize) {
      this.acousticFeatures.shift()
    }

    log('DEBUG', 'speech_profile_acoustic_recorded', {
      pitchHz: features.pitchHz.toFixed(1),
      energy: features.energy.toFixed(3),
      speechRate: features.speechRate.toFixed(2),
      silenceRatio: features.silenceRatio.toFixed(3),
      windowSize: this.acousticFeatures.length,
    })
  }

  // ══════════════════════════════════════════
  //  查询接口
  // ══════════════════════════════════════════

  /**
   * 获取最近 N 次有效交互的列表（按时间升序）。
   * 返回副本，避免外部修改内部状态。
   */
  getRecentInteractions(n: number = this.recentWindow): SpeechInteraction[] {
    return this.interactions.slice(-n)
  }

  /**
   * 获取全部交互记录的只读视图。
   */
  getAllInteractions(): readonly SpeechInteraction[] {
    return Object.freeze([...this.interactions])
  }

  /**
   * 获取最近 N 次声学特征记录的只读视图。
   */
  getRecentAcousticFeatures(n: number = this.recentWindow): AcousticFeatureRecord[] {
    return this.acousticFeatures.slice(-n)
  }

  /**
   * 获取全部声学特征记录的只读视图。
   */
  getAllAcousticFeatures(): readonly AcousticFeatureRecord[] {
    return Object.freeze([...this.acousticFeatures])
  }

  /**
   * 获取最近 N 次交互的平均语速（字符/秒）。
   * 样本不足 2 次时返回 0。
   */
  getAverageSpeechRate(n: number = this.recentWindow): number {
    const recent = this.getRecentInteractions(n)
    if (recent.length < 2) return 0
    const sum = recent.reduce((acc, i) => acc + i.speechRate, 0)
    return sum / recent.length
  }

  /**
   * 根据当前语速对语音性格进行分类。
   */
  classifyPace(averageRate: number): SpeechPaceCategory {
    if (averageRate <= 0) return 'normal'
    if (averageRate < UserSpeechProfileTracker.RATE_THRESHOLDS.verySlow) return 'very_slow'
    if (averageRate < UserSpeechProfileTracker.RATE_THRESHOLDS.slow) return 'slow'
    if (averageRate < UserSpeechProfileTracker.RATE_THRESHOLDS.fast) return 'normal'
    if (averageRate < UserSpeechProfileTracker.RATE_THRESHOLDS.veryFast) return 'fast'
    return 'very_fast'
  }

  /**
   * 根据平均基频对音调进行分类。
   */
  classifyPitch(averagePitchHz: number): PitchCategory {
    if (averagePitchHz <= 0) return 'normal'
    if (averagePitchHz < UserSpeechProfileTracker.PITCH_THRESHOLDS.veryLow) return 'very_low'
    if (averagePitchHz < UserSpeechProfileTracker.PITCH_THRESHOLDS.low) return 'low'
    if (averagePitchHz < UserSpeechProfileTracker.PITCH_THRESHOLDS.high) return 'normal'
    if (averagePitchHz < UserSpeechProfileTracker.PITCH_THRESHOLDS.veryHigh) return 'high'
    return 'very_high'
  }

  /**
   * 根据平均能量进行分类。
   */
  classifyEnergy(averageEnergy: number): EnergyCategory {
    if (averageEnergy <= 0) return 'normal'
    if (averageEnergy < UserSpeechProfileTracker.ENERGY_THRESHOLDS.veryLow) return 'very_low'
    if (averageEnergy < UserSpeechProfileTracker.ENERGY_THRESHOLDS.low) return 'low'
    if (averageEnergy < UserSpeechProfileTracker.ENERGY_THRESHOLDS.high) return 'normal'
    if (averageEnergy < UserSpeechProfileTracker.ENERGY_THRESHOLDS.veryHigh) return 'high'
    return 'very_high'
  }

  // ══════════════════════════════════════════
  //  推荐接口
  // ══════════════════════════════════════════

  /**
   * 获取当前语音特征对 TTS 的自适应推荐（仅语速）。
   *
   * 基于用户的语速特征（字符/秒），映射到 TTS 语速调整百分比。
   * 核心逻辑：用户说得快 → TTS 稍快；用户说得慢 → TTS 稍慢。
   * 这是最基本的"语速镜像"策略，符合交流适应理论（Communication Accommodation Theory）。
   *
   * 调整幅度限制在 ±20% 以内，防止语音失真。
   *
   * @param n 用于计算的最近交互次数（默认 4 次）
   * @returns SpeechProfileRecommendation
   */
  getRecommendation(n: number = this.recentWindow): SpeechProfileRecommendation {
    const recent = this.getRecentInteractions(n)
    if (recent.length < 2) return SILENT_RECOMMENDATION

    const avgRate = this.getAverageSpeechRate(n)
    const category = this.classifyPace(avgRate)

    // ── 语速 → 速率调整映射 ──
    const rateAdjustment = this.mapPaceToRateAdjustment(category)

    const reason = `用户平均语速 ${avgRate.toFixed(1)} 字/秒（${paceCategoryLabel(category)}），TTS 语速${rateAdjustment >= 0 ? '+' : ''}${rateAdjustment}%`

    return {
      rateAdjustment,
      paceCategory: category,
      averageSpeechRate: avgRate,
      sampleCount: recent.length,
      reason,
    }
  }

  /**
   * 获取当前声学特征对 TTS 的自适应推荐（语速 + 音调）。
   *
   * 在 getRecommendation() 的语速推荐基础上，增加基于声学特征的音调推荐：
   * - 用户基频偏高 → TTS 音调偏高（匹配用户音域）
   * - 用户基频偏低 → TTS 音调偏低
   * - 用户能量高 → TTS 语音更活泼（加速 + 升调）
   * - 用户能量低 → TTS 语音更柔和（减速 + 降调）
   *
   * 同时考虑能量对语速的调节：高能量用户 -> 更快的语速匹配
   *
   * @param n 用于计算的最近交互次数（默认 4 次）
   * @returns AcousticProfileRecommendation
   */
  getAcousticRecommendation(n: number = this.recentWindow): AcousticProfileRecommendation {
    // ── 先获取语速推荐 ──
    const speechRec = this.getRecommendation(n)

    // ── 检查声学样本是否充足 ──
    const recentAcoustic = this.getRecentAcousticFeatures(n)
    if (recentAcoustic.length < 2) {
      return {
        ...speechRec,
        pitchAdjustment: 0,
        pitchCategory: 'normal',
        energyCategory: 'normal',
        averagePitchHz: 0,
        averageEnergy: 0,
        acousticSampleCount: recentAcoustic.length,
        reason: `${speechRec.reason}；${recentAcoustic.length > 0 ? '声学样本不足（需至少 2 次）' : '无声学数据'}`,
      }
    }

    // ── 计算平均声学特征 ──
    const avgPitchHz = this.average(recentAcoustic.map(r => r.pitchHz))
    const avgEnergy = this.average(recentAcoustic.map(r => r.energy))

    const pitchCategory = this.classifyPitch(avgPitchHz)
    const energyCategory = this.classifyEnergy(avgEnergy)

    // ── 基频 → 音调调整映射 ──
    const pitchAdjustment = this.mapPitchToAdjustment(pitchCategory)

    // ── 能量对语速的调节：高能量 → 加速微调，低能量 → 减速微调 ──
    const energyRateDelta = this.mapEnergyToRateDelta(energyCategory)

    // ── 综合语速调整（原始语速调整 + 能量调节） ──
    const combinedRateAdjustment = Math.max(-30, Math.min(30, speechRec.rateAdjustment + energyRateDelta))

    // ── 构建原因描述 ──
    const parts: string[] = [
      speechRec.reason,
    ]
    if (avgPitchHz > 0) {
      parts.push(`平均基频 ${avgPitchHz.toFixed(0)}Hz（${pitchCategoryLabel(pitchCategory)}），TTS 音调${pitchAdjustment >= 0 ? '+' : ''}${pitchAdjustment}%`)
    }
    if (avgEnergy > 0) {
      parts.push(`平均能量 ${(avgEnergy * 100).toFixed(0)}%（${energyCategoryLabel(energyCategory)}）`)
    }
    if (energyRateDelta !== 0) {
      parts.push(`由能量触发的语速微调${energyRateDelta >= 0 ? '+' : ''}${energyRateDelta}%`)
    }

    return {
      rateAdjustment: combinedRateAdjustment,
      pitchAdjustment,
      paceCategory: speechRec.paceCategory,
      pitchCategory,
      energyCategory,
      averageSpeechRate: speechRec.averageSpeechRate,
      averagePitchHz: Math.round(avgPitchHz * 10) / 10,
      averageEnergy: Math.round(avgEnergy * 100) / 100,
      sampleCount: speechRec.sampleCount,
      acousticSampleCount: recentAcoustic.length,
      reason: parts.join('；'),
    }
  }

  /**
   * 重置所有记录（用于调试/测试）。
   */
  reset(): void {
    this.interactions.length = 0
    this.acousticFeatures.length = 0
    log('INFO', 'speech_profile_tracker_reset')
  }

  /**
   * 获取当前窗口统计信息。
   */
  getStats(): { totalRecorded: number; acousticRecorded: number; windowSize: number; recentWindow: number } {
    return {
      totalRecorded: this.interactions.length,
      acousticRecorded: this.acousticFeatures.length,
      windowSize: this.windowSize,
      recentWindow: this.recentWindow,
    }
  }

  // ══════════════════════════════════════════
  //  内部：映射函数
  // ══════════════════════════════════════════

  /**
   * 语速分类 → 速率调整百分比
   */
  private mapPaceToRateAdjustment(category: SpeechPaceCategory): number {
    switch (category) {
      case 'very_slow': return -15
      case 'slow': return -8
      case 'normal': return 0
      case 'fast': return 8
      case 'very_fast': return 15
    }
  }

  /**
   * 基频分类 → 音调调整百分比（-20 ~ +20）
   *
   * 使用百分比而非 Hz，以兼容 Piper (speed/pitch factor) 和 Edge TTS (Hz offset) 两套体系：
   * - Piper 将百分比转为 factor (1 + pct/100)
   * - Edge TTS 将百分比 ≈ Hz 映射（在 ChatExecutor 中通过 parseInt 解析）
   *
   * 映射逻辑（交流适应理论）：
   * - very_low (< 100Hz):    TTS 音调降低 12% (深沉匹配)
   * - low (100-150Hz):       TTS 音调降低 5%
   * - normal (150-250Hz):    不调整
   * - high (250-350Hz):      TTS 音调升高 5%
   * - very_high (> 350Hz):   TTS 音调升高 10%
   */
  private mapPitchToAdjustment(category: PitchCategory): number {
    switch (category) {
      case 'very_low': return -12
      case 'low': return -5
      case 'normal': return 0
      case 'high': return 5
      case 'very_high': return 10
    }
  }

  /**
   * 能量分类 → 语速微调百分比
   *
   * 交流适应理论：高能量用户偏好活泼快速的反馈，低能量用户偏好柔和缓慢的反馈
   * - very_low:   减速 8% (轻柔匹配)
   * - low:        减速 4%
   * - normal:     不调整
   * - high:       加速 4%
   * - very_high:  加速 8%
   */
  private mapEnergyToRateDelta(category: EnergyCategory): number {
    switch (category) {
      case 'very_low': return -8
      case 'low': return -4
      case 'normal': return 0
      case 'high': return 4
      case 'very_high': return 8
    }
  }

  // ══════════════════════════════════════════
  //  内部：统计工具
  // ══════════════════════════════════════════

  private average(values: number[]): number {
    return values.length > 0
      ? values.reduce((sum, v) => sum + v, 0) / values.length
      : 0
  }
}

// ══════════════════════════════════════════
//  分类标签
// ══════════════════════════════════════════

const PACE_CATEGORY_LABELS: Record<SpeechPaceCategory, string> = {
  very_slow: '极慢',
  slow: '偏慢',
  normal: '正常',
  fast: '偏快',
  very_fast: '极快',
}

const PITCH_CATEGORY_LABELS: Record<PitchCategory, string> = {
  very_low: '很低沉',
  low: '偏低',
  normal: '正常',
  high: '偏高',
  very_high: '很高',
}

const ENERGY_CATEGORY_LABELS: Record<EnergyCategory, string> = {
  very_low: '很轻',
  low: '偏轻',
  normal: '正常',
  high: '偏高',
  very_high: '很高',
}

function paceCategoryLabel(category: SpeechPaceCategory): string {
  return PACE_CATEGORY_LABELS[category]
}

function pitchCategoryLabel(category: PitchCategory): string {
  return PITCH_CATEGORY_LABELS[category]
}

function energyCategoryLabel(category: EnergyCategory): string {
  return ENERGY_CATEGORY_LABELS[category]
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/**
 * 全局单例。
 *
 * 所有语音交互的记录和查询通过此单例完成。
 * 在 ASR IPC handler 中调用 recordInteraction()，
 * 在 ChatExecutor 中调用 getRecommendation() / getAcousticRecommendation() 获取自适应推荐。
 */
export const userSpeechProfileTracker = new UserSpeechProfileTracker({
  windowSize: 20,
  recentWindow: 4,
  minTextLength: 2,
  minAudioDurationMs: 500,
})
