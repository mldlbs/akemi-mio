/**
 * VoiceEmotionClassifier — 从音频声学特征推断用户语音情感
 *
 * 基于 AudioFeatureExtractor 提取的韵律特征，映射到 6 种情感标签：
 *   neutral / happy / sad / angry / calm / anxious
 *
 * 使用纯数学方法（加权线性 + sigmoid/gaussian 激活），
 * 无需 ML 推理依赖，全部在本地 CPU 毫秒级完成。
 *
 * 可与 ANE/GPU 加速的神经网络模型替换（通过相同接口）。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { AudioFeatures } from './types'
import type { VoiceEmotion, VoiceEmotionLabel } from './types'

// ══════════════════════════════════════════
//  特征→情感映射权重（可调参数）
// ══════════════════════════════════════════

/**
 * 各情感维度的特征权重。
 * 权重为正表示该特征值越高越倾向该情感，为负表示越低越倾向。
 * 每个维度的特征经过 sigmoid/gaussian 激活后加权求和。
 */
interface EmotionWeights {
  happy: {
    energy: number
    pitch: number
    zcr: number
    silence: number
    segments: number
    speechRate: number
  }
  sad: {
    energy: number
    pitch: number
    pitchVariance: number
    silence: number
    speechRate: number
  }
  angry: {
    energy: number
    pitch: number
    pitchVariance: number
    zcr: number
    speechRate: number
  }
  calm: {
    energy: number
    energyVariance: number
    zcr: number
    pitchRange: number
    silence: number
  }
  anxious: {
    energy: number
    energyVariance: number
    pitchVariance: number
    speechRate: number
    zcr: number
  }
}

const DEFAULT_EMOTION_WEIGHTS: EmotionWeights = {
  happy: {
    energy: 0.3,
    pitch: 0.25,
    zcr: -0.2,
    silence: -0.2,
    segments: 0.2,
    speechRate: 0.15,
  },
  sad: {
    energy: -0.3,
    pitch: -0.25,
    pitchVariance: -0.2,
    silence: 0.2,
    speechRate: -0.15,
  },
  angry: {
    energy: 0.3,
    pitch: 0.2,
    pitchVariance: 0.2,
    zcr: 0.2,
    speechRate: 0.15,
  },
  calm: {
    energy: -0.2,
    energyVariance: -0.25,
    zcr: -0.2,
    pitchRange: -0.2,
    silence: -0.15,
  },
  anxious: {
    energy: 0.1,
    energyVariance: 0.25,
    pitchVariance: 0.3,
    speechRate: 0.2,
    zcr: 0.15,
  },
}

// ══════════════════════════════════════════
//  分类器
// ══════════════════════════════════════════

export class VoiceEmotionClassifier {
  private weights: EmotionWeights

  constructor(weights?: Partial<EmotionWeights>) {
    this.weights = this.mergeWeights(DEFAULT_EMOTION_WEIGHTS, weights || {})
  }

  /**
   * 加载新的权重配置（运行时热更新）。
   */
  loadWeights(weights: Partial<EmotionWeights>): void {
    this.weights = this.mergeWeights(DEFAULT_EMOTION_WEIGHTS, weights)
    log('INFO', 'voice_emotion_weights_updated', {
      happy: JSON.stringify(this.weights.happy),
    })
  }

  /**
   * 从 AudioFeatures 推断用户语音情感。
   *
   * @param features AudioFeatureExtractor 提取的韵律特征
   * @returns VoiceEmotion 情感分析结果
   */
  classify(features: AudioFeatures): VoiceEmotion {
    // 计算各情感维度的原始分
    const rawScores: Record<VoiceEmotionLabel, number> = {
      neutral: this.computeNeutral(features),
      happy: this.computeHappy(features),
      sad: this.computeSad(features),
      angry: this.computeAngry(features),
      calm: this.computeCalm(features),
      anxious: this.computeAnxious(features),
    }

    // Softmax 归一化到 [0, 1]
    const normalized = this.softmax(rawScores)

    // 找主导情感
    let dominant: VoiceEmotionLabel = 'neutral'
    let dominantScore = -1
    for (const [label, score] of Object.entries(normalized) as [VoiceEmotionLabel, number][]) {
      if (score > dominantScore) {
        dominantScore = score
        dominant = label
      }
    }

    // 置信度：主导与次主导的差距
    const sorted = Object.entries(normalized).sort(([, a], [, b]) => b - a)
    const confidence = sorted.length >= 2 ? Math.min(1, Math.max(0, sorted[0][1] - sorted[1][1]) * 2) : 0.5

    log('DEBUG', 'voice_emotion_classified', {
      label: dominant,
      confidence: Math.round(confidence * 100) / 100,
      scores: Object.fromEntries(Object.entries(normalized).map(([k, v]) => [k, v.toFixed(2)])),
      energy: features.energy.toFixed(2),
      pitchHz: features.pitchHz,
      speechRate: features.speechRate.toFixed(1),
    })

    return {
      label: dominant,
      scores: normalized,
      confidence: Math.round(confidence * 100) / 100,
      features: {
        energy: Math.round(features.energy * 100) / 100,
        pitchHz: Math.round(features.pitchHz),
        speechRate: Math.round(features.speechRate * 10) / 10,
        silenceRatio: Math.round(features.silenceRatio * 100) / 100,
      },
    }
  }

  // ── 各情感维度计算 ──

