import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const guardrailMetrics = sqliteTable('guardrail_metrics', {
  id: text('id').primaryKey(),
  windowSince: integer('window_since').notNull(),
  windowUntil: integer('window_until').notNull(),
  checkedCount: integer('checked_count').notNull().default(0),
  warningCount: integer('warning_count').notNull().default(0),
  terminatedCount: integer('terminated_count').notNull().default(0),
  continueCount: integer('continue_count').notNull().default(0),
  totalSignalsHealthy: integer('total_signals_healthy').notNull().default(0),
  totalSignalsDegrading: integer('total_signals_degrading').notNull().default(0),
  totalSignalsStalled: integer('total_signals_stalled').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
})

export type GuardrailMetricsRow = typeof guardrailMetrics.$inferSelect
