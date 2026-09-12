/**
 * BehaviorTtsContentMap — 用户消息内容驱动的 TTS 参数映射表
 *
 * 定义从用户消息内容特征（短消息数、提问间隔、问号比例）到 TTS 参数调整的映射规则。
 *
 * 设计原则：
 *   - 每条规则由触发条件（conditions）和对应的 TTS 调整（adjustment）组成
 *   - 条件按优先级排序，第一条匹配的规则生效
 *   - 条件包含 shortMessageCount/consecutiveQuestionCount 等计数器阈值
 *     + intervalSec/ratio 等连续值阈值
 *   - adjustment 只包含 rate 和 pitch 的相对调整值（正=加快/升高，负=减慢/降低）
 *     + 可选的 voice 切换（特定模式切换音色，如连续提问→柔和女声）
 */

import type { EmotionTtsParams } from '@akemi-mio/audio/types'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 内容行为分析的关键指标 */
export interface ContentBehaviorMetrics {
  /** 连续短消息数（<10 字符的消息连续出现次数） */
  consecutiveShortMessages: number
  /** 连续提问数（以 ?/？ 结尾的消息连续出现次数） */
  consecutiveQuestions: number
  /** 距上一条消息的间隔秒数（<=0 表示无历史消息） */
  recentMessageIntervalSec: number
  /** 近期窗口内问号结尾的消息比例 (0–1) */
  questionMarkRatio: number
  /** 窗口内消息总数 */
  totalMessagesInWindow: number
}

/** 内容行为匹配的调整结果 */
export interface ContentBehaviorAdjustment {
  /** 语速调整值（百分比，如 +15 = 加快 15%，-10 = 减慢 10%） */
  rateDelta: number
  /** 音调调整值（Hz，如 +5 = 升高 5Hz，-3 = 降低 3Hz） */
  pitchDelta: number
  /** 可选：音色切换（null = 不切换） */
  voiceOverride: string | null
  /** 可选：语速标签调整比例因子（1.0 = 不变，0.85 = 变慢，1.2 = 变快） */
  speedFactor: number
  /** 人类可读的匹配原因 */
  label: string
}

/** 默认无调整值 */
export const DEFAULT_CONTENT_ADJUSTMENT: ContentBehaviorAdjustment = {
  rateDelta: 0,
  pitchDelta: 0,
  voiceOverride: null,
  speedFactor: 1.0,
  label: '常规·内容',
}

// ══════════════════════════════════════════
//  规则定义
// ══════════════════════════════════════════

/** 一条映射规则：当所有条件满足时，应用对应的 adjustment */
export interface ContentBehaviorRule {
  /** 规则名称（调试/日志用） */
  name: string
  /** 触发条件 */
  conditions: {
    /** 连续短消息数下限（>= 此值触发，-1 = 忽略此条件） */
    minShortMessages: number
    /** 连续提问数下限（>= 此值触发，-1 = 忽略此条件） */
    minConsecutiveQuestions: number
    /** 消息间隔上限（<= 此值触发秒数，-1 = 忽略此条件） */
    maxIntervalSec: number
    /** 问号比例下限（>= 此值触发，-1 = 忽略此条件） */
    minQuestionRatio: number
  }
  /** 匹配后应应用的调整 */
  adjustment: ContentBehaviorAdjustment
}

/**
 * 内容行为 → TTS 参数映射规则表。
 *
 * 按优先级从高到低排列：第一条匹配的规则生效。
 * 设计参考自功能需求文档：
 *   - 连续 3 条短消息且间隔 <30s → 语速 1.2x，语调中性（rate +18%）
 *   - 连续 5 条提问 → 音色切换柔和女声，语速 0.9x（pitch -6Hz, rate -10%）
 *   - 高频短消息 + 高比例提问 → 快速响应模式（rate +12%）
 *   - 低频长间隔 → 舒缓模式（rate -5%）
 *   - 高问号比例（沉浸式问答）→ 温柔耐心模式（pitch -3Hz, rate -5%）
 */
