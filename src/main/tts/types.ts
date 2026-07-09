import type { VoiceEmotionLabel } from '../asr/types'

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

// ══════════════════════════════════════════
//  VoiceStyle — 高级语音风格标签
// ══════════════════════════════════════════

/**
 * 语音风格 — Agent 回复时附加的高级情感/音色标签。
 *
 * 与 EmotionTtsParams（底层 engine 参数）不同，VoiceStyle 是语义层面的风格描述，
 * 由 Agent/LLM 根据回复内容选择，再通过 VoiceStyleMap 映射到具体的 TTS 参数。
 */
export type VoiceStyle =
  | 'cheerful'   // 欢快 — 好消息、成功反馈、轻松闲聊
  | 'serious'    // 严肃 — 警告、错误、重要通知
  | 'gentle'     // 温柔 — 安慰、关怀、夜间模式
  | 'neutral'    // 中性 — 信息播报、数据汇报
  | 'warm'       // 温暖 — 问候、感谢、日常陪伴
  | 'energetic'  // 活力 — 激励、庆祝、高能量时刻
  | 'calm'       // 沉稳 — 技术解释、分析、教导
  | 'playful'    // 俏皮 — 玩笑、娱乐、创意内容

/** 回复类型 → 推荐 VoiceStyle 映射 */
export type ReplyCategory = 'notification' | 'teaching' | 'casual_chat' | 'success' | 'error' | 'greeting' | 'analysis' | 'creative'

/** 回复类型 → VoiceStyle 自动映射表 */
export const REPLY_CATEGORY_STYLE_MAP: Record<ReplyCategory, VoiceStyle> = {
  notification: 'serious',
  teaching: 'calm',
  casual_chat: 'cheerful',
  success: 'cheerful',
  error: 'serious',
  greeting: 'warm',
  analysis: 'neutral',
  creative: 'playful',
}

/** 用于 IPC 传输的语音风格信息 */
export interface VoiceStyleInfo {
  /** 语义风格标签 */
  style: VoiceStyle
  /** 对应的底层 TTS 参数 */
  params: EmotionTtsParams
  /** 回复类别（触发风格的原因） */
  category: ReplyCategory
}

// ══════════════════════════════════════════
//  行为情绪 — 基于实时用户交互行为的情绪检测
// ══════════════════════════════════════════

/**
 * 行为情绪标签 — 从用户实时交互行为（APM、窗口切换、鼠标抖动）推断的情绪状态。
 *
 * 与 SentimentPolarity（基于 AI 回复内容的文本情感）互补：
 *   - SentimentPolarity: 内容说了什么 → 正面/负面/中性
 *   - BehaviorEmotion: 用户怎么交互 → 焦躁/平静/专注/中性
 */
export type BehaviorEmotion = 'anxious' | 'calm' | 'focused' | 'neutral'

/** 行为情绪 → TTS 参数预设映射表 */
export const BEHAVIOR_EMOTION_TTS_MAP: Record<BehaviorEmotion, EmotionTtsParams> = {
  /** 焦躁 — 语速降低、语调更柔和，起安抚作用 */
  anxious: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-8%',
    pitch: '-4Hz',
    label: '安抚·焦躁',
  },
  /** 平静 — 保持自然语速和语调 */
  calm: {
    voice: 'zh-CN-YunxiNeural',
    rate: '+5%',
    pitch: '+2Hz',
    label: '平和·平静',
  },
  /** 专注 — 语速稍快、语调紧凑，配合高效节奏 */
  focused: {
    voice: 'zh-CN-YunyangNeural',
    rate: '+12%',
    pitch: '+4Hz',
    label: '高效·专注',
  },
  /** 中性 — 默认参数，不覆盖 */
  neutral: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+10%',
    pitch: '+8Hz',
    label: '中性·行为',
  },
}

// ══════════════════════════════════════════
//  语音情感 — 从 ASR 声学特征（音高/能量/语速）推断的用户情绪
// ══════════════════════════════════════════

