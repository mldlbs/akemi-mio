/**
 * 记忆情感标签 — 存储对话时的情感分析结果
 * 序列化为 JSON 存储在 structuredData 中（key="emotion"）
 *
 * 支持两种情感模型：
 * 1. 极性模型（polarity/score）：轻量关键词匹配
 * 2. 维度模型（valence/arousal）：连续情感向量，构成情感时间序列
 */
export interface MemoryEmotionTag {
  /** 情感极性 */
  polarity: 'positive' | 'negative' | 'neutral'
  /** 置信度 0–1 */
  score: number
  /** 情感标签：happy / sad / angry / calm / anxious / neutral */
  label: string
  /** 内容类型：weather / error / success / news / code / data / chat / info */
  contentType: string
  /** 匹配到的情感关键词（前 5 个） */
  matchedWords: string[]
  /** 分析时间戳 */
  timestamp: number
  /**
   * 情感维度：效价（愉悦度）
   * -1.0 (极度不悦) ~ +1.0 (极度愉悦)
   * 用于构造情感时间序列和叙事曲线
   */
  valence?: number
  /**
   * 情感维度：唤醒度（激活度）
   * -1.0 (极度平静/低迷) ~ +1.0 (极度兴奋/紧张)
   * 用于构造情感时间序列和叙事曲线
   */
  arousal?: number
}

/** 语音记忆书签 */
/**
 * 计划对话记忆 — 按计划 ID 存储的对话上下文摘要
 */
export interface PlanConversationData {
  /** 关联的计划 ID */
  planId: string
  /** 计划标题 */
  planTitle: string
  /** 用户消息摘要 */
  userMessageSummary: string
  /** 助手回复摘要 */
  assistantReplySummary: string
  /** 记录时间戳 */
  timestamp: number
}

export interface VoiceBookmark {
  /** 书签 ID（与 MemoryEntry.id 一致） */
  id: string
  /** 摘要文本 */
  summary: string
  /** 语音文件绝对路径（由 PiperTTS 生成） */
  audioPath: string
  /** 语音合成文本（用于重听） */
  audioText: string
  /** 语音合成耗时（毫秒） */
  ttsDurationMs: number
  /** 语音合成引擎 */
  ttsEngine: string
  /** 书签创建时间戳 */
  bookmarkedAt: number
  /** 关联的对话上下文（最近 N 轮） */
  conversationContext: Array<{ role: 'user' | 'assistant'; content: string; createdAt: number }>
  /** 标签列表 */
  tags: string[]
  /** 是否已收藏 */
  isFavorite: boolean
}

export interface MemoryEntry {
  id: string
  type:
    | 'user_fact'
    | 'interaction'
    | 'task_state'
    | 'task_step'
    | 'user_profile'
    | 'fictional'
    | 'writing_feedback'
    | 'polishing_decision'
    | 'blog_memory'
    | 'voice_bookmark'
    | 'evolution_insight'
    | 'evolution_cycle'
    | 'plan_snapshot'
    | 'plan_conversation'
    | 'writing_decision'
    | 'revision_preference'
  content: string
  confidence: number
  createdAt: number
  updatedAt: number
  /** 记忆层级：permanent=永不移除 | semi=半永久慢衰减 | ephemeral=临时 */
  tier: 'permanent' | 'semi' | 'ephemeral'
  /** 强化次数（用于自动晋升） */
  reinforceCount: number
  /** 结构化附加数据（JSON 字符串），用于 task_state / user_profile / emotion */
  structuredData?: string | null
  /** 行为驱动重要性得分 (0-1)，初始 0.5 */
  behaviorScore: number
  /** 上次被访问/引用的时间戳 */
  lastAccessedAt: number
  /** 累计被访问/引用次数 */
  accessCount: number
  /** 是否被用户手动固定（不受自动清理影响） */
  isPinned: boolean
  /** 人工设置的得分覆盖（null=使用自动计算得分） */
  manualScoreOverride: number | null
  /** 主题标签（用于行为驱动加权检索） */
  topics?: string[]
  /** ── 效用跟踪字段 ── */
  /** 效用分数 (0-1)，表示记忆在 Agent 决策中的实际使用价值，初始 0.5 */
  utilityScore: number
  /** Agent 引用该记忆的次数（由效用跟踪器记录） */
  agentReferenceCount: number
  /** 用户明确确认有用的次数 */
  userConfirmedUsefulCount: number
  /** 上次效用评估时间 */
  lastUtilityUpdateAt: number
}

export interface InteractionRecord {
  id: string
  /** 用户消息文本（截断至 200 字符） */
  userText: string
  /** 响应耗时（毫秒） */
  responseTimeMs: number | null
  /** 识别的主题标签 */
  topics: string[]
  /** 用户是否明确要求"记住" */
  isExplicitRemember: boolean
  /** 本次交互中重新提及的记忆 ID 列表 */
  rementionedMemoryIds: string[]
  /** 交互发生时间 */
  timestamp: number
  createdAt: number
}

export interface MemoryStore {
  version: number
  updatedAt: number
  entries: MemoryEntry[]
}

export interface SummaryEntry {
  id: string
  summary: string
  turnStart: number
  turnEnd: number
  /** 本次对话的主题词 */
  topics: string[]
  /** 本次对话做出的决策 */
  decisions: string[]
  /** 涉及的实体 */
  keyEntities: string[]
  createdAt: number
}

export interface VectorEntry {
  id: string
  content: string
  embedding: number[]
  confidence: number
  source: 'user_fact' | 'summary'
  createdAt: number
  updatedAt: number
}
// ============================================================
//  ???? / ?????? / ??-????
// ============================================================

/** ??????? */
export interface PreferenceSummary {
  key: string
  value: string
  category: string
}

/** ????????? Agent ????? */
export interface ConsecutiveDayTopic {
  /** ???? */
  topic: string
  /** ?????? */
  consecutiveDayCount: number
  /** ??????? */
  firstSeenAt: number
  /** ??????? */
  lastSeenAt: number
  /** ???????? */
  totalDayCount: number
}

/** ???????? */
export interface TopicToolMapping {
  /** ???? */
  topic: string
  /** ???????????? */
  tools: string[]
  /** ?????? */
  description: string
}

/** ?????MemorySnapshotManager ????????? */
export interface MemorySnapshot {
  /** ?? ID */
  id: string
  /** ????? */
  createdAt: number
  /** ?????????? */
  compressedSummary: string
  /** ?????? */
  topTopics: string[]
  /** ?????? */
  preferences: PreferenceSummary[]
  /** ?????? */
  consecutiveDayTopics: ConsecutiveDayTopic[]
  /** ????????? */
  suggestedTools: string[]
  /** ???????????? */
  openingSuggestion: string
  /** ???? */
  version: number
  /** ???????? ID ?? */
  basedOnSummaryIds: string[]
}
