/**
 * pipeline/stages/TtsParameterStage — TTS 参数映射 Stage
 *
 * 将上游 EmotionAnalysisStage 的情感分析结果 + MemoryContextStage 的
 * 上下文信息映射为实际的 TTS 合成参数（voice / rate / pitch / model）。
 *
 * 复用项目的 EmotionTtsParams 和 ContextVoiceConfig 类型体系，
 * 输出可直接被 PiperSynthesisStage 消费。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { StageExecutor, StageOutput, StageExecutionContext } from '@akemi-mio/intelligence/pipeline/types'

/** 情感标签 → 语速调整（百分比） */
const LABEL_RATE_MAP: Record<string, number> = {
  happy: +5,
  sad: -5,
  angry: -3,
  calm: 0,
  anxious: -8,
  neutral: 0,
}

/** 情感标签 → 音调调整（Hz） */
const LABEL_PITCH_MAP: Record<string, number> = {
  happy: +4,
  sad: -4,
  angry: -3,
  calm: 0,
  anxious: -5,
  neutral: 0,
}

/** 情感标签 → Piper 模型推荐 */
const LABEL_MODEL_MAP: Record<string, string> = {
  happy: 'zh_CN-huayan-medium',
  sad: 'zh_CN-ling_ling-medium',
  angry: 'zh_CN-tx_mati-medium',
  calm: 'zh_CN-huayan-medium',
  anxious: 'zh_CN-ling_ling-medium',
  neutral: 'zh_CN-huayan-medium',
}

/** 情感标签中文名 */
const LABEL_CN: Record<string, string> = {
  happy: '开心',
  sad: '悲伤',
  angry: '生气',
  calm: '平静',
  anxious: '焦虑',
  neutral: '中性',
}

export class TtsParameterStage implements StageExecutor {
  readonly stageType = 'tts-params'

  async execute(config: Record<string, unknown>, ctx: StageExecutionContext): Promise<StageOutput> {
    const t0 = Date.now()
    const defaultVoice = (config.defaultVoice as string) ?? 'zh_CN-huayan-medium'
    const emotionWeight = (config.emotionWeight as number) ?? 0.3

    // 上游数据
    const emotionStage = ctx.inputs.get('emotion-analysis')
    const memoryStage = ctx.inputs.get('memory-context')

    const dominantLabel: string = (emotionStage?.data?.dominantLabel as string) ?? 'neutral'
    const rateDeltaFromEmotion: number = (emotionStage?.data?.rateDelta as number) ?? 0
    const pitchDeltaFromEmotion: number = (emotionStage?.data?.pitchDelta as number) ?? 0
    const trend: string = (emotionStage?.data?.trend as string) ?? 'stable'
    const interestTopics: string[] = (memoryStage?.data?.interestTopics as string[]) ?? []

    // 基础语速/音调（可根据配置覆盖）
    const baseRate = (config.baseRate as number) ?? 10 // +10%
    const basePitch = (config.basePitch as number) ?? 8 // +8Hz

    // 混合计算
    const blendedRate = Math.round(baseRate * (1 - emotionWeight) + (baseRate + rateDeltaFromEmotion) * emotionWeight)
    const blendedPitch = Math.round(basePitch * (1 - emotionWeight) + (basePitch + pitchDeltaFromEmotion) * emotionWeight)

    // 夹到有效范围
    const finalRate = Math.max(-50, Math.min(50, blendedRate))
    const finalPitch = Math.max(-20, Math.min(20, blendedPitch))

    // 模型选择
    const model = LABEL_MODEL_MAP[dominantLabel] ?? defaultVoice

    // Piper 语速/音调因子
    const piperSpeed = 1.0 + rateDeltaFromEmotion / 50
    const piperPitch = 1.0 + pitchDeltaFromEmotion / 30

    const labelCN = LABEL_CN[dominantLabel] ?? '中性'
    const trendCN: Record<string, string> = {
      rising: '↑上升',
      falling: '↓回落',
      stable: '→平稳',
    }

    const output: Record<string, unknown> = {
      // edge-tts 参数
      voice: defaultVoice,
      rate: `${finalRate >= 0 ? '+' : ''}${finalRate}%`,
      pitch: `${finalPitch >= 0 ? '+' : ''}${finalPitch}Hz`,
      // Piper 参数
      model,
      piperSpeed: Math.max(0.5, Math.min(2.0, piperSpeed)),
      piperPitch: Math.max(0.5, Math.min(2.0, piperPitch)),
      // 元信息
      label: `${LABEL_CN[dominantLabel] || '中性'}·${trendCN[trend] || '平稳'}`,
      dominantEmotion: dominantLabel,
      emotionTrend: trend,
      interestTopics,
      // 原始调整值
      rateDeltaUsed: rateDeltaFromEmotion,
      pitchDeltaUsed: pitchDeltaFromEmotion,
    }

    log('INFO', 'pipeline_tts_params_done', {
      model,
      rate: output.rate,
      pitch: output.pitch,
      emotion: dominantLabel,
      trend,
      piperSpeed: output.piperSpeed,
      durationMs: Date.now() - t0,
    })

    return {
      stageId: 'tts-params',
      data: output,
      durationMs: Date.now() - t0,
      fromCache: false,
      timestamp: Date.now(),
    }
  }
}