/**
 * 语音情感标签（从用户语音的声学特征分析得出）。
 * 与文本情感 SentimentPolarity 和行为情感 BehaviorEmotion 互补。
 *
 * 三层情感系统对比：
 *   - SentimentPolarity（文本情感）: LLM 回复说了什么 → 正面/负面/中性
 *   - BehaviorEmotion（行为情感）: 用户怎么操作 → 焦躁/平静/专注/中性
 *   - VoiceEmotionLabel（语音情感）: 用户怎么说 → 开心/悲伤/生气/平静/焦虑/中性
 */

/** 语音情感 → TTS 参数预设映射表 */
export const VOICE_EMOTION_TTS_MAP: Record<VoiceEmotionLabel, EmotionTtsParams> = {
  /** 中性 — 常规交流，使用默认参数 */
  neutral: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+10%',
    pitch: '+8Hz',
    label: '常规·语音',
  },
  /** 开心 — 匹配用户的高涨情绪，语速稍快、音调偏高 */
  happy: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+15%',
    pitch: '+12Hz',
    label: '共鸣·开心',
  },
  /** 悲伤 — 匹配用户的低沉情绪，语速放缓、音调偏低，温柔安慰 */
  sad: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-5%',
    pitch: '-4Hz',
    label: '安抚·悲伤',
  },
  /** 生气 — 匹配用户的愤怒情绪，语速适中偏缓、音调降低（以柔克刚） */
  angry: {
    voice: 'zh-CN-YunjianNeural',
    rate: '-3%',
    pitch: '-3Hz',
    label: '平和·生气',
  },
  /** 平静 — 匹配用户的平静状态，保持自然语速和语调 */
  calm: {
    voice: 'zh-CN-YunxiNeural',
    rate: '+5%',
    pitch: '+2Hz',
    label: '同步·平静',
  },
  /** 焦虑 — 匹配用户的焦虑情绪，语速降低、语调柔和（起安抚作用） */
  anxious: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-8%',
    pitch: '-5Hz',
    label: '安抚·焦虑',
  },
}

/** 实时用户行为指标（由 BehaviorEmotionDetector 持续采集） */
export interface BehaviorMetrics {
  /** 每分钟动作次数（消息发送 + 工具调用 + 其他交互） */
  apm: number
  /** 每分钟窗口切换次数 */
  windowSwitchesPerMin: number
  /** 鼠标路径抖动度 0–1（0=平滑直线，1=高频抖动），每 2s 采样计算 */
  mouseJitter: number
  /** 指标采集的时间窗口（秒） */
  windowSeconds: number
  /** 时间窗口内的总动作数 */
  totalActions: number
  /** 时间窗口内的窗口切换总数 */
  totalWindowSwitches: number
  /** 最后一次更新时间戳 */
  lastUpdated: number
}

/** 行为情绪检测结果 */
export interface BehaviorEmotionResult {
  /** 当前情绪标签 */
  emotion: BehaviorEmotion
  /** 各情绪的概率分布（总和=1） */
  scores: Record<BehaviorEmotion, number>
  /** 触发当前情绪的原始指标 */
  metrics: BehaviorMetrics
  /** 置信度 0–1 */
  confidence: number
  /** 对应的 TTS 参数预设 */
  ttsParams: EmotionTtsParams
}

// ══════════════════════════════════════════
//  交互情境 — 交互间隔 + 时段感知
// ══════════════════════════════════════════

/**
 * 交互节奏分类 — 基于用户连续交互间隔的模式。
 *
 * 与 BehaviorEmotion（APM/窗口切换/鼠标抖动）互补：
 *   - BehaviorEmotion: 用户怎么操作 → 焦躁/平静/专注
 *   - InteractionCadence: 用户交流节奏 → 急迫/正常/低频
 */
export type InteractionCadence = 'rapid' | 'normal' | 'low'

/**
 * 时段分类 — 基于当前系统时间的时段感知。
 */
export type DayPeriod = 'morning' | 'afternoon' | 'evening' | 'late_night'

