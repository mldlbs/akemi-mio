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
