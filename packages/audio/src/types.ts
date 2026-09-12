/**
 * audio/types.ts — 音频特征与故事氛围参数类型定义
 *
 * 用于语音情感引导续写氛围功能：
 * 1. AudioFeatureExtractor → 从 PCM 提取韵律特征
 * 2. AtmosphereMapper → 特征 → 故事氛围分值
 * 3. VoiceContinuationService → 氛围分值作为生成约束
 */

// ══════════════════════════════════════════
//  音频韵律特征（从 PCM 原始音频计算）
// ══════════════════════════════════════════

export interface AudioFeatures {
  /** 平均能量 (RMS)，归一化 0–1 */
  energy: number
  /** 能量方差 0–1，越高表示情绪波动越大 */
  energyVariance: number
  /** 能量变化趋势：-1（持续下降）到 +1（持续上升），0=平稳 */
  energyTrend: number
  /** 估计的平均基频 (Hz)，0=无声/无法估计 */
  pitchHz: number
  /** 基频方差 (Hz)，越高表示语调变化越剧烈 */
  pitchVariance: number
  /** 基频范围 (Hz)，最高音与最低音的差值 */
  pitchRange: number
  /** 过零率平均值 0–1，衡量语音粗糙度/紧张度 */
  avgZeroCrossingRate: number
  /** 过零率方差 */
  zcrVariance: number
  /** 语速（有效语音段的平均帧数/秒） */
  speechRate: number
  /** 无声段比例 0–1（总时长中静音占比） */
  silenceRatio: number
  /** 有效语音段的数量（反映说话的连续性） */
  voiceSegmentCount: number
  /** 音频总时长（秒） */
  durationSec: number
}

// ══════════════════════════════════════════
//  故事氛围参数（用于约束 LLM 生成）
// ══════════════════════════════════════════

export interface StoryAtmosphere {
  /** 紧张度 0–1 */
  tension: number
  /** 欢乐度 0–1 */
  joy: number
  /** 悲伤度 0–1 */
  sadness: number
  /** 平静度 0–1 */
  calmness: number
  /** 神秘度 0–1 */
  mystery: number
  /** 浪漫度 0–1 */
  romance: number
  /** 主导氛围标签（取分值最高者） */
  dominantLabel: string
  /** 置信度 0–1 */
  confidence: number
  /** 该氛围标签的中文描述（用于注入 prompt） */
  description: string
}

// ══════════════════════════════════════════
//  氛围映射权重配置（可调参数 ≡ "简单映射模型"）
// ══════════════════════════════════════════

/**
 * 音频特征 → 氛围维度的线性映射权重。
 * 每个氛围维度由一组特征加权求和得到。
 * 可视为一个轻量可训练的线性模型（调整 weights 即训练）。
 */
export interface AtmosphereMappingWeights {
  /** 紧张度权重: {高能量, 高能量方差, 高音调, 高音调方差, 高过零率, 低平静度} */
  tension: {
    energy: number
    energyVariance: number
    pitch: number
    pitchVariance: number
    zcr: number
  }
  /** 欢乐度权重: {中高能量, 中高音调, 低过零率, 低静音比, 多语音段} */
  joy: {
    energy: number
    pitch: number
    zcr: number
    silence: number
    segments: number
  }
  /** 悲伤度权重: {低能量, 低音调, 低音调方差, 高静音比, 单调能量} */
  sadness: {
    energy: number
    pitch: number
    pitchVariance: number
    silence: number
    energyVariance: number
  }
  /** 平静度权重: {中低能量, 低能量方差, 低过零率, 低静音比, 稳定} */
  calmness: {
    energy: number
    energyVariance: number
    zcr: number
    pitchRange: number
    energyTrend: number
  }
  /** 神秘度权重: {低声, 低音调, 高静音比, 低能量方差, 低语速} */
  mystery: {
    energy: number
    pitch: number
    silence: number
    energyVariance: number
    speechRate: number
  }
  /** 浪漫度权重: {中能量, 中音调, 低过零率, 低静音比, 稳定语调} */
  romance: {
    energy: number
    pitch: number
    zcr: number
    silence: number
    pitchRange: number
  }
}

/** 默认映射权重（经验值） */
export const DEFAULT_ATMOSPHERE_WEIGHTS: AtmosphereMappingWeights = {
  tension: { energy: 0.3, energyVariance: 0.25, pitch: 0.15, pitchVariance: 0.15, zcr: 0.15 },
  joy: { energy: 0.25, pitch: 0.2, zcr: -0.2, silence: -0.15, segments: 0.2 },
  sadness: { energy: -0.3, pitch: -0.2, pitchVariance: -0.15, silence: 0.2, energyVariance: -0.15 },
  calmness: { energy: -0.15, energyVariance: -0.25, zcr: -0.2, pitchRange: -0.2, energyTrend: 0.2 },
  mystery: { energy: -0.2, pitch: -0.15, silence: 0.25, energyVariance: -0.2, speechRate: -0.2 },
  romance: { energy: 0.15, pitch: 0.2, zcr: -0.2, silence: -0.2, pitchRange: 0.25 },
}

