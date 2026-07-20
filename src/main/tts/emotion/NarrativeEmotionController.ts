/**
 * NarrativeEmotionController — 叙事情感控制器
 *
 * 核心协调器，将记忆情感时间序列与 Agent 回复整合为可消费的情感曲线。
 *
 * 职责：
 *   1. 从 Memory 构建情感时间序列（复用 EmotionTimeSeriesStore）
 *   2. 分析用户情感轨迹，识别趋势和拐点
 *   3. 根据回复文本和情感上下文，生成叙事情绪曲线（NarrativeEmotionCurve）
 *   4. 将情绪曲线转换为 TTS 段落参数（委托 SpeakingStyleGenerator）
 *
 * 流程：
 *   LLM 回复 → Agent 检测情感变化 → 构建 NarrativeEmotionCurve
 *   → SpeakingStyleGenerator → 段落级 TTS 参数 → TtsService.speakNarrative()
 */

import { log } from '../../logger/Logger'
import type { MemoryService } from '../../memory/MemoryService'
import type { EmotionTtsParams, EmotionVector, NarrativeEmotionCurve, NarrativeEmotionSegment, VoiceStyle } from '../types'
import { DEFAULT_NARRATIVE_CURVE, SPEAKING_STYLE_VOICE_MAP } from '../types'
import { emotionTimeSeriesStore } from './EmotionTimeSeriesStore'
import { speakingStyleGenerator, type SpeakingStyleResult, type StyledTtsSegment } from './SpeakingStyleGenerator'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 控制器配置 */
export interface NarrativeEmotionConfig {
  /** 是否启用叙事情感控制 */
  enabled: boolean
  /** 云端引擎 SpeakingStyle 支持 */
  cloudStyleSupported: boolean
  /** 最小文本长度（字符数）触发分段 */
  minSegmentChars: number
  /** 最大段落数 */
  maxSegments: number
  /** 情感曲线幅度阈值（低于此值不分段） */
  curveAmplitudeThreshold: number
}

/** 默认配置 */
const DEFAULT_CONFIG: NarrativeEmotionConfig = {
  enabled: true,
  cloudStyleSupported: true,
  minSegmentChars: 30,
  maxSegments: 5,
  curveAmplitudeThreshold: 0.15,
}

// ══════════════════════════════════════════
//  NarrativeEmotionController
// ══════════════════════════════════════════

export class NarrativeEmotionController {
  private config: NarrativeEmotionConfig

