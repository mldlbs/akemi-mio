/**
 * AsrAcousticEnvironmentClassifier — 声学环境分类与参数映射
 *
 * 基于 AudioFeatureExtractor 提取的韵律特征，
 * 将当前音频环境分类，并推荐对应的 ASR 参数调整方案。
 *
 * 环境类型：
 * - quiet: 安静环境，标准参数
 * - noisy: 背景噪声，需要降低初始提示权重、增强噪声过滤
 * - far_field: 远场/小声说话，需要提高增益
 * - music_bg: 背景音乐干扰，需要偏执于语音频率
 * - reverberant: 混响环境（如空旷房间）
 *
 * 集成点：
 * - AsrAcousticOptimizationExecutor.collect() 调用 classify() 获取环境类型
 * - AsrService.setConversationContext() 可选择性应用环境参数
 */

import type { AudioFeatures } from './types'
import { log } from '@akemi-mio/core/logger/Logger'

// =============================================================================
// 环境类型
// =============================================================================

export type AcousticEnvironment =
  | 'quiet' // 安静环境
  | 'noisy' // 背景噪声
  | 'far_field' // 远场/小声
  | 'music_bg' // 背景音乐
  | 'reverberant' // 混响
  | 'unknown' // 无法分类

/** 环境中文标签 */
export const ENV_LABELS: Record<AcousticEnvironment, string> = {
  quiet: '安静环境',
  noisy: '噪声环境',
  far_field: '远场/小声',
  music_bg: '背景音乐',
  reverberant: '混响环境',
  unknown: '未知环境',
}

// =============================================================================
// 环境参数建议
// =============================================================================

/**
 * ASR 参数调整方案（与引擎无关的抽象配置）。
 * 各 Executor 根据自身引擎能力选择实现哪些调整。
 */
export interface AsrEnvironmentParams {
  /** 环境类型 */
  environment: AcousticEnvironment

  /** 建议的 VAD 能量阈值（越高过滤越严格） */
  suggestedVadThreshold: number

  /** 初始提示权重因子 (0–2)：>1 强化提示，<1 弱化提示 */
  promptWeight: number

  /** 热词权重因子 (0–2) */
  hotwordWeight: number

  /** 是否应启用额外噪声过滤 */
  noiseFilter: boolean

  /** 建议的 initial_prompt 前缀描述 */
  promptPrefix: string

  /** 置信度阈值调整偏移 (0–1)：环境越差偏移越大 */
  confidenceThresholdOffset: number
}

// =============================================================================
// 环境分类器
// =============================================================================

export class AsrAcousticEnvironmentClassifier {
  /**
   * 从音频特征分类当前声学环境。
   *
   * @param features AudioFeatureExtractor 提取的特征
   * @returns 环境类型与置信度
   */
  classify(features: AudioFeatures): {
    environment: AcousticEnvironment
    confidence: number
    params: AsrEnvironmentParams
  } {
    const env = this.determineEnvironment(features)
    const confidence = this.estimateConfidence(features, env)
    const params = this.buildParams(env)

    log('INFO', 'asr_env_classified', {
      environment: env,
      confidence: Math.round(confidence * 100) / 100,
      energy: features.energy.toFixed(3),
      silenceRatio: features.silenceRatio.toFixed(3),
      zcr: features.avgZeroCrossingRate.toFixed(3),
      pitchHz: features.pitchHz,
      speechRate: features.speechRate.toFixed(2),
    })

    return { environment: env, confidence, params }
  }

  /**
   * 获取适用于当前环境的 initial_prompt 修饰。
   * 用于在 AsrService 中动态调整 initial_prompt。
   */
  getPromptModifier(environment: AcousticEnvironment): string {
    switch (environment) {
      case 'noisy':
        return '（背景有噪声，请忽略杂音，专注识别清晰的人声）'
      case 'far_field':
        return '（说话人在远处或声音很小，请尽量捕捉微弱人声）'
      case 'music_bg':
        return '（背景有音乐，请区分人声和音乐，只识别说话内容）'
      case 'reverberant':
        return '（环境有回音，请忽略重叠的回声，识别主要语音）'
      default:
        return ''
    }
  }

  // ── 环境判定 ──

