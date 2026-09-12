/**
 * AtmosphereMapper — 音频韵律特征 → 故事氛围参数映射
 *
 * 使用可配置的线性权重模型（"简单映射模型"），
 * 将 AudioFeatures 转化为 StoryAtmosphere 六维氛围分值。
 *
 * 可调优方式：
 * - 调整 DEFAULT_ATMOSPHERE_WEIGHTS 中的权重系数（等价于线性模型训练）
 * - 调整各维度的激活函数参数（阈值/缩放）
 * - 可通过 loadWeights() 加载用户的偏好权重
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { AudioFeatures, StoryAtmosphere, AtmosphereMappingWeights } from './types'
import { DEFAULT_ATMOSPHERE_WEIGHTS, ATMOSPHERE_LABELS } from './types'

// ══════════════════════════════════════════
//  氛围维度定义
// ══════════════════════════════════════════

interface AtmosphereDimension {
  key: string
  label: string
  description: string
  writingHint: string
}

const DIMENSION_DEFS: AtmosphereDimension[] = ATMOSPHERE_LABELS.map((l) => ({
  key: l.key,
  label: l.label,
  description: l.description,
  writingHint: l.writingHint,
}))

// ══════════════════════════════════════════
//  映射器
// ══════════════════════════════════════════

export class AtmosphereMapper {
  private weights: AtmosphereMappingWeights

  constructor(weights?: Partial<AtmosphereMappingWeights>) {
    // 合并用户提供的权重（如有）与默认权重
    this.weights = this.mergeWeights(DEFAULT_ATMOSPHERE_WEIGHTS, weights || {})
  }

  /**
   * 加载新的权重配置（等价于"热更新模型参数"）。
   * 可用于根据用户反馈在线调优。
   */
  loadWeights(weights: Partial<AtmosphereMappingWeights>): void {
    this.weights = this.mergeWeights(DEFAULT_ATMOSPHERE_WEIGHTS, weights)
    log('INFO', 'atmosphere_weights_updated', {
      tension: JSON.stringify(this.weights.tension),
      joy: JSON.stringify(this.weights.joy),
    })
  }

  /** 获取当前权重 */
  getWeights(): AtmosphereMappingWeights {
    return { ...this.weights }
  }

  /**
   * 将音频特征映射为故事氛围参数。
   *
   * @param features AudioFeatureExtractor 提取的特征
   * @returns StoryAtmosphere 六维氛围分值
   */
  map(features: AudioFeatures): StoryAtmosphere {
    // 计算各维度原始分
    const rawScores: Record<string, number> = {
      tension: this.computeTension(features),
      joy: this.computeJoy(features),
      sadness: this.computeSadness(features),
      calmness: this.computeCalmness(features),
      mystery: this.computeMystery(features),
      romance: this.computeRomance(features),
    }

    // Softmax 归一化到 [0, 1]
    const normalizedScores = this.normalizeScores(rawScores)

    // 找主导氛围
    const dominantKey = this.findDominant(normalizedScores)
    const dominantDef = DIMENSION_DEFS.find((d) => d.key === dominantKey)

    // 置信度计算：主导分值与次高分值的差距
    const sorted = Object.entries(normalizedScores).sort(([, a], [, b]) => b - a)
    const confidence = sorted.length >= 2 ? Math.min(1, Math.max(0, sorted[0][1] - sorted[1][1]) * 2) : 0.5

    const result: StoryAtmosphere = {
      tension: normalizedScores.tension,
      joy: normalizedScores.joy,
      sadness: normalizedScores.sadness,
      calmness: normalizedScores.calmness,
      mystery: normalizedScores.mystery,
      romance: normalizedScores.romance,
      dominantLabel: dominantKey,
      confidence: Math.round(confidence * 100) / 100,
      description: dominantDef ? `${dominantDef.label}：${dominantDef.description}` : '中性',
    }

    log('INFO', 'atmosphere_mapped', {
      dominant: result.dominantLabel,
      confidence: result.confidence,
      tension: result.tension.toFixed(2),
      joy: result.joy.toFixed(2),
      sadness: result.sadness.toFixed(2),
      calmness: result.calmness.toFixed(2),
      mystery: result.mystery.toFixed(2),
      romance: result.romance.toFixed(2),
      audioEnergy: features.energy.toFixed(2),
      audioPitch: features.pitchHz,
      speechRate: features.speechRate.toFixed(1),
    })

    return result
  }

  // ── 各维度计算 ──

  /**
   * 紧张度：高能量 + 高能量波动 + 高音调 + 音调跳跃大 + 高过零率
   */
  private computeTension(f: AudioFeatures): number {
    const w = this.weights.tension
    return (
      w.energy * this.sigmoid(f.energy, 0.4, 5) +
      w.energyVariance * this.sigmoid(f.energyVariance, 0.3, 8) +
      w.pitch * this.sigmoid(f.pitchHz / 300, 0.3, 5) +
      w.pitchVariance * this.sigmoid(f.pitchVariance / 100, 0.3, 5) +
      w.zcr * this.sigmoid(f.avgZeroCrossingRate, 0.05, 40)
    )
  }

  /**
   * 欢乐度：中高能量 + 中高音调 + 低过零率 + 低静音比 + 多语音段
   */
  private computeJoy(f: AudioFeatures): number {
    const w = this.weights.joy
    // 能量在中高区域最佳：过高（喊叫）或过低（耳语）都不像欢乐
    const energyScore = this.gaussian(f.energy, 0.5, 0.2)
    return (
      w.energy * energyScore +
      w.pitch * this.sigmoid(f.pitchHz / 250, 0.3, 5) +
      w.zcr * this.sigmoid(-f.avgZeroCrossingRate, -0.05, 40) +
      w.silence * this.sigmoid(-f.silenceRatio, -0.3, 5) +
      w.segments * this.sigmoid(f.voiceSegmentCount / 15, 0.3, 5)
    )
  }

  /**
   * 悲伤度：低能量 + 低音调 + 单调语调 + 高静音比
   */
  private computeSadness(f: AudioFeatures): number {
    const w = this.weights.sadness
    return (
      w.energy * this.sigmoid(-f.energy, -0.2, 5) +
      w.pitch * this.sigmoid(-f.pitchHz / 200, -0.2, 5) +
      w.pitchVariance * this.sigmoid(-f.pitchVariance / 50, -0.3, 5) +
      w.silence * this.sigmoid(f.silenceRatio, 0.3, 5) +
      w.energyVariance * this.sigmoid(-f.energyVariance, -0.2, 8)
    )
  }

  /**
   * 平静度：中低能量 + 低能量波动 + 低过零率 + 低音调范围 + 能量趋势平稳
   */
  private computeCalmness(f: AudioFeatures): number {
    const w = this.weights.calmness
    return (
      w.energy * this.sigmoid(-f.energy, -0.3, 5) +
      w.energyVariance * this.sigmoid(-f.energyVariance, -0.2, 8) +
      w.zcr * this.sigmoid(-f.avgZeroCrossingRate, -0.03, 40) +
      w.pitchRange * this.sigmoid(-f.pitchRange / 100, -0.2, 5) +
      w.energyTrend * this.sigmoid(f.energyTrend, 0.4, 5)
    )
  }

  /**
   * 神秘度：低能量 + 低音调 + 高静音比 + 低能量波动 + 低语速
   */
  private computeMystery(f: AudioFeatures): number {
    const w = this.weights.mystery
    return (
      w.energy * this.sigmoid(-f.energy, -0.25, 5) +
      w.pitch * this.sigmoid(-f.pitchHz / 200, -0.2, 5) +
      w.silence * this.sigmoid(f.silenceRatio, 0.4, 5) +
      w.energyVariance * this.sigmoid(-f.energyVariance, -0.15, 8) +
      w.speechRate * this.sigmoid(-f.speechRate / 10, -0.3, 5)
    )
  }

  /**
   * 浪漫度：中能量 + 中音调 + 低过零率 + 低静音比 + 语调变化适度
   */
  private computeRomance(f: AudioFeatures): number {
    const w = this.weights.romance
    const energyScore = this.gaussian(f.energy, 0.4, 0.2)
    const pitchScore = this.gaussian(f.pitchHz / 250, 0.45, 0.15)
    return (
      w.energy * energyScore +
      w.pitch * pitchScore +
      w.zcr * this.sigmoid(-f.avgZeroCrossingRate, -0.03, 40) +
      w.silence * this.sigmoid(-f.silenceRatio, -0.3, 5) +
      w.pitchRange * this.gaussian(f.pitchRange / 100, 0.3, 0.15)
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
  private normalizeScores(raw: Record<string, number>): Record<string, number> {
    const keys = Object.keys(raw)
    // 找出最大值用于缩放（避免指数爆炸）
    const maxVal = Math.max(0.001, ...Object.values(raw))
    const expValues = keys.map((k) => Math.exp(raw[k] - maxVal))
    const sumExp = expValues.reduce((a, b) => a + b, 0) || 1

    const normalized: Record<string, number> = {}
    for (let i = 0; i < keys.length; i++) {
      normalized[keys[i]] = Math.round((expValues[i] / sumExp) * 100) / 100
    }
    return normalized
  }

  /** 找出得分最高的维度 */
  private findDominant(scores: Record<string, number>): string {
    let best = 'calmness'
    let bestScore = -1
    for (const [key, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score
        best = key
      }
    }
    return best
  }

  /** 合并权重（用户权重覆盖默认对应字段） */
  private mergeWeights(defaults: AtmosphereMappingWeights, overrides: Partial<AtmosphereMappingWeights>): AtmosphereMappingWeights {
    const result = { ...defaults }
    for (const dim of Object.keys(defaults) as Array<keyof AtmosphereMappingWeights>) {
      if (overrides[dim]) {
        ;(result as Record<string, unknown>)[dim] = { ...defaults[dim], ...overrides[dim] }
      }
    }
    return result
  }
}

/** 全局单例 */
export const atmosphereMapper = new AtmosphereMapper()
