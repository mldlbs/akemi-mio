/**
 * ToneProfileAnalyzer — 用户语气画像分析器
 *
 * 分析用户最近 N 条消息的沟通风格，提取多维度语气特征：
 *   - energy (活跃度): 感叹号、emoji、高强度词
 *   - formality (正式度): 敬语、规范标点 vs 口语化语气词
 *   - warmth (温暖度): 亲昵称呼、正向表情、情感表达
 *   - brevity (简洁度): 消息长度、句式复杂度
 *   - pacePreference (语速偏好): 标点密度、断句模式
 *
 * 与 SentimentAnalyzer 的区别：
 *   SentimentAnalyzer 分析 **AI 回复内容** 的情感极性（正面/负面/中性），
 *   用于驱动单次 TTS 的情感语调。
 *   ToneProfileAnalyzer 分析 **用户消息** 的沟通风格，生成持久化的
 *   用户语气画像，用于选择 TTS 的基线语音模型和默认参数。
 *
 * 设计原则：
 *   - 纯规则引擎，无外部 LLM 依赖，延迟 < 1ms/消息
 *   - 特征值归一化到 0–1，便于跨用户比较
 *   - 增量更新：新消息到达时更新运行均值，无需重新扫描全量
 */

import { log } from '../logger/Logger'
import type {
  ToneFeatures,
  UserToneProfile,
  MessageToneAnalysis,
  ToneLabel,
} from './types'
import { DEFAULT_TONE_PROFILE } from './types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 默认分析窗口大小（最近 N 条消息） */
const DEFAULT_WINDOW_SIZE = 10

/** 冷启动最小消息数：少于此数时使用默认画像 */
const COLD_START_MIN_MESSAGES = 3

/** 最大消息长度（字符），超长消息截断以避免噪声 */
const MAX_MSG_LENGTH = 2000

// ══════════════════════════════════════════
//  特征词库
// ══════════════════════════════════════════

/** 高能量标记词 — 感叹词、强调词、热血表达 */
const HIGH_ENERGY_WORDS = new Set([
  '哈哈', '哈哈哈', '笑死', '绝了', '牛', '牛逼', '太强了', '厉害',
  '哇', '哇塞', '天哪', '我的天', 'oh my god', 'omg',
  '冲', '冲冲冲', '加油', '干就完了', '搞起来',
  '！', '!!', '!!!', '❗',
  '真的', '太', '超级', '非常', '简直',
  '舒服', '爽', '过瘾', '完美',
])

/** 正式/礼貌标记词 — 敬语、书面语 */
const FORMAL_WORDS = new Set([
  '您', '请', '贵', '尊敬的', '您好', '请问',
  '谢谢', '感谢', '多谢', '麻烦', '劳驾',
  '能否', '可否', '是否', '请问能否', '烦请',
  '建议', '推荐', '认为', '考虑', '评估',
  '根据', '按照', '依据', '参考', '参阅',
  '综上', '因此', '所以', '另外', '此外',
  '首先', '其次', '最后', '然后', '接着',
  '不过', '但是', '然而', '虽然', '如果',
  // 英文正式标记
  'please', 'thank you', 'would', 'could', 'should',
  'regarding', 'according to', 'therefore', 'however',
])

/** 口语/随意标记词 — 语气词、网络用语 */
const CASUAL_WORDS = new Set([
  '吧', '嘛', '呀', '啦', '哦', '噢', '喔', '哈', '嘿', '哎',
  '嗯', '额', '啊', '诶', '哟', '嘞', '哒', '喵',
  '呗', '咯', '嘛', '啰',
  '嘿嘿', '嘻嘻', '哈哈', '呵呵', '嘎嘎',
  '啥', '咋', '咋了', '干嘛', '咋样',
  'OK', 'ok', 'okay', 'yeah', 'yep', 'nope', 'nah',
  '超', '蛮', '挺', '有点', '一点儿',
  '东西', '事情', '事儿', '玩意',
  '对呀', '是啊', '就是说', '你懂的',
])

/** 温暖/亲切标记词 — 情感表达、关心用语 */
const WARM_WORDS = new Set([
  '喜欢', '爱', '可爱', '温柔', '温暖', '贴心',
  '谢谢', '感谢', '感恩', '辛苦', '不容易',
  '开心', '快乐', '幸福', '美好', '甜甜',
  '想你', '惦记', '关心', '在乎', '照顾',
  '陪伴', '在一起', '真好', '太好了',
  '抱抱', '摸摸', '蹭蹭', '贴贴',
  '晚安', '早安', '午安', '好梦',
  '加油', '支持', '相信', '理解', '包容',
  '❤', '💕', '🥰', '😊', '🤗', '💖',
  '朋友', '家人', '伙伴', '亲爱的',
])

/** 简洁度指标 — 单字回复、极短确认 */
const TERSE_PATTERNS = [
  /^[好行可对是不嗯哦噢诶]{1,2}$/,
  /^[OKok]{1,2}$/i,
  /^(yes|no|ok|okay|sure|fine|good|great)$/i,
  /^[👍👌✅❌🙆💯]{1,2}$/,
]