// ══════════════════════════════════════════
//  氛围标签定义
// ══════════════════════════════════════════

export interface AtmosphereLabelDef {
  /** 英文标识 */
  key: string
  /** 中文标签 */
  label: string
  /** 描述（用于生成指令） */
  description: string
  /** 对应的写作风格指令片段 */
  writingHint: string
}

export const ATMOSPHERE_LABELS: AtmosphereLabelDef[] = [
  {
    key: 'tension',
    label: '紧张',
    description: '紧张、压迫感、悬疑笼罩',
    writingHint: '营造紧张氛围，节奏紧凑，悬念迭起，读者心跳加速',
  },
  {
    key: 'joy',
    label: '欢乐',
    description: '欢乐、温馨、轻松愉快',
    writingHint: '氛围明亮欢快，文字轻快流畅，充满温暖与笑容',
  },
  {
    key: 'sadness',
    label: '悲伤',
    description: '悲伤、忧郁、感伤',
    writingHint: '营造伤感氛围，文字舒缓低沉，带有淡淡的忧伤与怀念',
  },
  {
    key: 'calmness',
    label: '平静',
    description: '平静、安宁、祥和',
    writingHint: '氛围平和安宁，描写舒缓自然，节奏平缓有序',
  },
  {
    key: 'mystery',
    label: '神秘',
    description: '神秘、诡异、未知',
    writingHint: '营造神秘氛围，悬念伏笔交错，文字朦胧含蓄',
  },
  {
    key: 'romance',
    label: '浪漫',
    description: '浪漫、温柔、甜蜜',
    writingHint: '氛围温馨浪漫，文字柔软细腻，情感含蓄而动人',
  },
]

export interface AsrResult {
  text: string
  duration: number
  raw?: string
  hits?: HotwordHit[]
  /** 从用户语音声学特征分析出的情感（仅在 GPU/CPU Whisper 路径可用） */
  voiceEmotion?: VoiceEmotion
}
export type ProgressCallback = (pct: number, status: string) => void
export interface HotwordHit {
  hotword: string
  count: number
}

// ══════════════════════════════════════════
//  语音情感类型 — 从声学特征（音高、能量、语速）推断
// ══════════════════════════════════════════

/** 语音情感标签 */
export type VoiceEmotionLabel =
  | 'neutral' // 中性 — 常规交流状态
  | 'happy' // 开心 — 能量偏高、语调丰富
  | 'sad' // 悲伤 — 能量低、音调低、语速慢
  | 'angry' // 生气 — 能量高、音调高、语速快
  | 'calm' // 平静 — 能量中低、语调平稳
  | 'anxious' // 焦虑 — 音调变化剧烈、节奏急促

/** 语音情感分析结果 */
export interface VoiceEmotion {
  /** 主导情感标签 */
  label: VoiceEmotionLabel
  /** 各情感标签的归一化分值 (0–1) */
  scores: Record<VoiceEmotionLabel, number>
  /** 置信度 0–1 */
  confidence: number
  /** 原始声学特征摘要（供调试/UI 展示） */
  features: {
    /** 平均能量 0–1 */
    energy: number
    /** 平均基频 (Hz) */
    pitchHz: number
    /** 语速（有效帧/秒） */
    speechRate: number
    /** 无声段比例 0–1 */
    silenceRatio: number
  }
}

/** 从 Memory 提取的对话上下文，用于动态热词/提示词构建 */
export interface AsrConversationContext {
  /** 最近对话的主题标签 */
  topics: string[]
  /** 最近对话涉及的关键实体（人名、项目名、专业术语等） */
  keyEntities: string[]
  /** 最近一条用户消息文本（可选，用于语义相关提示） */
  recentUserText?: string
}

// ══════════════════════════════════════════
//  Memory-ASR 混合流水线类型定义
// ══════════════════════════════════════════

/** Memory 路径生成的语音假设（基于对话上下文的预测） */
export interface MemoryAsrHypothesis {
  /** 预测的文本内容（基于上下文的预期用户发言） */
  predictedText: string
  /** 预测的置信度 (0–1)，取决于上下文丰富度 */
  confidence: number
  /** 预期关键词列表（用于交叉验证匹配） */
  expectedKeywords: string[]
  /** 预测来源的元信息 */
  sources: {
    /** 对话摘要主题 */
    topics: string[]
    /** 关键实体 */
    entities: string[]
    /** 话题转移预测的下一话题 */
    predictedTopics: string[]
    /** 兴趣画像关键词 */
    interestProfile: string[]
  }
  /** 生成时间戳 */
  timestamp: number
}

/** 交叉验证结果 */
export interface CrossValidationResult {
  /** 一致度 (0–1)，ASR 文本与 Memory 假设的匹配程度 */
  agreementLevel: number
  /** 命中的关键词 */
  matchedKeywords: string[]
  /** 未命中的关键词 */
  unmatchedKeywords: string[]
  /** 置信度调整值 (-0.2 ~ +0.2) */
  confidenceAdjustment: number
}

