export type TtsStateCallback = (state: Partial<{ ttsPlaying: boolean }>) => void

/** 情感极性 */
export type SentimentPolarity = 'positive' | 'negative' | 'neutral'

/** 情感自适应语音参数 */
export interface EmotionTtsParams {
  /** edge-tts voice 名称, e.g. 'zh-CN-XiaoxiaoNeural' */
  voice: string
  /** 语速, e.g. '+10%' / '-5%' */
  rate: string
  /** 音调偏移, e.g. '+8Hz' / '-3Hz' */
  pitch: string
  /** 人类可读的描述标签 */
  label: string
}

/** 情感分析结果 */
export interface SentimentResult {
  polarity: SentimentPolarity
  /** 置信度 0–1 */
  score: number
  /** 内容类型 */
  contentType: string
  /** 匹配到的情感词 */
  matchedWords: string[]
}

// ══════════════════════════════════════════
//  用户语气画像 (User Tone Profile)
// ══════════════════════════════════════════

/** 语气维度 — 描述用户的沟通风格特征 */
export interface ToneFeatures {
  /** 能量/活跃度 0–1: 越高越活泼、兴奋；越低越沉稳、安静 */
  energy: number
  /** 正式度 0–1: 越高越正式（敬语、规范）；越低越随意（口语、俚语） */
  formality: number
  /** 温暖度 0–1: 越高越亲切、情感丰富 */
  warmth: number
  /** 简洁度 0–1: 越高消息越短、直接；越低越详细、展开 */
  brevity: number
  /** 语速偏好 0–1: 从消息标点密度和句式复杂度推断，越高偏好快速 */
  pacePreference: number
}

/** 主导语气标签 */
export type ToneLabel = 'lively' | 'calm' | 'formal' | 'casual' | 'warm' | 'professional'

/** 用户语气画像 — 持久化的用户沟通风格摘要 */
export interface UserToneProfile {
  /** 主导语气 */
  primaryTone: ToneLabel
  /** 各维度特征值 */
  features: ToneFeatures
  /** 综合置信度 0–1（基于样本量、一致性） */
  confidence: number
  /** 分析的消息数量 */
  messageCount: number
  /** 最后更新时间戳 */
  lastUpdated: number
  /** 特征方差（衡量用户语气稳定性，低=稳定，高=多变） */
  variance: number
}

/** ToneProfileAnalyzer 分析单个消息后的中间结果 */
export interface MessageToneAnalysis {
  /** 归一化后的特征值 (0–1) */
  features: ToneFeatures
  /** 原始统计值（调试用） */
  raw: {
    charCount: number
    exclamationCount: number
    questionCount: number
    emojiCount: number
    formalWordCount: number
    casualWordCount: number
    warmWordCount: number
  }
}

/** 默认语气画像（新用户 / 冷启动） */
export const DEFAULT_TONE_PROFILE: UserToneProfile = {
  primaryTone: 'casual',
  features: {
    energy: 0.5,
    formality: 0.3,
    warmth: 0.5,
    brevity: 0.5,
    pacePreference: 0.5,
  },
  confidence: 0,
  messageCount: 0,
  lastUpdated: 0,
  variance: 0,
}