  private determineEnvironment(features: AudioFeatures): AcousticEnvironment {
    const { energy, silenceRatio, avgZeroCrossingRate: zcr, pitchHz, speechRate } = features

    // 特征不明显 → 未知
    if (energy < 0.01 && silenceRatio > 0.95) {
      return 'unknown'
    }

    // 安静环境：中等能量、低 ZCR、低静音比、有稳定的基频
    if (
      energy >= 0.1 &&
      energy <= 0.6 &&
      zcr < 0.06 &&
      silenceRatio < 0.4 &&
      pitchHz >= 80 &&
      pitchHz <= 300 &&
      speechRate >= 2 &&
      speechRate <= 10
    ) {
      return 'quiet'
    }

    // 远场/小声：低能量、可能有基频、低 ZCR
    if (energy < 0.1 && zcr < 0.05 && (pitchHz === 0 || (pitchHz >= 80 && pitchHz <= 250)) && silenceRatio > 0.3) {
      return 'far_field'
    }

    // 背景音乐：中等偏高 ZCR、中高能量、可能有宽泛的基频变化
    if (zcr >= 0.06 && zcr <= 0.15 && energy >= 0.2 && (pitchHz === 0 || pitchHz > 150) && silenceRatio < 0.3) {
      return 'music_bg'
    }

    // 噪声环境：高 ZCR、能量变化大、基频不稳定或缺失
    if (zcr > 0.08 && (pitchHz === 0 || (pitchHz > 0 && pitchHz < 60) || pitchHz > 400) && (energy < 0.15 || silenceRatio > 0.5)) {
      return 'noisy'
    }

    // 混响环境：语音段多但能量适中、ZCR 中等
    if (
      zcr >= 0.04 &&
      zcr <= 0.1 &&
      energy >= 0.05 &&
      energy <= 0.4 &&
      silenceRatio >= 0.3 &&
      silenceRatio <= 0.6 &&
      features.voiceSegmentCount > 3
    ) {
      return 'reverberant'
    }

    // 默认安静（特征在合理范围内）
    if (energy >= 0.05 && energy <= 0.7 && zcr < 0.1) {
      return 'quiet'
    }

    return 'unknown'
  }

  /**
   * 环境分类置信度估计。
   * 特征越典型、极端，置信度越高。
   */
  private estimateConfidence(features: AudioFeatures, env: AcousticEnvironment): number {
    switch (env) {
      case 'quiet':
        // 能量在理想范围内越居中、ZCR 越低 → 置信度越高
        return Math.min(1, (1 - features.avgZeroCrossingRate * 5) * 0.8 + 0.2)

      case 'noisy':
        // ZCR 越高、基频越异常 → 置信度越高
        return Math.min(1, features.avgZeroCrossingRate * 3 + 0.2)

      case 'far_field':
        // 能量越低、静音比越高 → 置信度越高
        return Math.min(1, (1 - features.energy * 5) * 0.6 + features.silenceRatio * 0.3 + 0.1)

      case 'music_bg':
        // ZCR 和能量联合评估
        return Math.min(1, features.avgZeroCrossingRate * 2 + features.energy * 0.5 + 0.1)

      case 'reverberant':
        return 0.6 // 混响检测置信度一般

      default:
        return 0.3 // 未知环境，低置信
    }
  }

  /**
   * 根据环境类型构建参数建议。
   */
  private buildParams(env: AcousticEnvironment): AsrEnvironmentParams {
    switch (env) {
      case 'quiet':
        return {
          environment: 'quiet',
          suggestedVadThreshold: 0.015,
          promptWeight: 1.0,
          hotwordWeight: 1.0,
          noiseFilter: false,
          promptPrefix: '（安静环境，标准识别参数）',
          confidenceThresholdOffset: 0,
        }

      case 'noisy':
        return {
          environment: 'noisy',
          suggestedVadThreshold: 0.03, // 升高 VAD 阈值，过滤噪声
          promptWeight: 1.3, // 增强初始提示引导
          hotwordWeight: 1.5, // 增强热词权重
          noiseFilter: true,
          promptPrefix: '（背景噪声，请专注识别清晰的人声）',
          confidenceThresholdOffset: 0.1, // 噪声环境适当放宽置信度要求
        }

      case 'far_field':
        return {
          environment: 'far_field',
          suggestedVadThreshold: 0.008, // 降低 VAD 阈值捕捉弱信号
          promptWeight: 1.2,
          hotwordWeight: 1.2,
          noiseFilter: false,
          promptPrefix: '（远场小声，请尽量捕捉微弱人声）',
          confidenceThresholdOffset: 0.15, // 远场大量漏识别，放宽
        }

      case 'music_bg':
        return {
          environment: 'music_bg',
          suggestedVadThreshold: 0.02,
          promptWeight: 1.4, // 强提示引导模型关注语音
          hotwordWeight: 1.3,
          noiseFilter: true,
          promptPrefix: '（背景有音乐，请区分人声与音乐，只识别说话内容）',
          confidenceThresholdOffset: 0.1,
        }

      case 'reverberant':
        return {
          environment: 'reverberant',
          suggestedVadThreshold: 0.02,
          promptWeight: 1.2,
          hotwordWeight: 1.1,
          noiseFilter: true,
          promptPrefix: '（环境有回音，请忽略回声，识别主要语音）',
          confidenceThresholdOffset: 0.08,
        }

      default: // unknown
        return {
          environment: 'unknown',
          suggestedVadThreshold: 0.015,
          promptWeight: 1.0,
          hotwordWeight: 1.0,
          noiseFilter: false,
          promptPrefix: '',
          confidenceThresholdOffset: 0,
        }
    }
  }
}

// =============================================================================
// 单例
// =============================================================================

export const acousticEnvClassifier = new AsrAcousticEnvironmentClassifier()
