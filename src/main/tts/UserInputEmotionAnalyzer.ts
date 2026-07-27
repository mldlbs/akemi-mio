/**
 * UserInputEmotionAnalyzer — 用户输入文本情感分析器
 *
 * 基于规则（关键词匹配 + 否定词 + 程度副词）的轻量级情感分类器，
 * 从用户输入的文本内容推断具体情绪标签（愤怒/悲伤/喜悦/中性），
 * 为 TTS 同音色情绪匹配合成提供信号。
 *
 * 与 BehaviorEmotionDetector（用户怎么操作）互补：
 *   - BehaviorEmotionDetector: 用户物理交互指标 → 焦躁/平静/专注
 *   - UserInputEmotionAnalyzer: 用户说了什么 → 愤怒/悲伤/喜悦
 *
 * 设计目标：
 *   - 无外部 ML 依赖（纯规则引擎，冷启动无延迟）
 *   - LRU 缓存避免重复分析（相同文本直接命中）
 *   - 连续相同情绪跟踪（≥3 次触发强度提升信号）
 *
 * 集成点：
 *   - ChatExecutor.run() → analyze(userInput) 记录每次用户消息
 *   - ChatExecutor.applySentimentToTts() 融合到最终 TTS 参数
 */

import { log } from '../logger/Logger'
import type { UserInputEmotion, UserInputEmotionResult, EmotionTtsParams } from './types'
import { USER_INPUT_EMOTION_TTS_MAP } from './types'

// ══════════════════════════════════════════
//  愤怒情感词库
// ══════════════════════════════════════════

const ANGRY_WORDS = new Set([
  // 直接愤怒
  '生气', '愤怒', '恼火', '恼怒', '气愤', '怒', '发火', '暴怒', '狂怒', '怒气',
  '气死', '气人', '气炸', '气到', '气坏了', '气疯了',
  // 烦躁/不满
  '烦', '烦躁', '烦死', '受不了', '忍不了', '无法忍受', '不能忍', '受够了',
  '讨厌', '恶心', '恶心人', '可恶', '可恨', '恨', '仇恨', '怨恨',
  // 骂人/攻击 (轻量)
  '混蛋', '滚', '滚开', '滚蛋', '闭嘴', '住口', '傻子', '白痴', '蠢',
  '有病', '神经病', '脑子有坑', '什么玩意儿',
  // 抗议/抱怨
  '搞什么', '搞什么鬼', '什么鬼', '什么垃圾', '什么破',
  '敷衍', '糊弄', '忽悠', '欺骗', '骗人',
  // 强烈否定
  '绝不', '决不', '坚决不', '门都没有', '没门', '做梦',
  '垃圾', '废物', '差劲', '糟糕透顶',
  // 标点符号特征
  '!!!', '！！！', '??', '？？',
])

// ══════════════════════════════════════════
//  悲伤情感词库
// ══════════════════════════════════════════

const SAD_WORDS = new Set([
  // 直接悲伤
  '难过', '伤心', '悲伤', '悲哀', '悲痛', '哀伤', '忧伤', '伤感', '悲',
  '心碎', '心痛', '心疼', '心酸', '心累', '心里难受',
  // 失望/沮丧
  '失望', '沮丧', '失落', '灰心', '泄气', '气馁', '灰心丧气',
  '绝望', '无望', '没希望', '看不到希望',
  // 孤独/无助
  '孤独', '寂寞', '孤单', '无助', '没人懂', '没人理解',
  '空虚', '茫然', '迷茫', '迷失',
  // 压抑/痛苦
  '压抑', '郁闷', '憋屈', '痛苦', '难受', '不好受', '不开心',
  '沉重', '消沉', '低沉', '低落', '颓废',
  // 哭泣
  '哭', '哭了', '想哭', '大哭', '哭泣', '流泪', '泪流满面', '眼泪',
  'T_T', 'TAT', 'QAQ', '😭', '🥺',
  // 怀念/遗憾
  '怀念', '想念', '思念', '遗憾', '可惜', '后悔', '懊悔',
  '错过了', '失去了', '失去了', '丢了',
])

// ══════════════════════════════════════════
//  喜悦情感词库
// ══════════════════════════════════════════