/** 交互间隔统计 */
export interface InteractionIntervalStats {
  /** 最近 N 次交互的平均间隔（秒） */
  meanIntervalSec: number
  /** 最近 N 次交互的中位间隔（秒） */
  medianIntervalSec: number
  /** 最近一次交互距今的秒数 */
  lastInteractionSec: number
  /** 窗口内的总交互次数 */
  interactionCount: number
  /** 所有间隔值（秒），按时间升序 */
  intervals: number[]
  /** 急迫判定：最近多少次交互间隔均低于阈值 */
  rapidBurstCount: number
}

/** 交互情境上下文 — 综合交互节奏和时段信息 */
export interface InteractionContext {
  /** 交互节奏 */
  cadence: InteractionCadence
  /** 当前时段 */
  dayPeriod: DayPeriod
  /** 交互间隔统计 */
  intervalStats: InteractionIntervalStats
  /** 基于情境推荐的 TTS 参数 */
  ttsParams: EmotionTtsParams
  /** 置信度 0–1 */
  confidence: number
  /** 情境的人类可读描述 */
  description: string
}

/**
 * 交互节奏 → TTS 参数预设映射表。
 *
 * 设计原则：
 *   rapid  → 语速稍快、音调清晰 (帮助用户快速获取信息)
 *   normal → 保持默认参数
 *   low    → 语速稍慢、音调柔和 (配合低频节奏)
 */
export const CADENCE_TTS_MAP: Record<InteractionCadence, EmotionTtsParams> = {
  rapid: {
    voice: 'zh-CN-YunyangNeural',
    rate: '+15%',
    pitch: '+6Hz',
    label: '高效·急迫',
  },
  normal: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+10%',
    pitch: '+8Hz',
    label: '标准·常态',
  },
  low: {
    voice: 'zh-CN-YunxiNeural',
    rate: '+2%',
    pitch: '+0Hz',
    label: '舒缓·低频',
  },
}

/**
 * 时段 → TTS 参数预设映射表。
 *
 * 设计原则：
 *   morning   → 活力、提神
 *   afternoon → 标准
 *   evening   → 柔和、放松
 *   late_night → 极柔、低音量感 (避免打扰)
 */
export const DAY_PERIOD_TTS_MAP: Record<DayPeriod, EmotionTtsParams> = {
  morning: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+15%',
    pitch: '+10Hz',
    label: '晨间·活力',
  },
  afternoon: {
    voice: 'zh-CN-YunxiNeural',
    rate: '+8%',
    pitch: '+4Hz',
    label: '午后·自然',
  },
  evening: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-3%',
    pitch: '-2Hz',
    label: '晚间·柔和',
  },
  late_night: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-8%',
    pitch: '-5Hz',
    label: '深夜·轻柔',
  },
}

// ══════════════════════════════════════════
//  TTS Router — 混合 TTS 智能路由
// ══════════════════════════════════════════

/** TTS 引擎标识 */
export type TtsEngine = 'cloud' | 'local'

/** 用户 TTS 偏好模式 */
export type TtsUserPreference = 'auto' | 'cloud' | 'local'

/** 路由决策结果 */
export interface TtsRoutingDecision {
  /** 选择的引擎 */
  engine: TtsEngine
  /** 决策原因（日志/调试） */
  reason: string
  /** 当前网络延迟（ms），-1 表示不可用 */
  networkLatencyMs: number
  /** 网络是否可用 */
  networkAvailable: boolean
  /** 本次请求的质量权重 0-1 */
  qualityWeight: number
  /** 本次请求的延迟权重 0-1 */
  latencyWeight: number
}

/** TTS 路由配置 */
export interface TtsRouterConfig {
  /** 网络延迟阈值（ms）：高于此值倾向本地引擎 */
  maxLatencyMs: number
  /** 网络可用性检查超时（ms） */
  pingTimeoutMs: number
  /** 默认质量权重（0-1），云端 TTS 表现力更强 */
  defaultQualityWeight: number
  /** 默认延迟权重（0-1），本地 TTS 延迟更低 */
  defaultLatencyWeight: number
  /** 网络检测缓存 TTL（ms） */
  networkCacheTtlMs: number
  /** 最低网络可用性：在此延迟以下视为"良好" */
  goodLatencyMs: number
}

