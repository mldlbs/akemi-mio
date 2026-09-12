/**
 * AsrConfidenceScorer — ASR 识别置信度启发式估计器
 *
 * 由于 whisper.cpp GPU 引擎不直接输出 segment-level 置信度，
 * 本模块通过音频特征 + 文本特征启发式估算置信度分值 (0–1)。
 *
 * 打分依据：
 * 1. 音频特征：能量、静音比、过零率、基频稳定性
 * 2. 文本特征：识别文本长度、乱码字符比例、Whisper 幻觉匹配
 *
 * 使用场景：
 * - AsrService.transcribe() 完成后调用，分值 < 0.7 的记录到 AsrLogStore
 * - AsrLogCollector 读取低置信度片段用于进化分析
 */

import type { AudioFeatures } from './types'

// =============================================================================
// 配置阈值
// =============================================================================

/** 默认低置信度阈值 — 低于此值视为低置信度片段 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7

/** 最小有效文本长度（字符数），过短视为低置信 */
const MIN_VALID_TEXT_LENGTH = 2

/** 乱码字符（�）占比阈值 — 超过此值大幅降低置信度 */
const GARBLED_CHAR_RATIO_THRESHOLD = 0.1

// =============================================================================
// Whisper 幻觉文本模式 — 在静音/底噪下高频输出
// =============================================================================

const HALLUCINATION_PATTERNS: RegExp[] = [
  /^谢谢大家$/,
  /^谢谢\s*$/,
  /^感谢\s*$/,
  /^感谢大家$/,
  /^再会\s*$/,
  /^再见\s*$/,
  /^谢谢观看\s*$/,
  /^感谢收听\s*$/,
  /^谢谢收看\s*$/,
  /^感谢观看\s*$/,
  /^\(.*\)$/,
  /^[\p{P}\p{S}\s]+$/u,
]

// =============================================================================
// 低置信关键词 — 文本中出现这些词表明识别可能不准确
// =============================================================================

const LOW_CONFIDENCE_KEYWORDS = ['嗯', '呃', '啊', '哦', '噢', '哎', '嗯哼', '呃呃', '啊啊']

// =============================================================================
// AsrConfidenceScorer
// =============================================================================

export class AsrConfidenceScorer {
  /**
   * 综合音频特征和文本特征估计 ASR 识别置信度。
   *
   * @param text          ASR 识别出的文本
   * @param features      音频特征（从 AudioFeatureExtractor 获取）
   * @returns             置信度分值 (0–1)
   */
  score(text: string, features?: AudioFeatures): number {
    let confidence = 1.0

    // ── 文本特征打分 ──
    confidence *= this.scoreText(text)

    // ── 音频特征打分（如果有） ──
    if (features) {
      confidence *= this.scoreAudioFeatures(features)
    }

    // 最终分值钳制到 [0, 1]
    return Math.max(0, Math.min(1, confidence))
  }

  /**
   * 判断文本是否为低置信度识别。
   * 便捷方法：score() < threshold。
   */
  isLowConfidence(text: string, features?: AudioFeatures, threshold = DEFAULT_CONFIDENCE_THRESHOLD): boolean {
    return this.score(text, features) < threshold
  }

  // ── 文本特征打分 (权重 ~0.6) ──

  private scoreText(text: string): number {
    if (!text || text.trim().length === 0) return 0

    const trimmed = text.trim()
    let score = 1.0

    // 1. 文本长度因子：过短 → 低置信
    if (trimmed.length < MIN_VALID_TEXT_LENGTH) {
      return 0 // 极短文本视为完全不可信
    }
    if (trimmed.length <= 3) {
      score *= 0.4 // 2–3 字文本，非常可疑
    } else if (trimmed.length <= 5) {
      score *= 0.7 // 4–5 字，略可疑
    }

    // 2. 乱码字符（UTF-8 损坏标记）
    const garbledCount = (trimmed.match(/�/g) || []).length
    if (garbledCount > 0) {
      const garbledRatio = garbledCount / trimmed.length
      if (garbledRatio > GARBLED_CHAR_RATIO_THRESHOLD) {
        score *= Math.max(0, 1 - garbledRatio * 2)
      }
    }

    // 3. Whisper 幻觉检测
    for (const pattern of HALLUCINATION_PATTERNS) {
      if (pattern.test(trimmed)) {
        score *= 0.1 // 幻觉模式，大幅降低置信度
        break
      }
    }

    // 4. 纯标点/符号
    if (/^[\p{P}\p{S}\s]+$/u.test(trimmed)) {
      return 0
    }

    // 5. 单音节重复（如 "嗯嗯嗯"、"啊啊啊"）
    if (trimmed.length >= 2) {
      const uniqueChars = new Set([...trimmed]).size
      if (uniqueChars === 1) {
        score *= 0.2
      }
    }

    // 6. 低置信关键词
    for (const kw of LOW_CONFIDENCE_KEYWORDS) {
      if (trimmed.includes(kw)) {
        score *= 0.85
        break
      }
    }

    // 7. 英文/数字比例过低且存在英文字符 → 识别不准确
    const asciiRatio = (trimmed.match(/[a-zA-Z0-9]/g) || []).length / trimmed.length
    if (asciiRatio > 0 && asciiRatio < 0.1) {
      score *= 0.9 // 少量英文混杂在中文中，可能误识别
    }

    return score
  }

  // ── 音频特征打分 (权重 ~0.4) ──

  private scoreAudioFeatures(features: AudioFeatures): number {
    let score = 1.0

    // 1. 能量特征：能量过低 → 静音/远场 → 低置信
    if (features.energy < 0.05) {
      score *= 0.3 // 几乎无声
    } else if (features.energy < 0.1) {
      score *= 0.6 // 声音很弱
    } else if (features.energy < 0.2) {
      score *= 0.85 // 声音偏小
    }

    // 2. 静音比：过高 → 低置信（大量空白被误识别为语音）
    if (features.silenceRatio > 0.8) {
      score *= 0.3
    } else if (features.silenceRatio > 0.6) {
      score *= 0.6
    } else if (features.silenceRatio > 0.4) {
      score *= 0.85
    }

    // 3. 过零率：过高 → 噪声环境 → 低置信
    if (features.avgZeroCrossingRate > 0.15) {
      score *= 0.4
    } else if (features.avgZeroCrossingRate > 0.1) {
      score *= 0.7
    }

    // 4. 基频稳定性：无声或基频缺失 → 环境噪声为主
    if (features.pitchHz === 0 && features.energy > 0.05) {
      // 有能量但无基频 → 噪声而非语音
      score *= 0.5
    }

    // 5. 语速：极端语速 → 可能异常
    if (features.speechRate > 0 && features.speechRate < 1) {
      score *= 0.7 // 极慢语速
    }
    if (features.speechRate > 15) {
      score *= 0.6 // 极快语速
    }

    return score
  }
}

// =============================================================================
// 单例
// =============================================================================

export const asrConfidenceScorer = new AsrConfidenceScorer()
