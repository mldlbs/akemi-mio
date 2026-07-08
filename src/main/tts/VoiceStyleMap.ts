/**
 * VoiceStyleMap — VoiceStyle → EmotionTtsParams 映射层
 *
 * 将语义级别的语音风格标签（如 'cheerful', 'serious'）映射到
 * 底层 TTS 引擎参数（edge-tts voice name, rate, pitch）。
 *
 * 与 EmotionToneMap（情感极性驱动）互补：
 *   - EmotionToneMap: 基于文本情感分析结果（positive/negative/neutral × contentType）
 *   - VoiceStyleMap:  基于回复类型/意图（notification, teaching, casual_chat...）
 *
 * ChatExecutor 优先使用 VoiceStyleMap（语义更准确），
 * 回退到 EmotionToneMap（基于文本情感）。
 */

import type { VoiceStyle, EmotionTtsParams, ReplyCategory } from './types'
import { REPLY_CATEGORY_STYLE_MAP } from './types'

// ══════════════════════════════════════════
//  VoiceStyle → EmotionTtsParams 映射
// ══════════════════════════════════════════

const STYLE_PARAMS_MAP: Record<VoiceStyle, EmotionTtsParams> = {
  cheerful: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+18%',
    pitch: '+12Hz',
    label: '欢快',
  },
  serious: {
    voice: 'zh-CN-YunjianNeural',
    rate: '-5%',
    pitch: '-4Hz',
    label: '严肃',
  },
  gentle: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-3%',
    pitch: '-2Hz',
    label: '温柔',
  },
  neutral: {
    voice: 'zh-CN-YunxiNeural',
    rate: '+5%',
    pitch: '+2Hz',
    label: '中性',
  },
  warm: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+5%',
    pitch: '+4Hz',
    label: '温暖',
  },
  energetic: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+25%',
    pitch: '+15Hz',
    label: '活力',
  },
  calm: {
    voice: 'zh-CN-YunxiNeural',
    rate: '+3%',
    pitch: '+0Hz',
    label: '沉稳',
  },
  playful: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+20%',
    pitch: '+10Hz',
    label: '俏皮',
  },
}

// ══════════════════════════════════════════
//  ReplyCategory → 内容类型关键词（用于自动分类）
// ══════════════════════════════════════════

const CATEGORY_KEYWORDS: Record<ReplyCategory, string[]> = {
  notification: ['通知', '提醒', '警告', '注意', '公告', '更新', '同步', '推送'],
  teaching: ['教', '学', '解释', '说明', '原理', '步骤', '教程', '指南', '帮助', '怎么', '如何'],
  casual_chat: ['闲聊', '聊天', '聊', '哈哈', '有趣', '好玩', '开心'],
  success: ['成功', '完成', '通过', '搞定', '好了', '已', '✅', 'ok'],
  error: ['失败', '错误', '异常', '崩溃', '超时', '无法', '❌', 'bug'],
  greeting: ['你好', '早上好', '晚上好', '晚安', '再见', '拜拜', '嗨', 'hello', 'hi'],
  analysis: ['分析', '统计', '数据', '报告', '趋势', '图表', '查询', '调查', '评估'],
  creative: ['创意', '灵感', '生成', '创作', '写', '画', '设计', '故事', '点子'],
}

// ══════════════════════════════════════════
//  VoiceStyleMap 类
// ══════════════════════════════════════════

export class VoiceStyleMap {
  /**
   * 根据 VoiceStyle 标签获取对应的 TTS 参数
   */
  getParams(style: VoiceStyle): EmotionTtsParams {
    return STYLE_PARAMS_MAP[style]
  }

  /**
   * 根据回复类别获取推荐的 VoiceStyle
   */
  getStyleForCategory(category: ReplyCategory): VoiceStyle {
    return REPLY_CATEGORY_STYLE_MAP[category]
  }

  /**
   * 根据回复类别获取对应的 TTS 参数（两步映射：category → style → params）
   */
  getParamsForCategory(category: ReplyCategory): EmotionTtsParams {
    const style = REPLY_CATEGORY_STYLE_MAP[category]
    return STYLE_PARAMS_MAP[style]
  }

  /**
   * 根据回复文本自动检测回复类别
   *
   * 通过关键词匹配推断文本属于哪种回复类型。
   * 返回匹配到的类别，若无匹配则返回 'casual_chat'。
   */
  detectCategory(text: string): ReplyCategory {
    if (!text || text.trim().length === 0) return 'casual_chat'
    const lower = text.toLowerCase()

    const scores: Partial<Record<ReplyCategory, number>> = {}
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      let score = 0
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          score += 1
          // 精确匹配加分
          if (new RegExp(`\\b${kw}\\b`, 'i').test(lower)) {
            score += 0.5
          }
        }
      }
      if (score > 0) scores[category as ReplyCategory] = score
    }

    // 取最高分
    let best: ReplyCategory = 'casual_chat'
    let bestScore = 0
    for (const [cat, s] of Object.entries(scores) as Array<[ReplyCategory, number]>) {
      if (s > bestScore) {
        bestScore = s
        best = cat
      }
    }

    return best
  }

  /**
   * 一键式：根据回复文本自动检测类别 → 映射风格 → 返回 TTS 参数
   */
  detectAndMap(text: string): { style: VoiceStyle; params: EmotionTtsParams; category: ReplyCategory } {
    const category = this.detectCategory(text)
    const style = REPLY_CATEGORY_STYLE_MAP[category]
    const params = STYLE_PARAMS_MAP[style]
    return { style, params, category }
  }

  /**
   * 混合两个 VoiceStyle（用于用户语气基线 + 内容风格的融合）
   *
   * 规则：voice 由 contentStyle 决定（以当前内容为准），
   * rate/pitch 在用户基线基础上由内容微调。
   */
  blend(baseParams: EmotionTtsParams, contentStyle: VoiceStyle): EmotionTtsParams {
    const contentParams = STYLE_PARAMS_MAP[contentStyle]

    // 解析 rate 为数值
    const baseRate = parseInt(baseParams.rate.replace(/[^0-9-]/g, '')) || 0
    const contentRate = parseInt(contentParams.rate.replace(/[^0-9-]/g, '')) || 0

    // 解析 pitch 为数值
    const basePitch = parseInt(baseParams.pitch.replace(/[^0-9-]/g, '')) || 0
    const contentPitch = parseInt(contentParams.pitch.replace(/[^0-9-]/g, '')) || 0

    // 混合：在基线基础上加入 40% 的内容影响
    const blendedRate = Math.round(baseRate + contentRate * 0.4)
    const blendedPitch = Math.round(basePitch + contentPitch * 0.4)

    return {
      voice: contentParams.voice, // voice 以内容风格为准
      rate: `${blendedRate > 0 ? '+' : ''}${blendedRate}%`,
      pitch: `${blendedPitch > 0 ? '+' : ''}${blendedPitch}Hz`,
      label: `${contentParams.label}·混合`,
    }
  }

  /**
   * 获取所有 VoiceStyle 支持的参数（供调试/UI）
   */
  getAllStyles(): Array<{ style: VoiceStyle; params: EmotionTtsParams }> {
    return Object.entries(STYLE_PARAMS_MAP).map(([style, params]) => ({
      style: style as VoiceStyle,
      params,
    }))
  }
}

/** 全局单例 */
export const voiceStyleMap = new VoiceStyleMap()