/** 仲裁结果 */
export interface ArbitrationResult {
  /** 最终输出文本 */
  finalText: string
  /** 最终置信度 */
  finalConfidence: number
  /** 主要来源 */
  source: 'asr_primary' | 'memory_primary' | 'fused'
  /** 是否触发了仲裁 */
  arbitrationTriggered: boolean
  /** 仲裁说明（用于日志/调试） */
  reason: string
}

/** Memory-ASR 混合流水线的完整输出 */
export interface AsrHybridResult {
  /** 最终文本 */
  text: string
  /** 请求 ID */
  requestId: string
  /** 主要来源 */
  source: 'asr_only' | 'asr_primary' | 'memory_primary' | 'fused'
  /** 交叉验证一致度 */
  agreementLevel: number
  /** 是否触发仲裁 */
  arbitrationTriggered: boolean
  /** 原始 ASR 文本（仲裁前） */
  asrText: string
  /** Memory 假设（如果有） */
  memoryHypothesis: MemoryAsrHypothesis | null
  /** 最终置信度 */
  confidence: number
  /** 语音情感（来自 ASR 路径） */
  voiceEmotion?: VoiceEmotion
}

/** 混合流水线配置 */
export interface HybridPipelineConfig {
  /** 是否启用混合流水线 */
  enabled: boolean
  /** 一致度阈值 — 低于此值触发仲裁 */
  agreementThreshold: number
  /** ASR 最低置信度 — 低于此值 Memory 假设可能被采纳 */
  asrMinConfidence: number
  /** Memory 假设最低置信度 — 低于此值不被采纳 */
  memoryMinConfidence: number
  /** 是否启用 LLM 深度语义仲裁（会增加延迟和消耗） */
  enableLlmArbitration: boolean
}

/**
 * Speech Plugin Contracts — ASR / TTS 插件契约定义
 *
 * 设计原则：
 * 1. 插件 API 的稳定性直接影响生态建设，变更前请评估兼容性。
 * 2. 每个插件实现单一契约（AsrPlugin | TtsPlugin），职责边界清晰。
 * 3. 插件无需关心 SpeechPluginRegistry 的内部调度，只需聚焦于接口实现。
 *
 * 对照现有的 EvolutionPlugin 模式，本模块提供了类似的 ServiceLoader 架构，
 * 但独立于 evolution 系统，专用于语音处理领域。
 *
 * 扩展自 Plugin Registry 统一抽象层（src/main/plugin/registry/types.ts）：
 * - SpeechPluginManifest 扩展 IPluginManifest（增加 capability 字段）
 * - AsrPlugin / TtsPlugin 结构兼容 IPlugin 接口（可通过适配器使用）
 */

import type { IPluginManifest } from '@akemi-mio/intelligence-plugin/registry/types'

// ══════════════════════════════════════════
//  插件元数据
// ══════════════════════════════════════════

/** 插件能力类型 — ASR（语音识别）或 TTS（语音合成） */
export type SpeechCapability = 'asr' | 'tts'

/**
 * 插件元数据。
 * 扩展自 IPluginManifest（统一抽象层），增加 capability 字段。
 */
export interface SpeechPluginManifest extends IPluginManifest {
  /** 唯一标识名，例如 'whisper_gpu', 'baidu_asr', 'piper_tts', 'edge_tts' */
  name: string
  /** 语义版本 */
  version: string
  /** 人类可读描述 */
  description: string
  /** 插件能力类型 */
  capability: SpeechCapability
  /** 作者（可选） */
  author?: string
  /** 优先级（数值越大越优先，默认 0） */
  priority?: number
}

// ══════════════════════════════════════════
//  ASR 插件契约
// ══════════════════════════════════════════

/**
 * ASR 引擎状态。
 * 结构兼容 IPluginStatus（统一抽象层）：
 * - ready 等价于 loaded（语义相同，字段名不同）
 * - loading / error 字段与 IPluginStatus 一致
 */
export interface AsrPluginStatus {
  /** 是否已加载就绪（兼容 IPluginStatus.ready） */
  loaded: boolean
  /** 是否正在加载中 */
  loading: boolean
  /** 错误信息（有错误时非 null） */
  error: string | null
  /** 统一状态字段 — 等价于 loaded，用于 IPluginStatus 兼容 */
  readonly ready: boolean
}

/** ASR 转录选项 */
export interface AsrTranscribeOptions {
  /** 超时时间（毫秒） */
  timeoutMs?: number
  /** 请求唯一标识 */
  requestId?: string
  /** 进度回调 */
  onProgress?: ProgressCallback
  /** 初始提示词 */
  initialPrompt?: string
  /** 热词列表 */
  hotwords?: string[]
}

/** ASR 转录结果 */
export interface AsrTranscribeResult {
  text: string
  duration: number
  raw?: string
  hits?: Array<{ hotword: string; count: number }>
  requestId?: string
}

/**
 * ASR 插件接口。
 *
 * 实现此接口的类将成为 SpeechPluginRegistry 可发现的 ASR 引擎。
 * 插件只需关注音频 → 文本的转换逻辑，不需要了解 AsrService 的调度策略、
 * 降级回退或上下文注入细节。
 *
 * 结构兼容统一抽象层 IPlugin（src/main/plugin/registry/types.ts）：
 * - getModelInfo() → IPlugin.getInfo()（语义相同，方法名不同）
 * - getStatus() → IPlugin.getStatus()（返回类型结构兼容）
 */
