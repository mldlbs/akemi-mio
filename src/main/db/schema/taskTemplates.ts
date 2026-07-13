import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const taskTemplates = sqliteTable('task_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  triggerKeywords: text('trigger_keywords').notNull(),        // JSON array
  toolSequence: text('tool_sequence').notNull(),               // JSON array of TemplateStep
  source: text('source', { enum: ['auto', 'user', 'edited'] }).notNull().default('auto'),
  status: text('status', { enum: ['active', 'disabled', 'archived'] }).notNull().default('active'),
  useCount: integer('use_count').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  lastUsedAt: integer('last_used_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