  constructor(config?: Partial<NarrativeEmotionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 更新配置 */
  updateConfig(config: Partial<NarrativeEmotionConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /** 获取当前配置 */
  getConfig(): NarrativeEmotionConfig {
    return { ...this.config }
  }

  // ══════════════════════════════════════════
  //  核心公开 API
  // ══════════════════════════════════════════

  /**
   * 为 Agent 回复构建叙事情绪曲线。
   *
   * @param replyText Agent 的完整回复文本
   * @param memoryService MemoryService 实例
   * @param baseParams 当前基础 TTS 参数
   * @param isCloudEngine 是否使用云端引擎
   * @param agentSegments 可选：Agent 指定的段落情感标签（如果 Agent 在回复中标注了情感）
   * @returns 段落级 TTS 参数（含 SpeakingStyle）
   */
  buildNarrativeEmotion(
    replyText: string,
    memoryService: MemoryService | null,
    baseParams: EmotionTtsParams,
    isCloudEngine: boolean,
    agentSegments?: NarrativeEmotionSegment[],
  ): SpeakingStyleResult {
    if (!this.config.enabled || !memoryService) {
      // 禁用或无内存 → 返回单段无情感曲线
      return this.fallbackToFlat(replyText, baseParams, isCloudEngine)
    }

    try {
      // 1. 如果 Agent 提供了分段情感标签，直接使用
      if (agentSegments && agentSegments.length > 0) {
        const curve: NarrativeEmotionCurve = {
          segments: agentSegments,
          trendDescription: 'Agent 标注',
          sourceTimeSeries: emotionTimeSeriesStore.buildTimeSeries(memoryService),
        }
        return speakingStyleGenerator.generateFromCurve(curve, baseParams, isCloudEngine)
      }

      // 2. 无 Agent 标注 → 自动构建情感曲线
      return this.buildAutoCurve(replyText, memoryService, baseParams, isCloudEngine)
    } catch (err) {
      log('WARN', 'narrative_emotion_build_error', { error: String(err) })
      return this.fallbackToFlat(replyText, baseParams, isCloudEngine)
    }
  }

  /**
   * 从记忆系统中提取用户情感时间序列快照。
   * 供 Agent 在回复时参考。
   */
  getEmotionContextForAgent(memoryService: MemoryService | null): string {
    if (!memoryService) return ''

    try {
      const series = emotionTimeSeriesStore.buildTimeSeries(memoryService)
      if (series.length === 0) return ''

      const latest = series[series.length - 1]
      const trend = emotionTimeSeriesStore.getTrendSummary(memoryService)

      return `【用户情感状态】效价 ${latest.emotionVector.valence.toFixed(2)}，唤醒度 ${latest.emotionVector.arousal.toFixed(2)}，当前情绪 ${latest.label}，趋势：${trend}`
    } catch {
      return ''
    }
  }

  // ══════════════════════════════════════════
  //  私有方法
  // ══════════════════════════════════════════

  /**
   * 自动构建情感曲线（无 Agent 标注时使用）。
   *
   * 策略：
   *   1. 从 Memory 获取最近的情感向量
   *   2. 将回复文本分段（按情感转折点）
   *   3. 为每个段落分配情感值
   *   4. 在段落间插值实现平滑过渡
   */
  private buildAutoCurve(
    replyText: string,
    memoryService: MemoryService,
    baseParams: EmotionTtsParams,
    isCloudEngine: boolean,
  ): SpeakingStyleResult {
    // 获取最新情感向量
    const latestVector = emotionTimeSeriesStore.getLatestEmotionVector(memoryService)
    const trendSummary = emotionTimeSeriesStore.getTrendSummary(memoryService)

    // 如果文本太短，不分段
    if (replyText.length < this.config.minSegmentChars) {
      return speakingStyleGenerator.generateSingleStyle(replyText, latestVector, baseParams, isCloudEngine)
    }

    // 自动分段：按句号、问号、感叹号、换行分割
    const rawSegments = this.splitTextBySentences(replyText)

    // 如果分段太少，不分段
    if (rawSegments.length < 2) {
      return speakingStyleGenerator.generateSingleStyle(replyText, latestVector, baseParams, isCloudEngine)
    }

    // 为每个段落分配情感值
    const emotionSegments = this.assignEmotionToSegments(
      rawSegments,
      latestVector,
      trendSummary,
      this.config.maxSegments,
    )

    const curve: NarrativeEmotionCurve = {
      segments: emotionSegments,
      trendDescription: trendSummary,
      sourceTimeSeries: emotionTimeSeriesStore.buildTimeSeries(memoryService),
    }

    return speakingStyleGenerator.generateFromCurve(curve, baseParams, isCloudEngine)
  }

  /**
   * 按句号、感叹号、问号、换行分割文本为段落。
   * 每段不少于 minChars 字符。
   */
  private splitTextBySentences(text: string): string[] {
    // 按句子边界分割
    const raw = text.split(/(?<=[。！？\n!?])/).filter((s) => s.trim().length > 0)
    const merged: string[] = []
    let current = ''

    for (const segment of raw) {
      current += segment
      // 如果当前段足够长，或者遇到换行，就作为一个段落
      if (current.length >= this.config.minSegmentChars || segment.endsWith('\n')) {
        merged.push(current.trim())
        current = ''
      }
    }
    if (current.trim().length > 0) merged.push(current.trim())

    // 如果合并后还是太短，整段返回
    if (merged.length === 0) return [text]
    return merged
  }

  /**
   * 为每个文本段落分配情感值。
   *
   * 策略：
   *   - 第一段匹配当前用户情感
   *   - 后续段落沿情感趋势微移
   *   - 如果用户情绪负面，回复的情感从共情（负面）→ 引导（正面）过渡
   *   - 如果用户情绪正面，回复保持正向
   */
  private assignEmotionToSegments(
    segments: string[],
    latestVector: EmotionVector,
    trendSummary: string,
    maxSegments: number,
  ): NarrativeEmotionSegment[] {
    const capped = segments.slice(0, maxSegments)
    const result: NarrativeEmotionSegment[] = []

    // 判断用户情绪状态
    const isNegative = latestVector.valence < -0.2
    const isPositive = latestVector.valence > 0.2
    const isNeutral = !isNegative && !isPositive

    // 为每段分配情感向量（从起始→结束线性插值）
    for (let i = 0; i < capped.length; i++) {
      const t = capped.length > 1 ? i / (capped.length - 1) : 0

      let targetValence: number
      let targetArousal: number

      if (isNegative) {
        // 负面情绪：从共情（匹配用户）→ 逐步引导到正面
        targetValence = latestVector.valence * (1 - t) + 0.3 * t
        targetArousal = latestVector.arousal * (1 - t) + 0.1 * t
      } else if (isPositive) {
        // 正面情绪：保持正面，逐渐升温
        targetValence = latestVector.valence * (1 - t) + Math.min(latestVector.valence + 0.2, 1.0) * t
        targetArousal = latestVector.arousal * (1 - t) + Math.min(latestVector.arousal + 0.2, 1.0) * t
      } else {
        // 中性：平稳
        targetValence = latestVector.valence
        targetArousal = latestVector.arousal
      }

      // 夹到有效范围
      const valence = Math.max(-1, Math.min(1, targetValence))
      const arousal = Math.max(-1, Math.min(1, targetArousal))

      // 推断 VoiceStyle
      const style = speakingStyleGenerator.vectorToVoiceStyle({ valence, arousal })

      // 计算风格强度
      const degree = Math.min(1.0, (Math.abs(valence) + Math.abs(arousal)) / 2)

      const label = this.vectorToChineseLabel({ valence, arousal })

      result.push({
        text: capped[i],
        style,
        styleDegree: Math.round(degree * 10) / 10,
        emotionVector: { valence, arousal },
        speakingStyle: SPEAKING_STYLE_VOICE_MAP[style],
      })
    }

    return result
  }

  /**
   * 情感向量 → 中文标签。
   */
  private vectorToChineseLabel(vector: EmotionVector): string {
    const { valence, arousal } = vector

    if (valence > 0.4 && arousal > 0.4) return '开心'
    if (valence > 0.4 && arousal < -0.2) return '温暖'
    if (valence < -0.4 && arousal > 0.3) return '严肃'
    if (valence < -0.4 && arousal < -0.3) return '悲伤'
    if (arousal > 0.5 && Math.abs(valence) < 0.3) return '兴奋'
    if (arousal < -0.4 && Math.abs(valence) < 0.3) return '平静'
    return '中性'
  }

  /**
   * 回退到平面单段风格（禁用/错误时）。
   */
  private fallbackToFlat(
    text: string,
    baseParams: EmotionTtsParams,
    isCloudEngine: boolean,
  ): SpeakingStyleResult {
    return speakingStyleGenerator.generateSingleStyle(
      text,
      { valence: 0, arousal: 0 },
      baseParams,
      isCloudEngine,
    )
  }
}

/** 全局单例 */
export const narrativeEmotionController = new NarrativeEmotionController()
