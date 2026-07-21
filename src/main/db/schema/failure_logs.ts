/**
 * failure_logs — Agent 执行失败日志表
 *
 * 每次 Agent 执行任务失败时记录一条日志，包含：
 * - 失败元信息（时间、来源、错误类型）
 * - 工具状态（当前工具链上下文）
 * - LLM 输出（导致失败的输出片段）
 * - 环境快照（system prompt、任务描述等）
 *
 * 供 FailureLearningService 在进化周期中消费，
 * 通过 LLM 分析失败原因并生成改进建议。
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const failureLogs = sqliteTable('failure_logs', {
  /** 唯一标识 */
  id: text('id').primaryKey(),
  /** 失败发生的任务/请求 ID */
  requestId: text('request_id').notNull(),
  /** 失败类型: tool | llm | intent | timeout | crash | task */
  errorType: text('error_type').notNull(),
  /** 错误名称（如工具名、LLM 模型名） */
  errorName: text('error_name').notNull(),
  /** 错误消息摘要 */
  errorMessage: text('error_message').notNull(),
  /** 完整错误堆栈/详情 */
  errorDetail: text('error_detail'),

  /** 失败时的工具状态（JSON） */
  toolState: text('tool_state'),
  /** 导致失败的 LLM 输出片段 */
  llmOutput: text('llm_output'),
  /** 失败时的任务描述 */
  taskDescription: text('task_description'),
  /** system prompt 快照 */
  systemPrompt: text('system_prompt'),

  /** 是否已分析（evolution 分析后标记） */
  analyzed: integer('analyzed', { mode: 'boolean' }).notNull().default(false),
  /** LLM 分析结果（JSON） */
  analysisResult: text('analysis_result'),
  /** 该失败是否已生成改进建议 */
  hasSuggestion: integer('has_suggestion', { mode: 'boolean' }).notNull().default(false),
  /** 关联的改进建议 ID（如已生成） */
  suggestionId: text('suggestion_id'),

  /** 创建时间 */
  createdAt: integer('created_at').notNull(),
  /** 分析时间 */
  analyzedAt: integer('analyzed_at'),
})

export type FailureLog = typeof failureLogs.$inferSelect
export type NewFailureLog = typeof failureLogs.$inferInsert
