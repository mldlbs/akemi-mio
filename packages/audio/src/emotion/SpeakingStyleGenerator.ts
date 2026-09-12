/**
 * SpeakingStyleGenerator — 语音风格参数生成器
 *
 * 将叙事情绪曲线（NarrativeEmotionCurve）转换为 TTS 可消费的
 * 逐段情感参数。支持：
 *   1. 为每个段落生成 SpeakingStyle 参数（用于 edge-tts --style）
 *   2. 段落间情感插值，实现平滑过渡
 *   3. 情感向量 → SpeakingStyle 标签映射
 *   4. 风格强度（style-degree）计算
 *
 * 注意：SpeakingStyle 参数仅云端 edge-tts 支持；
 * Piper 本地引擎将回退到 rate/pitch 调整。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { EmotionTtsParams, EmotionVector, NarrativeEmotionSegment, NarrativeEmotionCurve, VoiceStyle } from '../types'
import { SPEAKING_STYLE_VOICE_MAP } from '../types'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 单个段落的 TTS 合成参数（含 SpeakingStyle） */
export interface StyledTtsSegment {
  /** 段落文本 */
  text: string
  /** 情感 TTS 参数 */
  params: EmotionTtsParams
  /** 边缘 TTS SpeakingStyle 名称 */
  speakingStyle: string
  /** 风格强度 0.0–2.0 */
  styleDegree: number
  /** 持续时间估计（毫秒） */
  estimatedDurationMs: number
}

/** SpeakingStyle 生成结果 */
export interface SpeakingStyleResult {
  /** 段落列表（每个段落有自己的风格参数） */
  segments: StyledTtsSegment[]
  /** 整体情感曲线标签 */
  overallLabel: string
  /** 云端是否支持 SpeakingStyle（取决于引擎） */
  speakingStyleSupported: boolean
}

// ══════════════════════════════════════════
//  SpeakingStyleGenerator
// ══════════════════════════════════════════

export class SpeakingStyleGenerator {
  /**
   * 将叙事情绪曲线转换为段落级 TTS 参数。
   *
   * @param curve 叙事情绪曲线
   * @param baseParams 基础 TTS 参数（voice, rate baseline）
   * @param isCloudEngine 是否使用云端引擎（云端支持 SpeakingStyle）
   * @returns 段落级 TTS 参数列表
   */
  generateFromCurve(curve: NarrativeEmotionCurve, baseParams: EmotionTtsParams, isCloudEngine: boolean): SpeakingStyleResult {
    if (curve.segments.length === 0) {
      return {
        segments: [],
        overallLabel: '中性',
        speakingStyleSupported: isCloudEngine,
      }
    }

    const segments: StyledTtsSegment[] = []

    for (let i = 0; i < curve.segments.length; i++) {
      const seg = curve.segments[i]
      const styled = this.generateSegmentParams(seg, baseParams, isCloudEngine, i, curve.segments.length)

      // 段间插值：将前一段的风格强度与当前段混合
      if (isCloudEngine && i > 0) {
        const prev = segments[i - 1]
        styled.styleDegree = this.interpolateStyleDegree(
          prev.styleDegree,
          styled.styleDegree,
          0.3, // 30% 保留前一段的风格色彩
        )
      }

      segments.push(styled)
    }

    // 整体标签 = 第一段的情感 + 趋势
    const firstSeg = curve.segments[0]
    const lastSeg = curve.segments[curve.segments.length - 1]
    const overallLabel = this.buildOverallLabel(firstSeg, lastSeg, curve.trendDescription)

    return {
      segments,
      overallLabel,
      speakingStyleSupported: isCloudEngine,
    }
  }

  /**
   * 为单个叙事情感段落生成 TTS 参数。
   */
  private generateSegmentParams(
    segment: NarrativeEmotionSegment,
    baseParams: EmotionTtsParams,
    isCloudEngine: boolean,
    index: number,
    totalSegments: number,
  ): StyledTtsSegment {
    const { text, style, styleDegree, emotionVector } = segment
    const speakingStyle = segment.speakingStyle || SPEAKING_STYLE_VOICE_MAP[style] || 'neutral'

    // ── TTS 参数映射 ──
    // 继续使用基础 voice，但根据情感向量调整 rate 和 pitch
    const rateAdjust = this.emotionToRateAdjustment(emotionVector)
    const pitchAdjust = this.emotionToPitchAdjustment(emotionVector)

    const baseRate = parseInt(baseParams.rate.replace(/[^0-9-]/g, '')) || 10
    const basePitch = parseInt(baseParams.pitch.replace(/[^0-9-]/g, '')) || 8

    const adjustedRate = Math.max(-50, Math.min(50, baseRate + rateAdjust))
    const adjustedPitch = Math.max(-20, Math.min(20, basePitch + pitchAdjust))

    const params: EmotionTtsParams = {
      voice: baseParams.voice,
      rate: `${adjustedRate >= 0 ? '+' : ''}${adjustedRate}%`,
      pitch: `${adjustedPitch >= 0 ? '+' : ''}${adjustedPitch}Hz`,
      label: `叙事·${style}`,
    }

    // ── 估计持续时间 ──
    const estimatedDurationMs = Math.max(2000, text.length * 80)

    return {
      text,
      params,
      speakingStyle,
      styleDegree: Math.max(0, Math.min(2, styleDegree * 2)), // 0-1 → 0-2
      estimatedDurationMs,
    }
  }

