/**
 * TaskTemplate — 智能任务模板类型定义
 *
 * 描述一个可复用的任务模式，包含触发关键词、工具调用序列、使用统计。
 */

/** 工具调用序列中的单步 */
export interface TemplateStep {
  /** 工具名称 */
  toolName: string
  /** 该步的输入参数模板（JSON 模板字符串，用 {placeholder} 占位） */
  argsTemplate?: string
  /** 可选描述 */
  description?: string
}

/** 任务模板状态 */
export type TemplateStatus = 'active' | 'disabled' | 'archived'

/** 任务模板定义 */
export interface TaskTemplate {
  /** 唯一 ID */
  id: string
  /** 用户可读的名称 */
  name: string
  /** 详细描述 */
  description: string
  /** 触发关键词列表（用户消息匹配用） */
  triggerKeywords: string[]
  /** 工具调用序列（有序） */
  toolSequence: TemplateStep[]
  /** 生成来源：'auto'（自动发现）| 'user'（用户创建）| 'edited'（用户编辑自自动模板） */
  source: 'auto' | 'user' | 'edited'
  /** 状态 */
  status: TemplateStatus
  /** 使用次数 */
  useCount: number
  /** 成功次数（用户未打断/纠正视为成功） */
  successCount: number
  /** 最近使用时间戳 */
  lastUsedAt: number | null
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 模板匹配结果 */
export interface TemplateMatch {
  /** 匹配到的模板 */
  template: TaskTemplate
  /** 匹配分数 0-1 */
  score: number
  /** 匹配原因 */
  reason: string
  /** 匹配到的关键词 */
  matchedKeywords: string[]
}

/** 工具调用序列快照（用于模式提取） */
export interface ToolCallSequence {
  /** 关联的 session ID */
  sessionId: string
  /** 工具调用列表（有序） */
  toolNames: string[]
  /** 用户意图描述 */
  intentLabel: string
  /** 用户输入摘要 */
  userInputSummary: string
  /** 时间戳 */
  timestamp: number
}

/** 聚类结果 */
export interface SequenceCluster {
  /** 聚类 ID */
  id: string
  /** 序列列表 */
  sequences: ToolCallSequence[]
  /** 共同工具模式（有序交集） */
  commonToolPattern: string[]
  /** 共同意图标签 */
  commonIntentLabel: string
  /** 出现次数 */
  occurrenceCount: number
}

/** 模式提取选项 */
export interface PatternExtractOptions {
  /** 最小序列长度（工具调用数） */
  minSequenceLength?: number
  /** 最小出现次数才算模式 */
  minOccurrences?: number
  /** 分析窗口（最近 N 条消息） */
  analysisWindow?: number
  /** 时间窗口（毫秒），仅分析此时间范围内的消息 */
  timeWindowMs?: number
}