export interface AsrPlugin {
  /** 插件元数据 */
  readonly manifest: SpeechPluginManifest

  /**
   * 对音频数据进行语音识别。
   * @param audio Float32Array PCM 数据（16kHz, mono）
   * @param options 可选配置
   * @returns 转录结果
   */
  transcribe(audio: Float32Array, options?: AsrTranscribeOptions): Promise<AsrTranscribeResult>

  /**
   * 获取当前引擎状态。
   */
  getStatus(): AsrPluginStatus

  /**
   * 获取引擎信息（供调试/UI 展示）。
   * 兼容 IPlugin.getInfo()。
   */
  getModelInfo(): string

  /**
   * 获取引擎信息（统一接口别名）。
   * 与 IPlugin.getInfo() 对齐，默认委托给 getModelInfo()。
   */
  getInfo(): string

  // ── 生命周期钩子（可选） ──

  /**
   * 初始化引擎（模型加载等）。
   * 在注册后由 SpeechPluginRegistry.loadAll() 调用。
   */
  initialize?(config?: unknown): Promise<void>

  /**
   * 引擎卸载前的清理。
   */
  onUnload?(): Promise<void>

  /**
   * 设置动态初始提示词（可选，用于上下文注入）。
   */
  setInitialPrompt?(prompt: string | null): void

  /**
   * 设置动态热词列表（可选，用于上下文注入）。
   */
  setHotwords?(hotwords: string[] | null): void

  /**
   * 清除所有动态覆盖（可选）。
   */
  resetContextOverrides?(): void
}

// ══════════════════════════════════════════
//  TTS 插件契约
// ══════════════════════════════════════════

/**
 * TTS 引擎状态。
 * 结构兼容 IPluginStatus（统一抽象层）：
 * - available → ready（语义对应：available = 可用的）
 * - error 字段与 IPluginStatus 一致
 */
export interface TtsPluginStatus {
  /** 引擎是否可用（兼容 IPluginStatus.ready） */
  available: boolean
  /** 错误信息（有错误时非 null） */
  error: string | null
}

/** TTS 合成选项 */
export interface TtsSynthesizeOptions {
  /** 语音角色名 */
  voice?: string
  /** 语速，如 '+10%' */
  rate?: string
  /** 音调偏移，如 '+8Hz' */
  pitch?: string
  /** 音量 0.0–1.0 */
  volume?: number
  /** 语速因子（用于本地引擎） */
  speedFactor?: number
  /** 音调因子（用于本地引擎） */
  pitchFactor?: number
  /** 超时时间（毫秒） */
  timeoutMs?: number
}

/** TTS 合成结果 */
export interface TtsSynthesizeResult {
  /** 合成的音频文件路径 */
  audioFile: string
  /** 合成耗时（毫秒） */
  durationMs: number
  /** 是否成功 */
  success: boolean
  /** 错误信息（当 success = false 时） */
  error?: string
  /** 是否使用了回退模型 */
  fallbackUsed?: boolean
}

/**
 * TTS 插件接口。
 *
 * 实现此接口的类将成为 SpeechPluginRegistry 可发现的 TTS 引擎。
 * 插件只需关注文本 → 音频的转换逻辑，不需要了解 TtsService 的路由策略、
 * 队列管理或情感参数混合细节。
 *
 * 结构兼容统一抽象层 IPlugin（src/main/plugin/registry/types.ts）：
 * - getInfo() 直接实现 IPlugin.getInfo()
 * - getStatus() 返回类型结构兼容 IPluginStatus
 */
export interface TtsPlugin {
  /** 插件元数据 */
  readonly manifest: SpeechPluginManifest

  /**
   * 将文本合成为音频文件。
   * @param text 要合成的文本
   * @param options 可选配置
   * @returns 合成结果
   */
  synthesize(text: string, options?: TtsSynthesizeOptions): Promise<TtsSynthesizeResult>

  /**
   * 获取当前引擎状态。
   */
  getStatus(): TtsPluginStatus

  /**
   * 获取引擎信息（供调试/UI 展示）。
   * 兼容 IPlugin.getInfo()。
   */
  getModelInfo(): string

  /**
   * 获取引擎信息（统一接口别名）。
   * 与 IPlugin.getInfo() 对齐，默认委托给 getModelInfo()。
   */
  getInfo(): string

  // ── 生命周期钩子（可选） ──

  /**
   * 初始化引擎。
   * 在注册后由 SpeechPluginRegistry.loadAll() 调用。
   */
  initialize?(config?: unknown): Promise<void>