// ══════════════════════════════════════════
//  分析器
// ══════════════════════════════════════════

export class ToneProfileAnalyzer {
  /** 当前运行均值特征（增量更新用） */
  private runningFeatures: ToneFeatures = { ...DEFAULT_TONE_PROFILE.features }
  /** 已分析的消息数（含历史加载） */
  private messageCount = 0
  /** 上次分析的消息内容哈希集合（用于去重） */
  private seenHashes: Set<string> = new Set()
  /** 窗口大小 */
  private windowSize: number

  constructor(windowSize = DEFAULT_WINDOW_SIZE) {
    this.windowSize = windowSize
  }

  // ── 单条消息分析 ──

  /**
   * 分析单条用户消息的语气特征。
   * 轻量级规则引擎，O(n) 复杂度，无外部依赖。
   */
  analyzeMessage(text: string): MessageToneAnalysis {
    const truncated = text.slice(0, MAX_MSG_LENGTH)
    const charCount = truncated.length

    // 原始统计
    const exclamationCount = (truncated.match(/[！!]/g) || []).length
    const questionCount = (truncated.match(/[？?]/g) || []).length
    const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu
    const emojiMatches = truncated.match(emojiPattern)
    const emojiCount = emojiMatches ? emojiMatches.length : 0
    const commaCount = (truncated.match(/[，,、]/g) || []).length
    const periodCount = (truncated.match(/[。.]/g) || []).length
    const sentenceCount = truncated.split(/[。！？.!?\n]+/).filter(Boolean).length

    // 特征词计数
    let formalWordCount = 0
    let casualWordCount = 0
    let warmWordCount = 0
    let highEnergyWordCount = 0

    // 扫描特征词（滑动窗口匹配双字/三字/四字词）
    const scanWords = (source: string, dict: Set<string>): number => {
      let count = 0
      for (let len = 4; len >= 1; len--) {
        for (let i = 0; i <= source.length - len; i++) {
          if (dict.has(source.slice(i, i + len))) {
            count++
            i += len - 1 // 跳过已匹配部分
          }
        }
      }
      return count
    }

    formalWordCount = scanWords(truncated, FORMAL_WORDS)
    casualWordCount = scanWords(truncated, CASUAL_WORDS)
    warmWordCount = scanWords(truncated, WARM_WORDS)
    highEnergyWordCount = scanWords(truncated, HIGH_ENERGY_WORDS)

    // ── 计算特征值（归一化到 0–1） ──

    // energy: 感叹号密度 + emoji 密度 + 高能量词密度
    const exclamationDensity = Math.min(1, exclamationCount / Math.max(1, sentenceCount))
    const emojiDensity = Math.min(1, emojiCount / Math.max(1, sentenceCount))
    const energyWordDensity = Math.min(1, highEnergyWordCount / Math.max(1, charCount / 10))
    const energy = clamp01(exclamationDensity * 0.35 + emojiDensity * 0.3 + energyWordDensity * 0.35)

    // formality: 正式词密度 + 标点规范度 — 口语词惩罚
    const formalDensity = Math.min(1, formalWordCount / Math.max(1, charCount / 15))
    const casualDensity = Math.min(1, casualWordCount / Math.max(1, charCount / 10))
    // 标点规范：句号/逗号比例（规范中文应有适当标点）
    const punctRatio = charCount > 20 ? Math.min(1, (commaCount + periodCount) / Math.max(1, charCount / 15)) : 0.3
    const formality = clamp01(formalDensity * 0.5 + punctRatio * 0.25 + (1 - casualDensity) * 0.25)

    // warmth: 温暖词密度 + 正向 emoji 比例
    const warmDensity = Math.min(1, warmWordCount / Math.max(1, charCount / 12))
    const positiveEmojiRatio = emojiCount > 0
      ? (truncated.match(/[😊🥰❤💕💖🤗😍💗💝✨🌟]/g) || []).length / emojiCount
      : 0
    const warmth = clamp01(warmDensity * 0.6 + positiveEmojiRatio * 0.4)

    // brevity: 消息越短 → 简洁度越高；极短确认直接高分
    const isTerse = TERSE_PATTERNS.some((p) => p.test(truncated.trim()))
    const brevity = isTerse ? 0.95
      : charCount <= 5 ? 0.9
      : charCount <= 20 ? 0.8
      : charCount <= 50 ? 0.55
      : charCount <= 100 ? 0.3
      : charCount <= 200 ? 0.15
      : 0.05

    // pacePreference: 标点密度（逗号/句号密度高 → 语速快、节奏感强）
    const totalPunct = commaCount + periodCount + exclamationCount + questionCount
    const punctDensity = Math.min(1, totalPunct / Math.max(1, charCount / 8))
    const pacePreference = clamp01(punctDensity * 0.6 + (1 - brevity) * 0.4)

    const features: ToneFeatures = {
      energy,
      formality,
      warmth,
      brevity,
      pacePreference,
    }

    return {
      features,
      raw: {
        charCount,
        exclamationCount,
        questionCount,
        emojiCount,
        formalWordCount,
        casualWordCount,
        warmWordCount,
      },
    }
  }

