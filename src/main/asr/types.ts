export interface AsrResult {
  text: string
  duration: number
  raw?: string
  hits?: HotwordHit[]
  /** 从用户语音声学特征分析出的情感（仅在 GPU/CPU Whisper 路径可用） */
  voiceEmotion?: VoiceEmotion
}
export type ProgressCallback = (pct: number, status: string) => void
export interface HotwordHit { hotword: string; count: number }

// ══════════════════════════════════════════
//  语音情感类型 — 从声学特征（音高、能量、语速）推断
// ══════════════════════════════════════════

/** 语音情感标签 */
export type VoiceEmotionLabel =
  | 'neutral'   // 中性 — 常规交流状态
  | 'happy'     // 开心 — 能量偏高、语调丰富
  | 'sad'       // 悲伤 — 能量低、音调低、语速慢
  | 'angry'     // 生气 — 能量高、音调高、语速快
  | 'calm'      // 平静 — 能量中低、语调平稳
  | 'anxious'   // 焦虑 — 音调变化剧烈、节奏急促

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
