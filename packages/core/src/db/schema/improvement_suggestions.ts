/**
 * improvement_suggestions — 失败学习改进建议表
 *
 * 由 FailureLearningService 的 LLM 分析生成，
 * 存储对 system prompt、工具描述、任务模板等的改进建议。
 *
 * 建议生命周期：
 *   pending → applied → verified | rollback_needed → rollback_applied
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const improvementSuggestions = sqliteTable('improvement_suggestions', {
  /** 唯一标识 */
  id: text('id').primaryKey(),
  /** 建议类型: modify_system_prompt | modify_tool_description | modify_task_template | modify_agent_config */
  suggestionType: text('suggestion_type').notNull(),
  /** 目标名称（工具名、prompt 片段名、模板名） */
  targetName: text('target_name').notNull(),

  /** 当前值（修改前） */
  currentValue: text('current_value').notNull(),
  /** 建议的新值 */
  suggestedValue: text('suggested_value').notNull(),
  /** 变更理由（LLM 分析得出） */
  rationale: text('rationale').notNull(),

  /** 关联的失败模式摘要 */
  failurePattern: text('failure_pattern'),

  /** 状态: pending | applied | rejected | rollback_needed | rollback_applied */
  status: text('status').notNull().default('pending'),
  /** 如果已应用, 关联的快照 ID */
  snapshotId: text('snapshot_id'),

  /** 创建时间 */
  createdAt: integer('created_at').notNull(),
  /** 应用时间 */
  appliedAt: integer('applied_at'),
  /** 回滚时间 */
  rolledBackAt: integer('rolled_back_at'),

  /** 应用后下一周期的失败率变化 */
  failureRateDelta: real('failure_rate_delta'),
})

export type ImprovementSuggestion = typeof improvementSuggestions.$inferSelect
export type NewImprovementSuggestion = typeof improvementSuggestions.$inferInsert