  /**
   * 段间风格强度插值，避免情感突变。
   */
  private interpolateStyleDegree(prevDegree: number, currDegree: number, prevWeight: number): number {
    return Math.round((prevDegree * prevWeight + currDegree * (1 - prevWeight)) * 100) / 100
  }

  /**
   * 情感向量 → 语速调整映射。
   * 高兴 + 高唤醒 → 加快；悲伤 → 放慢
   */
  private emotionToRateAdjustment(vector: EmotionVector): number {
    // 效价影响：正面 + 唤醒高 → 加快，负面 → 放慢
    const valenceEffect = vector.valence * 5 // -5 ~ +5
    const arousalEffect = vector.arousal * 8 // -8 ~ +8
    return Math.round(valenceEffect + arousalEffect)
  }

  /**
   * 情感向量 → 音调调整映射。
   * 高兴 → 偏高；悲伤/平静 → 偏低
   */
  private emotionToPitchAdjustment(vector: EmotionVector): number {
    // 效价主导音调
    const valenceEffect = vector.valence * 4 // -4 ~ +4
    const arousalEffect = vector.arousal * 3 // -3 ~ +3
    return Math.round(valenceEffect + arousalEffect)
  }

  /**
   * 构建整体情感标签。
   */
  private buildOverallLabel(firstSeg: NarrativeEmotionSegment, lastSeg: NarrativeEmotionSegment, trendDesc: string): string {
    const startLabel = firstSeg.speakingStyle || firstSeg.style || '中性'
    const endLabel = lastSeg.speakingStyle || lastSeg.style || '中性'

    if (startLabel === endLabel) return startLabel
    return `${startLabel} → ${endLabel}（${trendDesc}）`
  }

  /**
   * 生成不带段落分割的 SpeakingStyle 参数（用于短文本/单段回复）。
   * 将整段文本映射到一个 SpeakingStyle。
   */
  generateSingleStyle(
    text: string,
    emotionVector: EmotionVector,
    baseParams: EmotionTtsParams,
    isCloudEngine: boolean,
  ): SpeakingStyleResult {
    // 从情感向量推断 VoiceStyle
    const style = this.vectorToVoiceStyle(emotionVector)
    const segment: NarrativeEmotionSegment = {
      text,
      style,
      styleDegree: Math.abs(emotionVector.valence + emotionVector.arousal) / 2,
      emotionVector,
      speakingStyle: SPEAKING_STYLE_VOICE_MAP[style],
    }

    const curve: NarrativeEmotionCurve = {
      segments: [segment],
      trendDescription: '单段',
    }

    return this.generateFromCurve(curve, baseParams, isCloudEngine)
  }

  /**
   * 将情感向量映射到最接近的 VoiceStyle。
   */
  vectorToVoiceStyle(vector: EmotionVector): VoiceStyle {
    const { valence, arousal } = vector

    // 高唤醒 + 高效价 → 欢快/活力
    if (arousal > 0.5 && valence > 0.5) return 'energetic'
    if (arousal > 0.3 && valence > 0.3) return 'cheerful'

    // 高唤醒 + 低效价 → 严肃/俏皮（取决于效价程度）
    if (arousal > 0.3 && valence < -0.3) return 'serious'

    // 低唤醒 + 高效价 → 温暖/沉稳
    if (arousal < -0.2 && valence > 0.3) return 'warm'
    if (arousal < -0.3 && valence > 0) return 'calm'

    // 低唤醒 + 低效价 → 温柔
    if (arousal < -0.3 && valence < -0.2) return 'gentle'

    // 低唤醒 + 负效价低 → 沉稳
    if (arousal < -0.4) return 'calm'

    // 高效价 → 俏皮
    if (valence > 0.6) return 'playful'

    // 默认
    return 'neutral'
  }
}

/** 全局单例 */
export const speakingStyleGenerator = new SpeakingStyleGenerator()