/** 默认路由配置 */
export const DEFAULT_TTS_ROUTER_CONFIG: TtsRouterConfig = {
  maxLatencyMs: 400,
  pingTimeoutMs: 3000,
  defaultQualityWeight: 0.6,
  defaultLatencyWeight: 0.4,
  networkCacheTtlMs: 5000,
  goodLatencyMs: 150,
}

// ══════════════════════════════════════════
//  TTS × PiperTTS — Piper 性能信息（供 TtsRouter 使用）
// ══════════════════════════════════════════

/**
 * Piper 本地引擎的近期性能信息。
 *
 * 由 TtsPiperBridge 从 PiperOrchestrator 采集，注入 TtsRouter 的路由决策，
 * 使路由层能感知本地引擎的实时表现，做出更明智的 cloud/local 选择。
 */
export interface PiperPerformanceInfo {
  /** 最近合成的平均延迟（毫秒），-1 表示无数据 */
  recentLatencyMs: number
  /** 是否有任何模型近期失败率过高 */
  anyModelFailed: boolean
  /** 当前队列深度（等待中的合成数） */
  queueDepth: number
}

// ══════════════════════════════════════════
//  隐式反馈驱动的语音自适应
// ══════════════════════════════════════════

/** 用户对 TTS 输出的隐式行为类型 */
export type ImplicitFeedbackAction =
  /** 用户主动重听（点击重播）→ 积极信号 */
  | 'REPLAY'
  /** 用户跳过/停止播放 → 消极信号 */
  | 'SKIP'
  /** 用户打断 TTS 开始说话 → 轻微消极信号 */
  | 'INTERRUPT_SPEECH'
  /** 用户继续对话（未做任何反应地输入新消息）→ 中性偏积极信号 */
  | 'CONTINUE_CONVERSATION'
  /** 用户修改/重新表述指令 → 轻微消极信号（可能因 TTS 质量不满意） */
  | 'MODIFY_REQUEST'
  /** TTS 播放自然结束（未被打断/跳过）→ 积极信号 */
  | 'COMPLETED_NATURALLY'

/** 隐式反馈动作的数值权重 */
export const IMPLICIT_FEEDBACK_WEIGHTS: Record<ImplicitFeedbackAction, number> = {
  REPLAY: 2.0,
  SKIP: -2.0,
  INTERRUPT_SPEECH: -1.0,
  CONTINUE_CONVERSATION: 1.0,
  MODIFY_REQUEST: -1.0,
  COMPLETED_NATURALLY: 1.0,
}

/** 单次 TTS 输出记录 */
export interface TtsOutputRecord {
  /** 唯一标识 */
  outputId: string
  /** 输出时间戳 */
  timestamp: number
  /** 使用的 TTS 参数 */
  params: EmotionTtsParams
  /** 输出的文本摘要（前 100 字） */
  textSnippet: string
  /** 后续用户行为列表 */
  actions: Array<{
    action: ImplicitFeedbackAction
    timestamp: number
  }>
  /** 累计隐式反馈分数（正=受欢迎，负=不受欢迎） */
  cumulativeScore: number
}

/** 隐式反馈模型的参数推荐结果 */
export interface PreferenceRecommendation {
  /** 推荐的语言参数 */
  params: EmotionTtsParams
  /** 置信度 0-1（基于样本量） */
  confidence: number
  /** 模型学习到的总反馈样本数 */
  totalSamples: number
  /** 推荐的理由描述 */
  reason: string
}

/** 隐式反馈模型的配置 */
export interface ImplicitFeedbackConfig {
  /** 多少次输出后触发模型更新 */
  updateInterval: number
  /** 最小样本数要求（低于此值使用默认值） */
  minSamplesForRecommendation: number
  /** 推荐参数的混合权重（最终采纳比例 0-1） */
  blendWeight: number
  /** 历史记录最大保留数 */
  maxHistorySize: number
  /** 是否启用自动参数调整 */
  enabled: boolean
}

