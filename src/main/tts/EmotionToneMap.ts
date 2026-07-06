/**
 * EmotionToneMap — 情感→TTS音色/语调映射表
 *
 * 根据情感极性（正面/负面/中性）和内容类型，选择合适的：
 * - edge-tts 语音角色 (voice)
 * - 语速 (rate: +X% / -X%)
 * - 音调 (pitch: +XHz / -XHz)
 *
 * edge-tts 可用中文语音角色：
 *   zh-CN-XiaoxiaoNeural   女声，活泼开朗，适合正面/日常
 *   zh-CN-XiaoyiNeural     女声，温柔亲切，适合温馨/关心内容
 *   zh-CN-YunxiNeural      男声，温暖稳重，适合中性/信息播报
 *   zh-CN-YunjianNeural    男声，严肃沉稳，适合负面/正式内容
 *   zh-CN-YunyangNeural    男声，专业播报风，适合新闻/公告
 */

import type { SentimentResult, SentimentPolarity, EmotionTtsParams } from './types'

// ══════════════════════════════════════════
//  默认参数（回退）
// ══════════════════════════════════════════

const DEFAULT_PARAMS: EmotionTtsParams = {
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+10%',
  pitch: '+8Hz',
  label: '默认/日常',
}

// ══════════════════════════════════════════
//  情感→音色映射表
// ══════════════════════════════════════════

/**
 * 主映射表：
 *   key = `${polarity}:${contentType}`
 *
 * 设计原则：
 *   正面 → Xiaoxiao (活泼女声)，语速稍快，音调偏高
 *   负面 → Yunjian (沉稳男声)，语速稍慢，音调偏低
 *   中性 → Yunxi (温暖男声) 或 Xiaoxiao，正常语速
 */
const TONE_MAP: Record<string, EmotionTtsParams> = {
  // ── 正面情感 ──
  'positive:weather': {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+18%',
    pitch: '+12Hz',
    label: '欢快·天气',
  },
  'positive:success': {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+15%',
    pitch: '+10Hz',
    label: '欣喜·成功',
  },
  'positive:news': {
    voice: 'zh-CN-YunyangNeural',
    rate: '+12%',
    pitch: '+6Hz',
    label: '振奋·新闻',
  },
  'positive:chat': {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+12%',
    pitch: '+8Hz',
    label: '愉快·闲聊',
  },
  'positive:data': {
    voice: 'zh-CN-YunxiNeural',
    rate: '+8%',
    pitch: '+5Hz',
    label: '积极·数据',
  },
  'positive:code': {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+10%',
    pitch: '+6Hz',
    label: '顺畅·代码',
  },

  // ── 负面情感 ──
  'negative:error': {
    voice: 'zh-CN-YunjianNeural',
    rate: '-5%',
    pitch: '-4Hz',
    label: '沉稳·报错',
  },
  'negative:weather': {
    voice: 'zh-CN-YunjianNeural',
    rate: '-8%',
    pitch: '-6Hz',
    label: '低沉·坏天气',
  },
  'negative:news': {
    voice: 'zh-CN-YunjianNeural',
    rate: '-5%',
    pitch: '-3Hz',
    label: '凝重·新闻',
  },
  'negative:chat': {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-3%',
    pitch: '-2Hz',
    label: '温柔·安慰',
  },
  'negative:data': {
    voice: 'zh-CN-YunjianNeural',
    rate: '-3%',
    pitch: '-3Hz',
    label: '沉重·数据',
  },
  'negative:code': {
    voice: 'zh-CN-YunjianNeural',
    rate: '-3%',
    pitch: '-3Hz',
    label: '严肃·代码',
  },

  // ── 中性情感 ──
  'neutral:weather': {
    voice: 'zh-CN-YunxiNeural',
    rate: '+5%',
    pitch: '+3Hz',
    label: '平和·天气',
  },
  'neutral:news': {
    voice: 'zh-CN-YunyangNeural',
    rate: '+3%',
    pitch: '+0Hz',
    label: '客观·新闻',
  },
  'neutral:data': {
    voice: 'zh-CN-YunxiNeural',
    rate: '+5%',
    pitch: '+2Hz',
    label: '平稳·数据',
  },
  'neutral:info': {
    voice: 'zh-CN-YunxiNeural',
    rate: '+8%',
    pitch: '+4Hz',
    label: '平和·信息',
  },
  'neutral:code': {
    voice: 'zh-CN-YunxiNeural',
    rate: '+5%',
    pitch: '+3Hz',
    label: '中性·代码',
  },
  'neutral:chat': {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+8%',
    pitch: '+5Hz',
    label: '自然·闲聊',
  },
}

// ══════════════════════════════════════════
//  情感→参数查询
// ══════════════════════════════════════════

export class EmotionToneMap {
  /**
   * 根据情感分析结果获取 TTS 参数
   *
   * 匹配优先级：
   *   1. polarity + contentType 精确匹配
   *   2. polarity + 'chat' 回退
   *   3. 默认参数
   */
  getParams(result: SentimentResult): EmotionTtsParams {
    const { polarity, contentType } = result

    // 1. 精确匹配
    const exactKey = `${polarity}:${contentType}`
    if (TONE_MAP[exactKey]) return TONE_MAP[exactKey]

    // 2. 同极性通用回退
    const polarityFallback = `${polarity}:chat`
    if (TONE_MAP[polarityFallback]) return TONE_MAP[polarityFallback]

    // 3. 默认参数
    return DEFAULT_PARAMS
  }

  /**
   * 将 polarity 和 contentType 分开传入（便利方法）
   */
  getByPolarityAndType(polarity: SentimentPolarity, contentType: string): EmotionTtsParams {
    return this.getParams({ polarity, contentType, score: 0, matchedWords: [] })
  }

  /**
   * 检查当前参数是否与目标不同（用于避免不必要的 TTS 进程重启）
   */
  isDifferent(a: EmotionTtsParams, b: EmotionTtsParams): boolean {
    return a.voice !== b.voice || a.rate !== b.rate || a.pitch !== b.pitch
  }

  /**
   * 获取所有支持的映射（供调试/UI 展示）
   */
  getAllMappings(): Array<{ key: string; params: EmotionTtsParams }> {
    return Object.entries(TONE_MAP).map(([key, params]) => ({ key, params }))
  }
}

/** 全局单例 */
export const emotionToneMap = new EmotionToneMap()
