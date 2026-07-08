export interface AsrResult { text: string; duration: number; raw?: string; hits?: HotwordHit[] }
export type ProgressCallback = (pct: number, status: string) => void
export interface HotwordHit { hotword: string; count: number }

/** 从 Memory 提取的对话上下文，用于动态热词/提示词构建 */
export interface AsrConversationContext {
  /** 最近对话的主题标签 */
  topics: string[]
  /** 最近对话涉及的关键实体（人名、项目名、专业术语等） */
  keyEntities: string[]
  /** 最近一条用户消息文本（可选，用于语义相关提示） */
  recentUserText?: string
}