  /**
   * 引擎卸载前的清理。
   */
  onUnload?(): Promise<void>
}


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
  /**
   * 紧急度 0–1
   * 0 = 不紧急（闲聊、日常信息），1 = 非常紧急（错误告警、时间敏感通知）
   * 由 SentimentAnalyzer 中的紧急关键词检测驱动
   */
  urgency: number
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
  | 'cheerful' // 欢快 — 好消息、成功反馈、轻松闲聊
  | 'serious' // 严肃 — 警告、错误、重要通知
  | 'gentle' // 温柔 — 安慰、关怀、夜间模式
  | 'neutral' // 中性 — 信息播报、数据汇报
  | 'warm' // 温暖 — 问候、感谢、日常陪伴
  | 'energetic' // 活力 — 激励、庆祝、高能量时刻
  | 'calm' // 沉稳 — 技术解释、分析、教导
  | 'playful' // 俏皮 — 玩笑、娱乐、创意内容

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
 * 行为情绪标签 — 从用户实时交互行为（APM、窗口切换、鼠标抖动、撤回频率、操作间隔）推断的情绪状态。
 *
 * 与 SentimentPolarity（基于 AI 回复内容的文本情感）互补：
 *   - SentimentPolarity: 内容说了什么 → 正面/负面/中性
 *   - BehaviorEmotion: 用户怎么交互 → 急躁/疲惫/愉悦/平静/专注/中性
 *
 * 新增疲惫/愉悦标签说明：
 *   - tired (疲惫): 深夜+低APM+操作缓慢 → TTS 温柔轻声
 *   - joyful (愉悦): 完成任务/高频但不急躁的交互 → TTS 欢快语调
 */
export type BehaviorEmotion = 'anxious' | 'tired' | 'joyful' | 'calm' | 'focused' | 'neutral'

/** 行为情绪 → TTS 参数预设映射表 */
export const BEHAVIOR_EMOTION_TTS_MAP: Record<BehaviorEmotion, EmotionTtsParams> = {
  /** 焦躁 — 语速降低、语调更柔和，起安抚作用 */
  anxious: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-8%',
    pitch: '-4Hz',
    label: '安抚·焦躁',
  },
  /** 疲惫 — 语速放缓、音调低沉、温柔轻声，提供共情陪伴 */
  tired: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-12%',
    pitch: '-6Hz',
    label: '温柔·疲惫',
  },
  /** 愉悦 — 语速轻快、音调偏高，传递共鸣喜悦 */
  joyful: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+18%',
    pitch: '+12Hz',
    label: '欢快·愉悦',
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

// ══════════════════════════════════════════
//  用户输入文本情感 — 基于用户输入文本关键词分析的情绪检测
// ══════════════════════════════════════════

/**
 * 用户输入文本情感标签 — 从用户输入的文本内容（关键词匹配）推断的情绪状态。
 *
 * 与 BehaviorEmotion（用户怎么操作 → 焦躁/平静/专注/中性）互补：
 *   - BehaviorEmotion: 用户怎么操作（APM/窗口切换/鼠标抖动）
 *   - UserInputEmotion: 用户说了什么（文本关键词 → 愤怒/悲伤/喜悦/中性）
 *
 * 用于 UserInputEmotionAnalyzer 的输出，驱动 TTS 同音色下的情绪匹配合成。
 */
export type UserInputEmotion = 'angry' | 'sad' | 'joyful' | 'neutral'

/** 用户输入文本情感分析结果 */
export interface UserInputEmotionResult {
  /** 当前情绪标签 */
  emotion: UserInputEmotion
  /** 置信度 0–1 */
  confidence: number
  /** 匹配到的情感词 */
  matchedWords: string[]
  /** 对应的 TTS 参数预设 */
  ttsParams: EmotionTtsParams
  /** 是否检测到连续相同情绪（≥3次） */
  consecutiveEmotion: boolean
  /** 当前情绪的连续出现次数 */
  consecutiveCount: number
}

/**
 * 用户输入文本情感 → TTS 参数预设映射表。
 *
 * 设计原则：
 *   angry  → 语速和音调显著提高（+20%），匹配用户的高涨情绪
 *   sad    → 语速放缓、音调低沉，添加停顿感（温柔安慰）
 *   joyful → 语速轻快、音调偏高，传递共鸣喜悦
 *   neutral → 默认参数，不覆盖
 */
export const USER_INPUT_EMOTION_TTS_MAP: Record<UserInputEmotion, EmotionTtsParams> = {
  /** 愤怒 — 语速加快、音调提高，匹配用户的激动情绪 */
  angry: {
    voice: 'zh-CN-YunjianNeural',
    rate: '+20%',
    pitch: '+15Hz',
    label: '共鸣·愤怒',
  },
  /** 悲伤 — 语速放缓、音调低沉，温柔安慰 */
  sad: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '-10%',
    pitch: '-8Hz',
    label: '安抚·悲伤',
  },
  /** 喜悦 — 语速轻快、音调偏高，传递共鸣喜悦 */
  joyful: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+18%',
    pitch: '+12Hz',
    label: '共鸣·喜悦',
  },
  /** 中性 — 默认参数，不覆盖 */
  neutral: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+10%',
    pitch: '+8Hz',
    label: '中性·用户输入',
  },
}

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
  /** 时间窗口内的撤回/重做次数 */
  totalRetractions: number
  /** 每分钟撤回/重做次数 */
  retractionsPerMin: number
  /** 最近交互的平均间隔（秒），用于检测操作缓慢 */
  meanInteractionIntervalSec: number
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
  /** 文本情感强度（绝对值 0-1），未分析时为 -1 */
  emotionStrength?: number
  /** 文本长度（词数），未分析时为 -1 */
  textLength?: number
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
  /** [混合TTS] RTT 阈值（ms）：RTT 超过此值时短低情感文本使用本地 Piper */
  rttPiperThresholdMs: number
  /** [混合TTS] 最低情感强度：低于此值且文本短 → 倾向本地 Piper */
  minEmotionForCloud: number
  /** [混合TTS] 短文本词数上限：低于此值且低情感 → 倾向本地 Piper */
  maxShortTextWords: number
}