export const CONTENT_BEHAVIOR_RULES: ContentBehaviorRule[] = [
  // ── Rule 1: 连续提问洪水（5+ 连续提问）→ 柔和女声，语速放慢 ──
  {
    name: 'question_flood',
    conditions: {
      minShortMessages: -1,
      minConsecutiveQuestions: 5,
      maxIntervalSec: -1,
      minQuestionRatio: -1,
    },
    adjustment: {
      rateDelta: -10,
      pitchDelta: -6,
      voiceOverride: 'zh-CN-XiaoyiNeural',
      speedFactor: 0.9,
      label: '耐心·连续提问',
    },
  },
  // ── Rule 2: 连续短消息突发（3+ 短消息，间隔 <30s）→ 语速加快，语调中性 ──
  {
    name: 'short_message_burst',
    conditions: {
      minShortMessages: 3,
      minConsecutiveQuestions: -1,
      maxIntervalSec: 30,
      minQuestionRatio: -1,
    },
    adjustment: {
      rateDelta: +18,
      pitchDelta: 0,
      voiceOverride: null,
      speedFactor: 1.18,
      label: '高效·短消息突发',
    },
  },
  // ── Rule 3: 高频短消息 + 高提问倾向 → 快速响应 ──
  {
    name: 'rapid_qa',
    conditions: {
      minShortMessages: 2,
      minConsecutiveQuestions: 2,
      maxIntervalSec: 30,
      minQuestionRatio: 0.4,
    },
    adjustment: {
      rateDelta: +12,
      pitchDelta: +4,
      voiceOverride: null,
      speedFactor: 1.12,
      label: '敏捷·快速问答',
    },
  },
  // ── Rule 4: 高比例提问（深度问答模式）→ 温柔耐心 ──
  {
    name: 'deep_qa',
    conditions: {
      minShortMessages: -1,
      minConsecutiveQuestions: -1,
      maxIntervalSec: -1,
      minQuestionRatio: 0.6,
    },
    adjustment: {
      rateDelta: -5,
      pitchDelta: -3,
      voiceOverride: null,
      speedFactor: 0.95,
      label: '耐心·深度问答',
    },
  },
  // ── Rule 5: 连续短消息（不关心间隔）→ 语速略快 ──
  {
    name: 'brief_messages',
    conditions: {
      minShortMessages: 2,
      minConsecutiveQuestions: -1,
      maxIntervalSec: -1,
      minQuestionRatio: -1,
    },
    adjustment: {
      rateDelta: +8,
      pitchDelta: +2,
      voiceOverride: null,
      speedFactor: 1.08,
      label: '简洁·短消息',
    },
  },
]

// ══════════════════════════════════════════
//  核心匹配函数
// ══════════════════════════════════════════

/**
 * 根据内容行为指标匹配第一条生效的规则。
 *
 * @param metrics 内容行为分析的关键指标
 * @returns 匹配到的调整配置，无匹配时返回 DEFAULT_CONTENT_ADJUSTMENT
 */
export function matchContentBehavior(metrics: ContentBehaviorMetrics): ContentBehaviorAdjustment {
  for (const rule of CONTENT_BEHAVIOR_RULES) {
    const { conditions } = rule

    // 检查每个条件（-1 = 忽略）
    const shortMatch = conditions.minShortMessages < 0 || metrics.consecutiveShortMessages >= conditions.minShortMessages
    const questionMatch = conditions.minConsecutiveQuestions < 0 || metrics.consecutiveQuestions >= conditions.minConsecutiveQuestions
    const intervalMatch = conditions.maxIntervalSec < 0 || metrics.recentMessageIntervalSec <= conditions.maxIntervalSec
    const ratioMatch = conditions.minQuestionRatio < 0 || metrics.questionMarkRatio >= conditions.minQuestionRatio

    if (shortMatch && questionMatch && intervalMatch && ratioMatch) {
      return { ...rule.adjustment }
    }
  }

  return { ...DEFAULT_CONTENT_ADJUSTMENT }
}

/**
 * 将 ContentBehaviorAdjustment 合入 EmotionTtsParams。
 *
 * @param base 基础 TTS 参数
 * @param adjustment 内容行为调整
 * @returns 合并后的新 EmotionTtsParams
 */
export function applyContentAdjustment(base: EmotionTtsParams, adjustment: ContentBehaviorAdjustment): EmotionTtsParams {
  const result: EmotionTtsParams = {
    voice: adjustment.voiceOverride ?? base.voice,
    rate: adjustRateParam(base.rate, adjustment.rateDelta),
    pitch: adjustPitchParam(base.pitch, adjustment.pitchDelta),
    label: `${base.label}·${adjustment.label}`,
  }
  return result
}

/**
 * 在现有语速参数上叠加调整值。
 * 如 base='+10%', delta=+8 → '+18%'
 */
function adjustRateParam(current: string, delta: number): string {
  const base = parseInt(current.replace(/[^0-9-]/g, '')) || 10
  const clamped = Math.max(-50, Math.min(50, base + delta))
  return `${clamped >= 0 ? '+' : ''}${clamped}%`
}

/**
 * 在现有多高参数上叠加调整值。
 * 如 base='+8Hz', delta=-4 → '+4Hz'
 */
function adjustPitchParam(current: string, delta: number): string {
  const base = parseInt(current.replace(/[^0-9-]/g, '')) || 8
  const clamped = Math.max(-20, Math.min(20, base + delta))
  return `${clamped >= 0 ? '+' : ''}${clamped}Hz`
}
