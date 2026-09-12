import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const sessionCompactions = sqliteTable('session_compactions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  source: text('source', { enum: ['electron', 'telegram'] }).notNull(),

  // 自然语言摘要
  digest: text('digest').notNull(),

  // 结构化字段（JSON 序列化）
  topics: text('topics').notNull().default('[]'),
  entities: text('entities').notNull().default('[]'), // Array<{name, type, salience}>
  facts: text('facts').notNull().default('[]'), // Array<FactChange>
  decisions: text('decisions').notNull().default('[]'), // Array<DecisionRecord>
  unresolved: text('unresolved').notNull().default('[]'),

  // 元数据
  importanceScore: real('importance_score').notNull().default(0.5),
  messageCount: integer('message_count').notNull().default(0),
  tokenCount: integer('token_count').notNull().default(0),
  sessionStartAt: integer('session_start_at').notNull(),
  sessionEndAt: integer('session_end_at').notNull(),
  createdAt: integer('created_at').notNull(),

  // 触发原因（observation_threshold / production_threshold / idle）
  triggerReason: text('trigger_reason').notNull().default('production_threshold'),
})

export type SessionCompactionRow = typeof sessionCompactions.$inferSelect
export type SessionCompactionInsert = typeof sessionCompactions.$inferInsert
