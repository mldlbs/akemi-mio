import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const guardrailDecisions = sqliteTable('guardrail_decisions', {
  decisionId: text('decision_id').primaryKey(),
  traceId: text('trace_id').notNull(),
  turn: integer('turn').notNull(),
  action: text('action').notNull(),
  runtimeAction: text('runtime_action').notNull(),
  policyVersion: text('policy_version').notNull(),
  signals: text('signals').notNull(), // JSON serialized
  decidedAt: integer('decided_at').notNull(),
})

export type GuardrailDecisionRow = typeof guardrailDecisions.$inferSelect