  // ── 增量更新画像 ──

  /**
   * 用一条新用户消息增量更新语气画像。
   * 使用指数移动平均，新消息权重更高（更反映当前状态），
   * 同时保留历史信息。
   *
   * @returns 更新后的 UserToneProfile
   */
  updateProfile(text: string): UserToneProfile {
    // 消息去重
    const hash = simpleHash(text)
    if (this.seenHashes.has(hash)) {
      return this.getProfile()
    }
    this.seenHashes.add(hash)
    if (this.seenHashes.size > this.windowSize * 5) {
      // 限制内存：保留最近 5x 窗口的哈希
      const entries = [...this.seenHashes]
      this.seenHashes = new Set(entries.slice(-this.windowSize * 3))
    }

    const analysis = this.analyzeMessage(text)
    const { features } = analysis

    if (this.messageCount === 0) {
      this.runningFeatures = { ...features }
    } else {
      // 指数移动平均：新消息权重 = 0.3，历史 = 0.7
      const alpha = 0.3
      this.runningFeatures = {
        energy: this.runningFeatures.energy * (1 - alpha) + features.energy * alpha,
        formality: this.runningFeatures.formality * (1 - alpha) + features.formality * alpha,
        warmth: this.runningFeatures.warmth * (1 - alpha) + features.warmth * alpha,
        brevity: this.runningFeatures.brevity * (1 - alpha) + features.brevity * alpha,
        pacePreference: this.runningFeatures.pacePreference * (1 - alpha) + features.pacePreference * alpha,
      }
    }

    this.messageCount++

    log('DEBUG', 'tone_profile_update', {
      msg_count: this.messageCount,
      features: Object.fromEntries(
        Object.entries(this.runningFeatures).map(([k, v]) => [k, v.toFixed(3)]),
      ),
    })

    return this.getProfile()
  }

  /**
   * 批量分析消息并生成画像（用于冷启动/从 DB 加载）。
   * 不重置现有 runningFeatures，而是合并。
   */
  analyzeBatch(messages: string[]): UserToneProfile {
    for (const msg of messages) {
      this.updateProfile(msg)
    }
    return this.getProfile()
  }

  // ── 画像生成与查询 ──

  /**
   * 获取当前用户语气画像。
   * 消息不足时返回默认画像（冷启动处理）。
   */
  getProfile(): UserToneProfile {
    if (this.messageCount < COLD_START_MIN_MESSAGES) {
      return { ...DEFAULT_TONE_PROFILE }
    }

    const primaryTone = this.classifyTone(this.runningFeatures)
    const confidence = Math.min(1, this.messageCount / this.windowSize)

    // 计算方差（简化版：各维度值与 0.5 的平均偏差）
    const variance =
      Object.values(this.runningFeatures).reduce((sum, v) => sum + Math.abs(v - 0.5), 0) /
      Object.keys(this.runningFeatures).length

    return {
      primaryTone,
      features: { ...this.runningFeatures },
      confidence,
      messageCount: this.messageCount,
      lastUpdated: Date.now(),
      variance,
    }
  }

  /**
   * 从 ToneFeatures 分类为主导语气标签。
   * 基于特征向量的规则分类器。
   */
  classifyTone(features: ToneFeatures): ToneLabel {
    const { energy, formality, warmth, brevity } = features

    // 高正式度 → formal / professional
    if (formality > 0.6) {
      return energy > 0.45 ? 'professional' : 'formal'
    }

    // 高温暖度 → warm
    if (warmth > 0.55 && energy > 0.35) {
      return 'warm'
    }

    // 高能量 + 低正式度 → lively
    if (energy > 0.55) {
      return 'lively'
    }

    // 低能量 + 高简洁 → calm (沉稳简洁)
    if (energy < 0.4 && brevity > 0.55) {
      return 'calm'
    }

    // 低正式度 + 高简洁 → casual (随意简短)
    if (formality < 0.4 && brevity > 0.4) {
      return 'casual'
    }

    // 默认
    return 'casual'
  }

  // ── 状态管理 ──

  /**
   * 用已有的 UserToneProfile 恢复分析器状态。
   * 用于从缓存加载后继续增量更新。
   */
  restoreFromProfile(profile: UserToneProfile): void {
    this.runningFeatures = { ...profile.features }
    this.messageCount = profile.messageCount
    log('INFO', 'tone_profile_restored', {
      tone: profile.primaryTone,
      msg_count: profile.messageCount,
      confidence: profile.confidence.toFixed(2),
    })
  }

  /** 重置所有运行时状态 */
  reset(): void {
    this.runningFeatures = { ...DEFAULT_TONE_PROFILE.features }
    this.messageCount = 0
    this.seenHashes.clear()
  }
}

// ── 工具函数 ──

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** 简单字符串哈希（非加密，仅用于去重） */
function simpleHash(text: string): string {
  let hash = 0
  for (let i = 0; i < Math.min(text.length, 100); i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  }
  return hash.toString(36)
}

// ── 单例 ──

/** 全局单例，供 ChatExecutor 使用 */
export const toneProfileAnalyzer = new ToneProfileAnalyzer()