/** 默认隐式反馈模型配置 */
export const DEFAULT_IMPLICIT_FEEDBACK_CONFIG: ImplicitFeedbackConfig = {
  updateInterval: 10,
  minSamplesForRecommendation: 5,
  blendWeight: 0.15,
  maxHistorySize: 200,
  enabled: true,
}

// ══════════════════════════════════════════
//  用户情境上下文 (work / leisure / rest)
// ══════════════════════════════════════════

/**
 * 用户行为情境标签 — 基于活跃窗口、时间段、交互模式分类。
 *
 * 与 BehaviorEmotion（情绪状态）和 InteractionCadence（交流节奏）互补：
 *   - BehaviorEmotion: 用户怎么操作 → 焦躁/平静/专注
 *   - InteractionCadence: 用户交流节奏 → 急迫/正常/低频
 *   - UserContext: 用户当前活动类型 → 工作/休闲/休息
 */
export type UserContext = 'work' | 'leisure' | 'rest'

/** 情境感知的语音配置（含 edge-tts 参数 + Piper 模型推荐） */
export interface ContextVoiceConfig {
  /** edge-tts 语音角色 */
  voice: string
  /** 语速, e.g. '+12%' */
  rate: string
  /** 音调偏移, e.g. '+4Hz' */
  pitch: string
  /** 音量 0.0–1.0（仅本地播放有效） */
  volume: number
  /** Piper 推荐模型名 */
  piperModel: string
  /** Piper 语速因子 (0.5–2.0) */
  piperSpeed: number
  /** Piper 音调因子 */
  piperPitch: number
  /** 人类可读标签 */
  label: string
}

/** 情境 → 语音配置映射表 */
export const CONTEXT_VOICE_MAP: Record<UserContext, ContextVoiceConfig> = {
  /** 工作模式：语速稍快、音调清晰高效，音量适中 */
  work: {
    voice: 'zh-CN-YunyangNeural',
    rate: '+12%',
    pitch: '+4Hz',
    volume: 0.85,
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 1.1,
    piperPitch: 1.0,
    label: '工作·高效',
  },
  /** 休闲模式：语速自然、音调温暖亲切，音量正常 */
  leisure: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+8%',
    pitch: '+6Hz',
    volume: 0.9,
    piperModel: 'zh_CN-ling_ling-medium',
    piperSpeed: 0.95,
    piperPitch: 1.05,
    label: '休闲·放松',
  },
  /** 休息模式：语速放缓、音调轻柔，音量降低 */
  rest: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-5%',
    pitch: '-3Hz',
    volume: 0.7,
    piperModel: 'zh_CN-ling_ling-medium',
    piperSpeed: 0.8,
    piperPitch: 0.9,
    label: '休息·轻柔',
  },
}

/** 情境分类原始指标 */
export interface ContextIndicators {
  /** 活跃窗口标题 */
  activeWindowTitle: string | null
  /** 活跃进程名（不含路径） */
  activeProcessName: string | null
  /** 距上次交互的秒数 */
  idleSeconds: number
  /** 当前时段 */
  dayPeriod: DayPeriod
  /** 每分钟动作数（来自 BehaviorEmotionDetector） */
  apm: number
}

/** 情境分类结果 */
export interface ContextClassificationResult {
  /** 当前情境 */
  context: UserContext
  /** 置信度 0–1 */
  confidence: number
  /** 对应的语音配置 */
  voiceConfig: ContextVoiceConfig
  /** 人类可读描述 */
  description: string
  /** 原始分类指标 */
  indicators: ContextIndicators
}

/** 情境手动覆盖模式 */
export type ContextOverrideMode = 'auto' | 'manual_work' | 'manual_leisure' | 'manual_rest'

