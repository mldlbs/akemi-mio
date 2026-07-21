/**
 * asr-adapter/AsrBehaviorTypes — ASR→UserBehavior 适配器类型定义
 *
 * 定义适配层的数据交换格式，使 ASR 领域的数据模型和判断规则
 * 可以被 UserBehavior 子系统消费，而不修改 UserBehavior 的内部类型。
 *
 * 适配器模式：
 *   ASR 领域（VoiceEmotion、AcousticEnvironment、Confidence 等）
 *     ↓ AsrBehaviorAdapter.map*()
 *   适配层（AsrBehaviorInput → AsrBehaviorOutput）
 *     ↓ UserBehaviorLayer hook / EventBus
 *   UserBehavior 子系统（BehaviorMode、ActivityContext 等）
 *
 * POC 阶段支持的 ASR 数据源：
 * 1. VoiceEmotion — 语音情感（6 标签 + 声学特征）
 * 2. AcousticEnvironment — 声学环境分类（安静/噪声/远场/音乐/混响）
 * 3. Confidence — 识别置信度评分（含文本/音频特征判断规则）
 * 4. Hotword Domain Stats — 热词领域分布
 */

// ═══════════════════════════════════════════════════
//  1. 适配器输入 — 来自 ASR 领域的数据
// ═══════════════════════════════════════════════════

/**
 * 适配器接受的 ASR VoiceEmotion 输入（精简版，仅取适配所需的字段）。
 * 对应 src/main/asr/types.ts 中的 VoiceEmotion 类型。
 */
export interface AsrVoiceEmotionInput {
  /** 主导情感标签 */
  label: 'neutral' | 'happy' | 'sad' | 'angry' | 'calm' | 'anxious'
  /** 各情感标签的归一化分值 (0–1) */
  scores: Record<string, number>
  /** 置信度 0–1 */
  confidence: number
  /** 声学特征摘要 */
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

/**
 * 适配器接受的 ASR AcousticEnvironment 输入（精简版）。
 * 对应 src/main/asr/AsrAcousticEnvironmentClassifier.ts 的 classify 输出。
 */
export interface AsrEnvironmentInput {
  /** 环境类型 */
  environment: 'quiet' | 'noisy' | 'far_field' | 'music_bg' | 'reverberant' | 'unknown'
  /** 分类置信度 0–1 */
  confidence: number
  /** 环境参数摘要（仅取适配所需的关键字段） */
  params: {
    /** 噪声过滤是否启用 */
    noiseFilter: boolean
    /** 置信度阈值偏移 */
    confidenceThresholdOffset: number
  }
}

/**
 * 适配器接受的 ASR Confidence 输入（精简版）。
 * 对应 src/main/asr/AsrConfidenceScorer.ts 的评分规则。
 */
export interface AsrConfidenceInput {
  /** 识别文本 */
  text: string
  /** 综合置信度分值 0–1 */
  score: number
  /** 文本特征分值 0–1 */
  textScore: number
  /** 音频特征分值 0–1（无音频特征时为 1） */
  audioScore: number
  /** 是否检测为低置信度 */
  isLowConfidence: boolean
  /** 匹配到的幻觉模式（如有） */
  hallucinationMatch?: string
}

/**
 * 适配器接受的 ASR Hotword 领域统计输入（精简版）。
 * 对应 src/main/asr/AsrHotwordManager.ts 的 DomainStats。
 */
export interface AsrDomainStatInput {
  /** 领域名称 */
  domain: string
  /** 该领域的词条数 */
  count: number
}

// ═══════════════════════════════════════════════════
//  2. 适配器输出 — UserBehavior 可消费的格式
// ═══════════════════════════════════════════════════

/**
 * 行为情境提示 — 由 ASR 数据推导的活动情境补充信息。
 * 可被 UserBehaviorService.detectActivityContext() 消费，
 * 或通过 PreProcessContext 注入 UserBehaviorLayer。
 */
export interface BehaviorContextHint {
  /** 用户当前环境描述（来自声学环境分类） */
  environmentLabel: string
  /** 环境是否安静（安静环境可能意味着专注） */
  isQuiet: boolean
  /** 是否处于噪声环境（可能影响交互响应方式） */
  isNoisy: boolean
  /** 基于语音情感推断的用户情绪状态摘要 */
  voiceEmotionSummary: string
  /** 语音能量水平 0–1（高能量 = 活跃） */
  voiceEnergy: number
  /** 基于语音特征的"活跃度"评分 0–1 */
  activityScore: number
}

/**
 * ASR 驱动的质量信号 — 可被 UserBehavior 质量指标追踪器消费。
 * 对应 QualityMetricsTracker 的 MetricSnapshot 格式。
 */
export interface AsrQualitySignal {
  /** 信号名称 */
  name: string
  /** 当前值 0–1 */
  value: number
  /** 指标描述 */
  description: string
}

/**
 * 完整的适配器输出 — 一次 ASR 调用经适配后的数据。
 */
export interface AsrBehaviorOutput {
  /** 行为情境提示 */
  contextHint: BehaviorContextHint | null
  /** 质量信号列表（可注入 UserBehavior 质量指标追踪） */
  qualitySignals: AsrQualitySignal[]
  /** 适配过程中生成的日志/消息 */
  messages: string[]
  /** 适配是否成功 */
  success: boolean
}

// ═══════════════════════════════════════════════════
//  3. 适配器配置
// ═══════════════════════════════════════════════════

export interface AsrBehaviorAdapterConfig {
  /** 是否启用 VoiceEmotion → BehaviorContext 映射 */
  enableVoiceEmotionMapping: boolean
  /** 是否启用 AcousticEnvironment → BehaviorContext 映射 */
  enableEnvironmentMapping: boolean
  /** 是否启用 Confidence → QualitySignal 映射 */
  enableConfidenceMapping: boolean
  /** 是否为 POC 模式（减少日志输出，只输出核心转换结果） */
  pocMode: boolean
  /** 调试模式（输出每个映射步骤的详细日志） */
  debug: boolean
}

export const DEFAULT_ADAPTER_CONFIG: AsrBehaviorAdapterConfig = {
  enableVoiceEmotionMapping: true,
  enableEnvironmentMapping: true,
  enableConfidenceMapping: true,
  pocMode: true,
  debug: false,
}

// ═══════════════════════════════════════════════════
//  4. 适配器状态
// ═══════════════════════════════════════════════════

export interface AdapterState {
  /** 总适配次数 */
  totalAdaptations: number
  /** 成功次数 */
  successfulAdaptations: number
  /** 最近一次适配的时间戳 */
  lastAdaptationTimestamp: number
  /** 最近一次适配的结果摘要 */
  lastResult?: string
}