const JOYFUL_WORDS = new Set([
  // 直接喜悦
  '开心', '高兴', '快乐', '愉快', '欢乐', '喜悦', '喜', '乐',
  '哈哈', '哈哈哈', '嘿嘿', '嘻嘻',
  // 兴奋
  '兴奋', '激动', '惊喜', '狂喜', '太棒', '太好了', '太开心',
  '太高兴', '太爽', '爽', '爽翻',
  // 满足/幸福
  '幸福', '满足', '欣慰', '感恩', '感激',
  '完美', '圆满', '满意', '知足',
  // 赞美/积极
  '棒', '棒极', '优秀', '出色', '厉害', '牛逼', '了不起',
  '真好', '真棒', '真开心', '真高兴',
  // 成功/完成
  '成功', '搞定', '完成', '通过', '赢了', '胜利', '胜利了',
  '好吃', '好玩', '好看', '好棒',
  // 轻松/放松
  '轻松', '舒坦', '舒服', '愉快', '自在', '惬意', '享受',
  // 表情符号
  '😄', '😃', '😀', '😁', '🥳', '🎉', '🎊', '✨',
  '👍', '👏', '🙌', '💪', '❤️', '💕',
])

// ══════════════════════════════════════════
//  否定词（翻转极性）
// ══════════════════════════════════════════

const NEGATION_WORDS = new Set([
  '不', '没', '无', '非', '未', '别', '莫', '勿', '否',
  '没有', '并非', '绝不', '不是', '不会', '不能', '不好', '不行',
])

// ══════════════════════════════════════════
//  程度副词（增强信号）
// ══════════════════════════════════════════

const INTENSIFIERS = new Set([
  '非常', '十分', '极其', '特别', '格外', '尤其',
  '很', '太', '真', '最', '极', '超级', '无比', '极度',
  '相当', '挺', '好', '多么',
])

// ══════════════════════════════════════════
//  LRU 缓存配置
// ══════════════════════════════════════════

/** LRU 缓存最大条目数 */
const LRU_CACHE_MAX = 32

/** 情感历史最大保留数（用于连续检测） */
const MAX_HISTORY_SIZE = 10

/** 连续相同情绪判定阈值 */
const CONSECUTIVE_THRESHOLD = 3

/** 默认中性结果（冷启动/无输入） */
const NEUTRAL_RESULT: UserInputEmotionResult = {
  emotion: 'neutral',
  confidence: 0,
  matchedWords: [],
  ttsParams: { ...USER_INPUT_EMOTION_TTS_MAP['neutral'] },
  consecutiveEmotion: false,
  consecutiveCount: 0,
}

// ══════════════════════════════════════════
//  分析器
// ══════════════════════════════════════════

export class UserInputEmotionAnalyzer {
  /** LRU 缓存：text → UserInputEmotionResult */
  private cache: Map<string, UserInputEmotionResult> = new Map()

  /** 最近 N 次情感分析结果（用于连续检测） */
  private history: UserInputEmotion[] = []

  /** 是否启用 */
  private enabled = true

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /** 启用/禁用 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.cache.clear()
      this.history = []
    }
    log('INFO', 'user_input_emotion_enabled', { enabled })
  }

  isEnabled(): boolean {
    return this.enabled
  }

  // ══════════════════════════════════════════
  //  核心分析
  // ══════════════════════════════════════════

  /**
   * 分析用户输入文本的情感。
   *
   * @param text 用户输入的文本
   * @returns UserInputEmotionResult
   */
  analyze(text: string): UserInputEmotionResult {
    if (!this.enabled) {
      return { ...NEUTRAL_RESULT }
    }

    if (!text || text.trim().length === 0) {
      return { ...NEUTRAL_RESULT }
    }

    // ── LRU 缓存查找 ──
    const cacheKey = text.slice(0, 200) + ':' + text.length
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return cached
    }

    // 归一化
    const normalized = text.toLowerCase()

    // 1. 扫描情感词并计分
    const result = this._classifyEmotion(text, normalized)

    // 2. 记录历史（用于连续检测）
    this._recordHistory(result.emotion)

    // 3. 连续检测
    result.consecutiveEmotion = this._detectConsecutive(result.emotion)
    result.consecutiveCount = this._countConsecutive(result.emotion)