  /**
   * 中性：各项指标均在常规范围内（不高不低），作为兜底标签。
   * 当所有其他情感分值都低时，中性胜出。
   */
  private computeNeutral(f: AudioFeatures): number {
    // 中性 = 所有其他情感都不显著
    // 这里计算与所有"显著"状态的偏离度
    const energyScore = this.gaussian(f.energy, 0.35, 0.25)
    const pitchScore = this.gaussian(f.pitchHz / 250, 0.35, 0.2)
    const rateScore = this.gaussian(f.speechRate / 10, 0.4, 0.2)
    const silenceScore = this.gaussian(f.silenceRatio, 0.15, 0.15)
    return (energyScore + pitchScore + rateScore + silenceScore) / 4
  }

  /**
   * 开心：中高能量、中高音调、低过零率、低静音比、多语音段、语速稍快
   */
  private computeHappy(f: AudioFeatures): number {
    const w = this.weights.happy
    // 能量在中高区域最佳
    const energyScore = this.gaussian(f.energy, 0.5, 0.2)
    return (
      w.energy * energyScore +
      w.pitch * this.sigmoid(f.pitchHz / 250, 0.35, 5) +
      w.zcr * this.sigmoid(-f.avgZeroCrossingRate, -0.05, 40) +
      w.silence * this.sigmoid(-f.silenceRatio, -0.25, 5) +
      w.segments * this.sigmoid(f.voiceSegmentCount / 15, 0.3, 5) +
      w.speechRate * this.sigmoid(f.speechRate / 10, 0.4, 5)
    )
  }

  /**
   * 悲伤：低能量、低音调、语调单调、高静音比、语速慢
   */
  private computeSad(f: AudioFeatures): number {
    const w = this.weights.sad
    return (
      w.energy * this.sigmoid(-f.energy, -0.2, 5) +
      w.pitch * this.sigmoid(-f.pitchHz / 200, -0.25, 5) +
      w.pitchVariance * this.sigmoid(-f.pitchVariance / 50, -0.3, 5) +
      w.silence * this.sigmoid(f.silenceRatio, 0.3, 5) +
      w.speechRate * this.sigmoid(-f.speechRate / 10, -0.3, 5)
    )
  }

  /**
   * 生气：高能量、高音调、音调跳跃大、高过零率、语速快
   */
  private computeAngry(f: AudioFeatures): number {
    const w = this.weights.angry
    return (
      w.energy * this.sigmoid(f.energy, 0.5, 5) +
      w.pitch * this.sigmoid(f.pitchHz / 300, 0.4, 5) +
      w.pitchVariance * this.sigmoid(f.pitchVariance / 100, 0.3, 5) +
      w.zcr * this.sigmoid(f.avgZeroCrossingRate, 0.06, 40) +
      w.speechRate * this.sigmoid(f.speechRate / 10, 0.5, 5)
    )
  }

  /**
   * 平静：中低能量、低能量波动、低过零率、音调范围小、低静音比
   */
  private computeCalm(f: AudioFeatures): number {
    const w = this.weights.calm
    return (
      w.energy * this.sigmoid(-f.energy, -0.25, 5) +
      w.energyVariance * this.sigmoid(-f.energyVariance, -0.2, 8) +
      w.zcr * this.sigmoid(-f.avgZeroCrossingRate, -0.03, 40) +
      w.pitchRange * this.sigmoid(-f.pitchRange / 100, -0.2, 5) +
      w.silence * this.sigmoid(-f.silenceRatio, -0.2, 5)
    )
  }

  /**
   * 焦虑：高能量波动、高音调变化、语速快（或忽快忽慢）、中高过零率
   */
  private computeAnxious(f: AudioFeatures): number {
    const w = this.weights.anxious
    return (
      w.energy * this.sigmoid(f.energy, 0.3, 5) +
      w.energyVariance * this.sigmoid(f.energyVariance, 0.3, 8) +
      w.pitchVariance * this.sigmoid(f.pitchVariance / 100, 0.35, 5) +
      w.speechRate * this.sigmoid(f.speechRate / 10, 0.5, 5) +
      w.zcr * this.sigmoid(f.avgZeroCrossingRate, 0.05, 40)
    )
  }

  // ── 工具函数 ──

  /** Sigmoid 激活函数 y = 1 / (1 + exp(-k*(x-x0))) */
  private sigmoid(x: number, x0: number, k: number): number {
    return 1 / (1 + Math.exp(-k * (x - x0)))
  }

  /** 高斯函数 y = exp(-(x-mu)^2 / (2*sigma^2)) */
  private gaussian(x: number, mu: number, sigma: number): number {
    return Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma))
  }

  /** Softmax 归一化 */
  private softmax(raw: Record<string, number>): Record<VoiceEmotionLabel, number> {
    const keys = Object.keys(raw) as VoiceEmotionLabel[]
    const maxVal = Math.max(0.001, ...Object.values(raw))
    const expValues = keys.map((k) => Math.exp(raw[k] - maxVal))
    const sumExp = expValues.reduce((a, b) => a + b, 0) || 1

    const normalized: Record<VoiceEmotionLabel, number> = {} as Record<VoiceEmotionLabel, number>
    for (let i = 0; i < keys.length; i++) {
      normalized[keys[i]] = Math.round((expValues[i] / sumExp) * 100) / 100
    }
    return normalized
  }

  /** 合并权重 */
  private mergeWeights(defaults: EmotionWeights, overrides: Partial<EmotionWeights>): EmotionWeights {
    const result = { ...defaults }
    for (const dim of Object.keys(defaults) as (keyof EmotionWeights)[]) {
      if (overrides[dim]) {
        ;(result as Record<string, unknown>)[dim] = { ...defaults[dim], ...overrides[dim] }
      }
    }
    return result
  }
}

/** 全局单例 */
export const voiceEmotionClassifier = new VoiceEmotionClassifier()
