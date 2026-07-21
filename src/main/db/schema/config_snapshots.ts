/**
 * config_snapshots — 配置快照表
 *
 * 每次 FailureLearningService 自动修改配置前，
 * 先复制当前配置快照到该表。若下一周期检测到
 * 失败率上升，则自动回滚到最近的快照。
 *
 * 支持多类型配置：
 * - tool_description: 工具描述文本
 * - system_prompt: Agent system prompt 片段
 * - task_template: 任务模板
 * - agent_config: Agent 整体配置
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const configSnapshots = sqliteTable('config_snapshots', {
  /** 唯一标识 */
  id: text('id').primaryKey(),
  /** 快照类型 */
  snapshotType: text('snapshot_type').notNull(), // 'tool_description' | 'system_prompt' | 'task_template' | 'agent_config'
  /** 配置键名（如工具名、prompt 片段名） */
  configKey: text('config_key').notNull(),
  /** 快照前的配置内容（JSON 字符串） */
  oldValue: text('old_value').notNull(),
  /** 快照后的新配置内容（JSON 字符串） */
  newValue: text('new_value'),

  /** 关联的改进建议 ID */
  suggestionId: text('suggestion_id'),
  /** 关联的失败记录 ID */
  failureLogId: text('failure_log_id'),

  /** 是否已回滚 */
  rolledBack: integer('rolled_back', { mode: 'boolean' }).notNull().default(false),
  /** 回滚时间戳 */
  rolledBackAt: integer('rolled_back_at'),

  /** 快照创建时间 */
  createdAt: integer('created_at').notNull(),

  /** 快照后下一周期的失败率（回滚判定用） */
  postFailureRate: real('post_failure_rate'),
  /** 快照前一周期的失败率 */
  preFailureRate: real('pre_failure_rate'),
})

export type ConfigSnapshot = typeof configSnapshots.$inferSelect
export type NewConfigSnapshot = typeof configSnapshots.$inferInsert