/** 情境覆盖模式 → UserContext 映射 */
export const CONTEXT_OVERRIDE_MAP: Record<ContextOverrideMode, UserContext | null> = {
  auto: null,
  manual_work: 'work',
  manual_leisure: 'leisure',
  manual_rest: 'rest',
}

/** 平滑过渡配置 */
export interface SmoothTransitionConfig {
  /** 过渡持续时间（秒） */
  durationSec: number
  /** 过渡是否启用 */
  enabled: boolean
}

/** 默认平滑过渡配置 */
export const DEFAULT_SMOOTH_TRANSITION: SmoothTransitionConfig = {
  durationSec: 20,
  enabled: true,
}

/** 默认 UserContextClassifier 配置 */
export const DEFAULT_USER_CONTEXT_CLASSIFIER_CONFIG = {
  /** 活跃窗口轮询间隔（毫秒） */
  pollIntervalMs: 5000,
  /** 交互超时判定（秒）：超过此时间无交互视为 idle */
  idleThresholdSec: 120,
  /** 最小置信度阈值：低于此值回退到默认情境 */
  minConfidence: 0.3,
  /** 分类去抖时间（秒）：同一分类持续此时间后才切换，防止频繁抖动 */
  debounceSec: 30,
  /** 分类缓存有效期（毫秒） */
  cacheTtlMs: 10000,
}

// ══════════════════════════════════════════
//  工作相关进程关键词（用于 UserContextClassifier）
// ══════════════════════════════════════════

/** 工作类窗口标题/进程名关键词列表 */
export const WORK_PROCESS_PATTERNS: RegExp[] = [
  // 开发工具
  /\bcode\b|vscode|visual.?studio/i,
  /intellij|webstorm|pycharm|clion|goland|idea/i,
  /terminal|cmd|powershell|git.?bash|wsl|conemu|alacritty|kitty|wezterm/i,
  /sublime|atom|notepad\+\+|vim|neovim|emacs/i,
  /eclipse|netbeans|android.?studio|xcode/i,
  /docker|kubernetes|k9s|lens|rancher/i,
  /postman|insomnia|bruno|httpie/i,
  // 办公协作
  /outlook|thunderbird|mail/i,
  /slack|teams|discord|zoom|meet|teams/i,
  /excel|word|powerpoint|onenote|office/i,
  /jira|confluence|notion|linear|asana|trello|click.?up/i,
  /figma|sketch|adobe.?xd|photoshop|illustrator/i,
  // 数据库
  /pgadmin|datagrip|mysql.?workbench|dbeaver|heidisql|navicat|redis.?desktop/i,
  // 远程
  /putty|ssh|mobaxterm|winSCP|filezilla/i,
  // 代码仓库
  /github|gitlab|bitbucket|source.?tree/i,
  // 终端中的常见工作目录特征
  /node|npm|yarn|pnpm|python|java|gcc|make|cmake|dotnet|rustc|go\b|deno|bun/i,
  /dev|src|project|workspace|code.*dir/i,
]

/** 休闲类窗口标题/进程名关键词列表 */
export const LEISURE_PROCESS_PATTERNS: RegExp[] = [
  // 媒体娱乐
  /spotify|itunes|music|netease|qq.?music|foobar|winamp/i,
  /youtube|bilibili|netflix|hbo|disney\+|prime.?video|crunchyroll/i,
  /vlc|mpv|media.?player|potplayer|kmplayer/i,
  /steam|epic|battle\.net|gog|origin|uplay|xbox|playstation/i,
  /game|minecraft|lol|dota|csgo|valorant|overwatch|apex|genshin/i,
  // 社交
  /wechat|qq\b|telegram|whatsapp|line|messenger|signal/i,
  /reddit|twitter|x\.com|instagram|facebook|tiktok|discord/i,
  // 阅读
  /kindle|calibre|ebook|reader|pocket/i,
  // 购物
  /taobao|jd|amazon|shopee|lazada|ebay|pinduoduo/i,
  /browser.*(?:shop|mall|buy|cart)/i,
]
