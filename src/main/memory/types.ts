export interface MemoryEntry {
  id: string
  type: 'user_fact' | 'interaction' | 'task_state' | 'user_profile' | 'fictional' | 'writing_feedback'
  content: string
  confidence: number
  createdAt: number
  updatedAt: number
  /** 记忆层级：permanent=永不移除 | semi=半永久慢衰减 | ephemeral=临时 */
  tier: 'permanent' | 'semi' | 'ephemeral'
  /** 强化次数（用于自动晋升） */
  reinforceCount: number
  /** 结构化附加数据（JSON 字符串），用于 task_state / user_profile */
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
