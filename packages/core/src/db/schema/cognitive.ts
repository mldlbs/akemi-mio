import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  priority: integer('priority').notNull().default(0),
  status: text('status', { enum: ['active', 'paused', 'completed', 'abandoned'] })
    .notNull()
    .default('active'),
  category: text('category', { enum: ['mission', 'long_term', 'short_term', 'initiative'] }).notNull(),
  parentGoalId: text('parent_goal_id'),
  progress: integer('progress').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const strategies = sqliteTable('strategies', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  promptTemplate: text('prompt_template').notNull(),
  applicableContext: text('applicable_context').notNull(),
  priority: integer('priority').notNull().default(0),
  active: integer('active').notNull().default(1),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const promptTemplates = sqliteTable('prompt_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category', { enum: ['identity', 'core', 'tools', 'evolution', 'custom'] }).notNull(),
  content: text('content').notNull(),
  version: integer('version').notNull().default(1),
  active: integer('active').notNull().default(1),
  variables: text('variables').notNull().default('[]'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