/** 默认路由配置 */
export const DEFAULT_TTS_ROUTER_CONFIG: TtsRouterConfig = {
  maxLatencyMs: 400,
  pingTimeoutMs: 3000,
  defaultQualityWeight: 0.6,
  defaultLatencyWeight: 0.4,
  networkCacheTtlMs: 5000,
  goodLatencyMs: 150,
  /** RTT > 100ms 时低情感短文本使用 Piper */
  rttPiperThresholdMs: 100,
  /** 情感强度 < 0.4 视为低情感 */
  minEmotionForCloud: 0.4,
  /** 词数 < 10 视为短文本 */
  maxShortTextWords: 10,
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

// ══════════════════════════════════════════
//  情感维度模型与叙事情绪曲线
// ══════════════════════════════════════════

/**
 * 情感向量 — 连续维度情感表示
 * 使用效价-唤醒度二维模型（Valence-Arousal Model）
 */
export interface EmotionVector {
  /** 效价（愉悦度）-1.0 ~ +1.0 */
  valence: number
  /** 唤醒度（激活度）-1.0 ~ +1.0 */
  arousal: number
}

/**
 * 情绪曲线的单时间点
 */
export interface EmotionTimeSeriesPoint {
  /** 时间戳（毫秒） */
  timestamp: number
  /** 情感向量 */
  emotionVector: EmotionVector
  /** 可读标签（如 "开心"、"悲伤"） */
  label: string
  /** 源消息文本摘要 */
  snippet: string
}

/**
 * 叙事情感段落 — Agent 回复中的一个情感段落
 * Agent 将其回复按情感变化切分为多个段落，每段分配独立的情感参数
 */
export interface NarrativeEmotionSegment {
  /** 段落文本 */
  text: string
  /** 目标语音风格标签 */
  style: VoiceStyle
  /** 风格强度 0.0–1.0 */
  styleDegree: number
  /** 目标情感向量 */
  emotionVector: EmotionVector
  /**
   * SpeakingStyle 名称（边缘 TTS 参数，如 "cheerful" / "sad"）
   * 映射关系见 SPEAKING_STYLE_VOICE_MAP
   */
  speakingStyle?: string
}

/**
 * 叙事情绪曲线 — 一组有序的情感段落
 */
export interface NarrativeEmotionCurve {
  /** 段落列表（有序） */
  segments: NarrativeEmotionSegment[]
  /** 整体情绪趋势描述 */
  trendDescription: string
  /** 原始记忆情感时间序列源数据摘要 */
  sourceTimeSeries?: EmotionTimeSeriesPoint[]
}

/**
 * 语音风格 → 边缘 TTS SpeakingStyle 参数映射
 *
 * 边缘 TTS 支持以下 SpeakingStyle 值：
 * cheerful, sad, angry, fearful, excited, friendly, whispering, shouting,
 * hopeful, surprised, warm, determined, empathetic, neutral
 *
 * 注意：Piper 本地引擎不支持 SpeakingStyle，仅云端 edge-tts 可用
 */
export const SPEAKING_STYLE_VOICE_MAP: Record<VoiceStyle, string> = {
  cheerful: 'cheerful',
  serious: 'determined',
  gentle: 'warm',
  neutral: 'neutral',
  warm: 'friendly',
  energetic: 'excited',
  calm: 'empathetic',
  playful: 'happy',
}

/** 默认叙事情绪曲线（无情感数据时的回退值） */
export const DEFAULT_NARRATIVE_CURVE: NarrativeEmotionCurve = {
  segments: [],
  trendDescription: '平稳',
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
//  Piper 行为感知场景 — 行为感知语音自适应的场景识别
// ══════════════════════════════════════════

/**
 * Piper 场景 — 行为感知语音自适应的细粒度场景分类。
 *
 * 与 UserContext（work/leisure/rest）的关系：
 * - work → 可细分为 focus（深度专注）和 meeting（会议/通话）
 * - rest → 可细分为 late_night（深夜模式）
 * - 其他场景保留原语义
 *
 * 这些场景专为 PiperTTS 参数映射设计，控制模型选择/语速/音调/音量。
 * 由 PiperSceneAdaptor 基于现有分类器信号推导得出。
 */
export type PiperScene = 'focus' | 'meeting' | 'late_night' | 'work' | 'leisure' | 'rest'

/** Piper 场景配置 — 场景到 PiperTTS 语音参数的映射（模型/语速/音调/音量） */
export interface PiperSceneConfig {
  /** Piper 模型名 */
  piperModel: string
  /** Piper 语速因子 (0.5–2.0) */
  piperSpeed: number
  /** Piper 音调因子 */
  piperPitch: number
  /** 音量 0.0–1.0（仅本地播放有效） */
  volume: number
  /** 人类可读标签 */
  label: string
}

/**
 * 场景 → Piper 语音参数映射表。
 *
 * 设计原则：
 * - focus（专注）:  中速清晰，huayan-medium（通用女声）
 * - meeting（会议）: 低速轻柔，避免打扰会议，音量降低
 * - late_night（深夜）: 低速低音调，ling_ling-medium（温柔女声），音量最低
 * - work（工作）:    中高速，huayan-medium，音量适中
 * - leisure（休闲）: 中速温暖，ling_ling-medium（温柔女声），音量正常
 * - rest（休息）:    低速柔和，ling_ling-medium，音量较低
 */
export const PIPER_SCENE_MAP: Record<PiperScene, PiperSceneConfig> = {
  focus: {
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 1.1,
    piperPitch: 1.0,
    volume: 0.8,
    label: '专注·高效',
  },
  meeting: {
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 0.9,
    piperPitch: 0.95,
    volume: 0.6,
    label: '会议·轻柔',
  },
  late_night: {
    piperModel: 'zh_CN-ling_ling-medium',
    piperSpeed: 0.75,
    piperPitch: 0.85,
    volume: 0.5,
    label: '深夜·静谧',
  },
  work: {
    piperModel: 'zh_CN-huayan-medium',
    piperSpeed: 1.1,
    piperPitch: 1.0,
    volume: 0.85,
    label: '工作·高效',
  },
  leisure: {
    piperModel: 'zh_CN-ling_ling-medium',
    piperSpeed: 0.95,
    piperPitch: 1.05,
    volume: 0.9,
    label: '休闲·放松',
  },
  rest: {
    piperModel: 'zh_CN-ling_ling-medium',
    piperSpeed: 0.8,
    piperPitch: 0.9,
    volume: 0.7,
    label: '休息·轻柔',
  },
}

/** 场景覆盖模式：auto 自动检测，或手动锁定到特定场景 */
export type PiperSceneOverrideMode = 'auto' | PiperScene

/** 场景手动覆盖的学习记录 — 用户手动切换场景的偏好统计 */
export interface SceneOverrideRecord {
  /** 场景 */
  scene: PiperScene
  /** 手动覆盖到此场景的次数 */
  count: number
  /** 最后一次覆盖的时间戳 */
  lastOverride: number
}

/** 场景自适应结果 */
export interface PiperSceneResult {
  /** 当前检测到的场景 */
  scene: PiperScene
  /** 对应的 Piper 语音配置 */
  config: PiperSceneConfig
  /** 置信度 0–1 */
  confidence: number
  /** 人类可读描述 */
  description: string
  /** 是否来自用户手动覆盖 */
  isManualOverride: boolean
}

/** 场景自适应配置 */
export interface PiperSceneAdaptorConfig {
  /** 是否启用场景自适应 */
  enabled: boolean
  /** 手动覆盖模式（auto = 自动检测） */
  overrideMode: PiperSceneOverrideMode
  /** 是否启用学习（记录手动覆盖以优化映射） */
  learningEnabled: boolean
  /** 学习数据文件路径 */
  learningDataPath: string
  /** 场景切换去抖时间（秒），防止频繁切换 */
  debounceSec: number
  /** 学习生效所需的最低记录数 */
  minRecordsForLearning: number
}

/** 默认场景自适应配置 */
export const DEFAULT_PIPER_SCENE_ADAPTOR_CONFIG: PiperSceneAdaptorConfig = {
  enabled: true,
  overrideMode: 'auto',
  learningEnabled: true,
  learningDataPath: '',
  debounceSec: 30,
  minRecordsForLearning: 3,
}

/**
 * 会议应用关键词 — 用于从活跃窗口检测会议/通话场景。
 * 与 WORK_PROCESS_PATTERNS 互补，将会议类应用匹配到 meeting 场景。
 */
export const MEETING_PROCESS_PATTERNS: RegExp[] = [
  // 视频会议
  /zoom|teams|meet\.google|google.?meet|webex|gotomeeting|bluejeans/i,
  /skype|slack.?call|discord.?call|whereby|jitsi/i,
  // 屏幕共享/演示
  /obs.?studio|streamlabs|xsplit/i,
  // 电话/通话
  /phone|dialer|call/i,
  // 会议在窗口标题中的特征
  /meeting|conference|presentation|webinar|会议|通话/i,
]

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
// ============================================================
//  QoS 评估 / 设备负载 / 发音纠正 / 语音增强 / 预加载缓冲
// ============================================================

/** 实时设备负载信息（CPU / 内存占用） */
export interface DeviceLoadInfo {
  /** CPU 占用率 0-100 */
  cpuPercent: number
  /** 内存占用率 0-100 */
  memoryPercent: number
  /** 采样时间戳 */
  timestamp: number
}

/** QoS 综合评估分数 */
export interface QoSScore {
  /** 综合得分 0-1 */
  score: number
  /** 网络维度得分 0-1 */
  networkScore: number
  /** 设备维度得分 0-1 */
  deviceScore: number
  /** 网络延迟ms值，-1 表示尚未测得 */
  networkLatencyMs: number
  /** 设备负载快照 */
  deviceLoad: DeviceLoadInfo
  /** 推荐使用的 TTS 引擎 */
  recommendedEngine: 'cloud' | 'local'
  /** 触发降级的原因 */
  degradationReason: string
  /** 评估时间戳 */
  timestamp: number
}

/** QoSEvaluator 配置项 */
export interface QoSEvaluatorConfig {
  /** 是否启用 QoS 监控 */
  enabled: boolean
  /** 监控采样间隔ms数 */
  monitorIntervalMs: number
  /** 网络延迟阈值ms，低于此值网络得分按 1.0 计 */
  networkLatencyThresholdMs: number
  /** 网络延迟上限ms，高于此值网络得分按 0.0 计 */
  networkLatencyMaxMs: number
  /** CPU 占用率阈值%，低于此值设备得分按 1.0 计 */
  cpuThresholdPercent: number
  /** CPU 占用率上限%，高于此值设备得分按 0.0 计 */
  cpuMaxPercent: number
  /** 内存占用率阈值%，低于此值设备得分按 1.0 计 */
  memoryThresholdPercent: number
  /** 内存占用率上限%，高于此值设备得分按 0.0 计 */
  memoryMaxPercent: number
  /** 建议切换到本地引擎的得分阈值 */
  recommendLocalThreshold: number
  /** 强制切换到本地引擎的得分阈值 */
  forceLocalThreshold: number
}

/** 默认 QoS 评估配置 */
export const DEFAULT_QOS_EVALUATOR_CONFIG: QoSEvaluatorConfig = {
  enabled: true,
  monitorIntervalMs: 10000,
  networkLatencyThresholdMs: 100,
  networkLatencyMaxMs: 300,
  cpuThresholdPercent: 60,
  cpuMaxPercent: 90,
  memoryThresholdPercent: 70,
  memoryMaxPercent: 95,
  recommendLocalThreshold: 0.5,
  forceLocalThreshold: 0.3,
}

/** 发音纠正记录 */
export interface PronunciationCorrection {
  /** 待纠正的词/短语 */
  word: string
  /** 纠正后的文本 */
  corrected: string
  /** 记录创建时间 */
  createdAt: number
  /** 纠正置信度 0-1 */
  confidence: number
  /** 该词出现的上下文 */
  context?: string
}

/** 语音增强结果 */
export interface EnhancementResult {
  /** 增强后的文本 */
  text: string
  /** 推导出的 TTS 参数 */
  params: EmotionTtsParams
  /** 识别出的主题列表 */
  topics: string[]
  /** 是否应用了发音纠正 */
  correctionsApplied: boolean
  /** 主题与语气是否已匹配 */
  topicToneMatched: boolean
  /** 本次增强的说明 */
  description: string
}

/** 会话开场问候结果 */
export interface SessionGreetingResult {
  /** 问候语文本 */
  greeting: string
  /** 上次会话摘要 */
  lastSummary: string
  /** 上次会话主题列表 */
  lastTopics: string[]
  /** 问候置信度 0-1 */
  confidence: number
}

/** 预加载缓冲条目 */
export interface PreloadBufferEntry {
  /** 待合成的文本 */
  text: string
  /** 使用的合成引擎 */
  engine: 'cloud' | 'local'
  /** 合成产物音频文件 */
  audioFile: string
  /** 合成时间戳 */
  synthesizedAt: number
  /** 合成时使用的情绪参数 */
  emotionParams: EmotionTtsParams
  /** 是否已校验通过 */
  verified: boolean
}

/** 预加载缓冲配置 */
export interface PreloadBufferConfig {
  /** 是否启用预加载 */
  enabled: boolean
  /** 触发预加载的文本长度阈值，单位为字符数 */
  preloadThresholdChars: number
  /** 缓冲区最大条目数 */
  maxEntries: number
  /** 条目存活时长ms数 */
  entryTtlMs: number
}

/** 预加载缓冲运行状态 */
export interface PreloadBufferState {
  /** 当前缓冲条目数 */
  entryCount: number
  /** 是否启用 */
  enabled: boolean
  /** 最近一次引擎切换记录 */
  lastSwitch: {
    fromEngine: 'cloud' | 'local'
    toEngine: 'cloud' | 'local'
    usedPreloaded: boolean
    timestamp: number
  } | null
  /** 累计预加载命中次数 */
  totalPreloadHits: number
  /** 累计引擎切换次数 */
  totalSwitches: number
}

/** 默认预加载缓冲配置 */
export const DEFAULT_PRELOAD_BUFFER_CONFIG: PreloadBufferConfig = {
  enabled: true,
  preloadThresholdChars: 50,
  maxEntries: 10,
  entryTtlMs: 5 * 60 * 1000,
}
