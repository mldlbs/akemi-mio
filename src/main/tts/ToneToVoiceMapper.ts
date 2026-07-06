/**
 * ToneToVoiceMapper — 用户语气画像 → TTS 语音参数映射
 *
 * 根据用户语气画像（UserToneProfile）选择最匹配的 TTS 语音模型和参数。
 * 与 EmotionToneMap 的区别：
 *   EmotionToneMap 根据 **AI 回复内容** 的情感极性映射语音参数（单次、实时）。
 *   ToneToVoiceMapper 根据 **用户沟通风格** 映射基线语音（持久化、个性化）。
 *
 * 两者协同工作：
 *   1. ToneToVoiceMapper 选择基线语音模型和默认参数
 *   2. EmotionToneMap 在基线之上根据回复内容微调 rate/pitch
 *
 * 支持的 TTS 引擎：
 *   - edge-tts: 通过 voice 角色名切换（5 种中文语音角色）
 *   - PiperTTS: 通过 model path + rate/pitch 参数调节（需多模型文件）
 *
 * edge-tts 可用中文语音角色：
 *   zh-CN-XiaoxiaoNeural   女声，活泼开朗  → lively / casual
 *   zh-CN-XiaoyiNeural     女声，温柔亲切  → warm
 *   zh-CN-YunxiNeural      男声，温暖稳重  → calm
 *   zh-CN-YunjianNeural    男声，严肃沉稳  → formal
 *   zh-CN-YunyangNeural    男声，专业播报  → professional
 */

import { log } from '../logger/Logger'
import type { UserToneProfile, ToneLabel, EmotionTtsParams } from './types'

// ══════════════════════════════════════════
//  语气 → 语音映射表 (edge-tts)
// ══════════════════════════════════════════

/**
 * 每个语气标签对应一组 edge-tts 语音参数。
 *
 * 设计原则：
 *   lively   → Xiaoxiao (活泼女声)，语速稍快，音调偏高
 *   calm     → Yunxi (温暖男声)，语速适中，音调平稳
 *   formal   → Yunjian (沉稳男声)，语速稍慢，音调偏低
 *   casual   → Xiaoxiao (活泼女声)，语速偏快，音调自然
 *   warm     → Xiaoyi (温柔女声)，语速偏慢，音调柔和
 *   professional → Yunyang (专业播报)，语速标准，音调正中
 */
const TONE_VOICE_MAP: Record<ToneLabel, EmotionTtsParams> = {
  lively: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+18%',
    pitch: '+10Hz',
    label: '活泼·用户偏好',
  },
  calm: {
    voice: 'zh-CN-YunxiNeural',
    rate: '+5%',
    pitch: '+2Hz',
    label: '沉稳·用户偏好',
  },
  formal: {
    voice: 'zh-CN-YunjianNeural',
    rate: '-3%',
    pitch: '-2Hz',
    label: '正式·用户偏好',
  },
  casual: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+12%',
    pitch: '+6Hz',
    label: '随意·用户偏好',
  },
  warm: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+3%',
    pitch: '+4Hz',
    label: '温柔·用户偏好',
  },
  professional: {
    voice: 'zh-CN-YunyangNeural',
    rate: '+5%',
    pitch: '+0Hz',
    label: '专业·用户偏好',
  },
}

// ══════════════════════════════════════════
//  PiperTTS 模型映射
// ══════════════════════════════════════════

/**
 * PiperTTS 中文模型选择建议。
 * 实际切换需要相应 .onnx + .json 模型文件存在于 models/piper/ 目录。
 *
 * 推荐模型（来自 Piper 官方仓库）：
 *   zh_CN-huayan-medium   — 女声，中等音色，通用性好
 *   zh_CN-ling_ling-medium — 女声，甜美风格
 *   zh_CN-tx_mati-medium   — 男声，稳重
 */
export interface PiperModelSuggestion {
  /** 推荐模型文件名（不含扩展名） */
  modelName: string
  /** 语速因子 (0.5–2.0)，Piper --length-scale */
  lengthScale: number
  /** 音高偏移 (0.5–2.0)，Piper --noise-scale 间接影响 */
  noiseScale: number
  /** 句间停顿 (秒)，Piper --sentence-silence */
  sentenceSilence: number
}

const PIPER_TONE_MAP: Record<ToneLabel, PiperModelSuggestion> = {
  lively: {
    modelName: 'zh_CN-huayan-medium',
    lengthScale: 0.85,
    noiseScale: 0.55,
    sentenceSilence: 0.15,
  },
  calm: {
    modelName: 'zh_CN-tx_mati-medium',
    lengthScale: 1.1,
    noiseScale: 0.45,
    sentenceSilence: 0.3,
  },
  formal: {
    modelName: 'zh_CN-tx_mati-medium',
    lengthScale: 1.05,
    noiseScale: 0.4,
    sentenceSilence: 0.25,
  },
  casual: {
    modelName: 'zh_CN-huayan-medium',
    lengthScale: 0.9,
    noiseScale: 0.5,
    sentenceSilence: 0.2,
  },
  warm: {
    modelName: 'zh_CN-ling_ling-medium',
    lengthScale: 1.0,
    noiseScale: 0.5,
    sentenceSilence: 0.25,
  },
  professional: {
    modelName: 'zh_CN-tx_mati-medium',
    lengthScale: 1.0,
    noiseScale: 0.45,
    sentenceSilence: 0.2,
  },
}

