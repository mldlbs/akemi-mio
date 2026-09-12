import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const evaluationEvents = sqliteTable('evaluation_events', {
  id: text('id').primaryKey(),
  timestamp: integer('timestamp').notNull(),
  traceId: text('trace_id').notNull(),
  sessionId: text('session_id').notNull(),
  source: text('source').notNull(),
  type: text('type').notNull(),
  payload: text('payload').notNull(), // JSON serialized
  parentEventId: text('parent_event_id'),
  /** Replay 游标序号（R2-A）。flush 时分配，非 append。已有行可 NULL。 */
  seq: integer('seq'),
})

export type EvaluationEventRow = typeof evaluationEvents.$inferSelect
