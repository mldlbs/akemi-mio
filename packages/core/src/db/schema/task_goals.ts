import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const taskGoals = sqliteTable('task_goals', {
  id: text('id').primaryKey(),
  sessionId: text('session_id'),
  objective: text('objective').notNull(),
  successCriteria: text('success_criteria').notNull().default('[]'),
  status: text('status', { enum: ['planning', 'executing', 'blocked', 'completed', 'abandoned'] })
    .notNull()
    .default('planning'),
  planId: text('plan_id'),
  methodology: text('methodology'),
  currentStep: integer('current_step').notNull().default(0),
  evidence: text('evidence').notNull().default('[]'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  completedAt: integer('completed_at'),
})
