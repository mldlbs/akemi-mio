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

import { log } from '../logger/Logger'
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
//  紧急度阈值
// ══════════════════════════════════════════

/**
 * 紧急度阈值：超过此值启用紧急（urgent）映射
 */
const URGENCY_THRESHOLD = 0.4

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

  // ── 紧急内容 ──
  // 紧急不分极性，紧凑节奏优先
  'urgent:error': {
    voice: 'zh-CN-YunjianNeural',
    rate: '+12%',
    pitch: '+4Hz',
    label: '紧迫·告警',
  },
  'urgent:success': {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+20%',
    pitch: '+12Hz',
    label: '急促·成功',
  },
  'urgent:chat': {
    voice: 'zh-CN-YunyangNeural',
    rate: '+18%',
    pitch: '+6Hz',
    label: '紧凑·通知',
  },
  'urgent:weather': {
    voice: 'zh-CN-YunjianNeural',
    rate: '+15%',
    pitch: '+5Hz',
    label: '紧急·天气',
  },
  'urgent:news': {
    voice: 'zh-CN-YunyangNeural',
    rate: '+15%',
    pitch: '+5Hz',
    label: '加急·新闻',
  },
  'urgent:code': {
    voice: 'zh-CN-YunjianNeural',
    rate: '+15%',
    pitch: '+4Hz',
    label: '急修·代码',
  },
  'urgent:data': {
    voice: 'zh-CN-YunyangNeural',
    rate: '+12%',
    pitch: '+4Hz',
    label: '紧急·数据',
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
   * 用户自定义映射覆盖。
   * key = `${polarity}:${contentType}`，value = 用户覆盖的 TTS 参数。
   * 优先级高于 TONE_MAP 内置映射。
   */
  private userOverrides: Map<string, EmotionTtsParams> = new Map()

  /**
   * 根据情感分析结果获取 TTS 参数
   *
   * 匹配优先级：
   *   1. 用户自定义覆盖（userOverrides）
   *   2. urgency >= URGENCY_THRESHOLD 时，urgent:contentType 或 urgent:chat 回退
   *   3. polarity + contentType 精确匹配
   *   4. polarity + 'chat' 回退
   *   5. 默认参数
   */
  getParams(result: SentimentResult): EmotionTtsParams {
    const { polarity, contentType, urgency } = result

    // 1. 用户自定义覆盖（key 格式同内置映射）
    const exactKey = `${polarity}:${contentType}`
    const userOverride = this.userOverrides.get(exactKey)
    if (userOverride) return userOverride

    // 2. 紧急度触发紧急映射
    if (urgency >= URGENCY_THRESHOLD) {
      const urgentKey = `urgent:${contentType}`
      if (TONE_MAP[urgentKey]) return TONE_MAP[urgentKey]
      const urgentFallback = 'urgent:chat'
      if (TONE_MAP[urgentFallback]) return TONE_MAP[urgentFallback]
    }

    // 3. 精确匹配（内置映射）
    if (TONE_MAP[exactKey]) return TONE_MAP[exactKey]

    // 4. 同极性通用回退
    const polarityFallback = `${polarity}:chat`
    if (TONE_MAP[polarityFallback]) return TONE_MAP[polarityFallback]

    // 5. 默认参数
    return DEFAULT_PARAMS
  }

  /**
   * 将 polarity 和 contentType 分开传入（便利方法）
   */
  getByPolarityAndType(polarity: SentimentPolarity, contentType: string): EmotionTtsParams {
    return this.getParams({ polarity, contentType, score: 0, matchedWords: [], urgency: 0 })
  }

  // ══════════════════════════════════════════
  //  用户自定义映射覆盖
  // ══════════════════════════════════════════

  /**
   * 设置用户自定义情感映射覆盖。
   *
   * @param key 映射键，格式为 `${polarity}:${contentType}`，如 `positive:chat`、`negative:error`
   * @param params 覆盖的 TTS 参数
   */
  setUserOverride(key: string, params: EmotionTtsParams): void {
    this.userOverrides.set(key, { ...params })
    log('INFO', 'emotion_tone_user_override_set', {
      key,
      voice: params.voice,
      rate: params.rate,
      pitch: params.pitch,
      label: params.label,
    })
  }

  /**
   * 移除指定映射的用户覆盖，恢复为内置映射。
   */
  removeUserOverride(key: string): boolean {
    const existed = this.userOverrides.delete(key)
    if (existed) {
      log('INFO', 'emotion_tone_user_override_removed', { key })
    }
    return existed
  }

  /**
   * 获取指定映射的用户覆盖（如不存在则返回 undefined）
   */
  getUserOverride(key: string): EmotionTtsParams | undefined {
    return this.userOverrides.get(key)
  }

  /**
   * 获取所有用户自定义覆盖
   */
  getAllUserOverrides(): Array<{ key: string; params: EmotionTtsParams }> {
    return Array.from(this.userOverrides.entries()).map(([key, params]) => ({ key, params }))
  }

  /**
   * 清除所有用户自定义覆盖
   */
  clearUserOverrides(): void {
    this.userOverrides.clear()
    log('INFO', 'emotion_tone_user_overrides_cleared')
  }

  /**
   * 批量设置用户自定义映射覆盖
   *
   * @param overrides 覆盖映射表
   */
  setUserOverrides(overrides: Record<string, EmotionTtsParams>): void {
    for (const [key, params] of Object.entries(overrides)) {
      this.userOverrides.set(key, { ...params })
    }
    log('INFO', 'emotion_tone_user_overrides_batch_set', {
      count: Object.keys(overrides).length,
    })
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