// ══════════════════════════════════════════
//  映射器
// ══════════════════════════════════════════

export class ToneToVoiceMapper {
  /**
   * 根据用户语气画像获取基线 TTS 语音参数。
   *
   * 当 confidence 很低（消息不足）时，回退到默认参数，
   * 避免不稳定的画像导致不自然的语音切换。
   */
  getBaselineParams(profile: UserToneProfile): EmotionTtsParams {
    // 冷启动/低置信度回退
    if (profile.confidence < 0.3) {
      log('DEBUG', 'tone_voice_mapper_fallback', {
        confidence: profile.confidence.toFixed(2),
        primaryTone: profile.primaryTone,
      })
      return TONE_VOICE_MAP['casual'] // 默认使用随意风格
    }

    const params = TONE_VOICE_MAP[profile.primaryTone]
    if (!params) {
      log('WARN', 'tone_voice_mapper_unknown_tone', { tone: profile.primaryTone })
      return TONE_VOICE_MAP['casual']
    }

    return { ...params }
  }

  /**
   * 获取 PiperTTS 推荐参数。
   * 在 USE_LOCAL_TTS 模式下使用。
   */
  getPiperParams(profile: UserToneProfile): PiperModelSuggestion {
    if (profile.confidence < 0.3) {
      return PIPER_TONE_MAP['casual']
    }
    return PIPER_TONE_MAP[profile.primaryTone] || PIPER_TONE_MAP['casual']
  }

  /**
   * 混合用户语气基线 + 内容情感参数，生成最终 TTS 参数。
   *
   * 混合策略：
   *   - voice: 由用户语气决定（不混合，避免频繁切换语音角色）
   *   - rate:  基线 70% + 内容情感 30%（内容情感作为微调）
   *   - pitch: 基线 70% + 内容情感 30%
   *
   * @param baseline 用户语气基线参数
   * @param emotion  内容情感参数（来自 EmotionToneMap）
   * @returns 混合后的最终参数
   */
  blend(baseline: EmotionTtsParams, emotion: EmotionTtsParams): EmotionTtsParams {
    // voice 由用户语气决定，保持一致性
    const voice = baseline.voice

    // rate 混合：解析百分比值，加权平均
    const baselineRate = parsePercent(baseline.rate)
    const emotionRate = parsePercent(emotion.rate)
    const blendedRate = Math.round(baselineRate * 0.7 + emotionRate * 0.3)
    const rate = formatPercent(blendedRate)

    // pitch 混合：解析 Hz 偏移，加权平均
    const baselinePitch = parseHz(baseline.pitch)
    const emotionPitch = parseHz(emotion.pitch)
    const blendedPitch = Math.round(baselinePitch * 0.7 + emotionPitch * 0.3)
    const pitch = formatHz(blendedPitch)

    // label 合并
    const label = `${baseline.label} + ${emotion.label}`

    return { voice, rate, pitch, label }
  }

  /**
   * 判断两个参数是否实质不同（避免不必要的 TTS 更新）。
   */
  isDifferent(a: EmotionTtsParams, b: EmotionTtsParams): boolean {
    return a.voice !== b.voice || a.rate !== b.rate || a.pitch !== b.pitch
  }

  /**
   * 获取所有语气→语音映射（供调试/UI展示）。
   */
  getAllMappings(): Array<{ tone: ToneLabel; params: EmotionTtsParams; piper: PiperModelSuggestion }> {
    return (Object.keys(TONE_VOICE_MAP) as ToneLabel[]).map((tone) => ({
      tone,
      params: TONE_VOICE_MAP[tone],
      piper: PIPER_TONE_MAP[tone],
    }))
  }
}

// ── 工具函数 ──

/** 解析 "+18%" / "-5%" 格式的百分比值 */
function parsePercent(rate: string): number {
  const match = rate.match(/^([+-]?\d+)%$/)
  return match ? parseInt(match[1], 10) : 0
}

/** 格式化为 "+18%" / "-5%" */
function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}%`
}

/** 解析 "+10Hz" / "-3Hz" 格式的 Hz 值 */
function parseHz(pitch: string): number {
  const match = pitch.match(/^([+-]?\d+)Hz$/)
  return match ? parseInt(match[1], 10) : 0
}

/** 格式化为 "+10Hz" / "-3Hz" */
function formatHz(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}Hz`
}

// ── 单例 ──

/** 全局单例 */
export const toneToVoiceMapper = new ToneToVoiceMapper()