    // ── 写入 LRU 缓存 ──
    this.cache.set(cacheKey, { ...result })
    if (this.cache.size > LRU_CACHE_MAX) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
      }
    }

    if (result.emotion !== 'neutral' && result.confidence > 0.3) {
      log('INFO', 'user_input_emotion_detected', {
        emotion: result.emotion,
        confidence: result.confidence.toFixed(2),
        consecutive: result.consecutiveEmotion,
        consecutiveCount: result.consecutiveCount,
        matchedWords: result.matchedWords.slice(0, 8).join(','),
        text_snippet: text.slice(0, 60),
      })
    }

    return result
  }

  /**
   * 清空历史记录（供调试/测试用）。
   */
  reset(): void {
    this.cache.clear()
    this.history = []
  }

  /**
   * 获取情感历史（供调试/UI 展示）。
   */
  getHistory(): UserInputEmotion[] {
    return [...this.history]
  }

  /**
   * 获取当前缓存大小。
   */
  getCacheSize(): number {
    return this.cache.size
  }

  // ══════════════════════════════════════════
  //  私有方法
  // ══════════════════════════════════════════

  /**
   * 基于关键词匹配分类情绪。
   */
  private _classifyEmotion(rawText: string, normalized: string): UserInputEmotionResult {
    // 分词
    const words = this._segmentWords(normalized)
    const matchedWords: string[] = []

    // 各情绪得分
    let angryScore = 0
    let sadScore = 0
    let joyfulScore = 0

    // 句子级否定上下文
    const sentences = normalized.split(/[。！？\n.!?，、；：]+/)
    let currentNegation = false

    for (const sentence of sentences) {
      const sentenceWords = this._segmentWords(sentence)
      currentNegation = false

      for (let i = 0; i < sentenceWords.length; i++) {
        const word = sentenceWords[i]

        // 检测否定词
        if (NEGATION_WORDS.has(word)) {
          currentNegation = true
          continue
        }

        // 检测程度副词
        const hasIntensifier = i > 0 && INTENSIFIERS.has(sentenceWords[i - 1])
        const multiplier = hasIntensifier ? 1.5 : 1.0

        if (ANGRY_WORDS.has(word)) {
          if (!matchedWords.includes(word)) matchedWords.push(word)
          angryScore += currentNegation ? 0.5 : 1.0 * multiplier
          currentNegation = false
        } else if (SAD_WORDS.has(word)) {
          if (!matchedWords.includes(word)) matchedWords.push(word)
          sadScore += currentNegation ? 0.5 : 1.0 * multiplier
          currentNegation = false
        } else if (JOYFUL_WORDS.has(word)) {
          if (!matchedWords.includes(word)) matchedWords.push(word)
          joyfulScore += currentNegation ? 0.5 : 1.0 * multiplier
          currentNegation = false
        }
      }
    }

    // 特殊检测：连续标点（愤怒信号）
    const exclCount = (rawText.match(/[！!]/g) || []).length
    if (exclCount >= 3) {
      angryScore += exclCount * 0.3
    }

    // 特殊检测：哭泣表情符号（悲伤信号）
    if (/😭|🥺|T_T|TAT|QAQ|泪/.test(rawText)) {
      sadScore += 2.0
      if (!matchedWords.includes('😭')) matchedWords.push('😭')
    }

    // 特殊检测：欢乐表情符号（喜悦信号）
    if (/😄|😃|😀|😁|🥳|🎉|🎊/.test(rawText)) {
      joyfulScore += 1.5
      if (!matchedWords.includes('😄')) matchedWords.push('😄')
    }

    // 判定情绪
    const totalScore = angryScore + sadScore + joyfulScore
    let emotion: UserInputEmotion
    let confidence: number

    if (totalScore === 0) {
      emotion = 'neutral'
      confidence = 0
    } else if (angryScore > sadScore && angryScore > joyfulScore) {
      emotion = 'angry'
      confidence = Math.min(1, angryScore / totalScore)
    } else if (sadScore > angryScore && sadScore > joyfulScore) {
      emotion = 'sad'
      confidence = Math.min(1, sadScore / totalScore)
    } else if (joyfulScore > angryScore && joyfulScore > sadScore) {
      emotion = 'joyful'
      confidence = Math.min(1, joyfulScore / totalScore)
    } else {
      // 冲突：取最高分，但降低置信度
      const maxScore = Math.max(angryScore, sadScore, joyfulScore)
      if (maxScore === angryScore) {
        emotion = 'angry'
      } else if (maxScore === sadScore) {
        emotion = 'sad'
      } else {
        emotion = 'joyful'
      }
      confidence = 0.4 // 冲突时低置信度
    }

    // 调节：如果有情感词但非常少，降低置信度
    if (matchedWords.length === 1 && totalScore < 2) {
      confidence = Math.min(confidence, 0.5)
    }

    const ttsParams = { ...USER_INPUT_EMOTION_TTS_MAP[emotion] }

    return {
      emotion,
      confidence: Math.round(confidence * 100) / 100,
      matchedWords,
      ttsParams,
      consecutiveEmotion: false,
      consecutiveCount: 0,
    }
  }

  /**
   * 简单分词：按标点和空白切分后生成单字/双字/三字组合。
   */
  private _segmentWords(sentence: string): string[] {
    const chars = sentence.replace(/\s+/g, '').split('')
    const words: string[] = []

    for (let i = 0; i < chars.length; i++) {
      words.push(chars[i])
      if (i + 1 < chars.length) {
        words.push(chars[i] + chars[i + 1])
      }
      if (i + 2 < chars.length) {
        words.push(chars[i] + chars[i + 1] + chars[i + 2])
      }
    }

    return words
  }

  /**
   * 记录情感到历史队列。
   */
  private _recordHistory(emotion: UserInputEmotion): void {
    this.history.push(emotion)
    if (this.history.length > MAX_HISTORY_SIZE) {
      this.history.shift()
    }
  }

  /**
   * 检测最近 K 次是否连续相同情绪。
   */
  private _detectConsecutive(emotion: UserInputEmotion): boolean {
    return this._countConsecutive(emotion) >= CONSECUTIVE_THRESHOLD
  }

  /**
   * 统计从末尾向前的连续相同情绪次数。
   */
  private _countConsecutive(emotion: UserInputEmotion): number {
    const reversed = [...this.history].reverse()
    let count = 0
    for (const h of reversed) {
      if (h === emotion) {
        count++
      } else {
        break
      }
    }
    return count
  }

  /**
   * 当检测到连续相同情绪时，获取增强的 TTS 参数。
   * 连续次数越多，参数调制越强。
   */
  getStrengthenedParams(result: UserInputEmotionResult): EmotionTtsParams {
    const { emotion, consecutiveCount, ttsParams } = result

    if (consecutiveCount < CONSECUTIVE_THRESHOLD) {
      return { ...ttsParams }
    }

    const strengthFactor = Math.min(1.5, 1 + (consecutiveCount - CONSECUTIVE_THRESHOLD + 1) * 0.15)

    // 解析当前 rate 和 pitch
    const rateBase = parseInt(ttsParams.rate.replace(/[^0-9-]/g, '')) || 10
    const pitchBase = parseInt(ttsParams.pitch.replace(/[^0-9-]/g, '')) || 8

    const strengthenedRate = Math.max(-50, Math.min(50, Math.round(rateBase * strengthFactor)))
    const strengthenedPitch = Math.max(-20, Math.min(20, Math.round(pitchBase * strengthFactor)))

    const strengthened: EmotionTtsParams = {
      ...ttsParams,
      rate: `${strengthenedRate >= 0 ? '+' : ''}${strengthenedRate}%`,
      pitch: `${strengthenedPitch >= 0 ? '+' : ''}${strengthenedPitch}Hz`,
      label: `${ttsParams.label}·连续`,
    }

    log('INFO', 'user_input_emotion_strengthened', {
      emotion,
      consecutiveCount,
      originalRate: ttsParams.rate,
      originalPitch: ttsParams.pitch,
      newRate: strengthened.rate,
      newPitch: strengthened.pitch,
      strengthFactor: strengthFactor.toFixed(2),
    })

    return strengthened
  }
}

/** 全局单例 */
export const userInputEmotionAnalyzer = new UserInputEmotionAnalyzer()
