import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const decisions = sqliteTable('decisions', {
  id: text('id').primaryKey(),
  timestamp: integer('timestamp').notNull(),
  agentId: text('agent_id').notNull(),
  category: text('category', {
    enum: ['tool_select', 'strategy', 'plan_route', 'goal_adjust', 'recovery'],
  }).notNull(),
  context: text('context').notNull(),
  choice: text('choice').notNull(),
  alternatives: text('alternatives').notNull().default('[]'),
  outcome: text('outcome', { enum: ['pending', 'success', 'failure'] })
    .notNull()
    .default('pending'),
  confidence: real('confidence').notNull().default(0.5),
  relatedPlanId: text('related_plan_id'),
  createdAt: integer('created_at').notNull(),
})
