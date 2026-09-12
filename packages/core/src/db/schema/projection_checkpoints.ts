import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const projectionCheckpoints = sqliteTable('projection_checkpoints', {
  projectionName: text('projection_name').primaryKey(),
  lastSeq: integer('last_seq').notNull(),
  lastUpdatedAt: integer('last_updated_at').notNull(),
  status: text('status').notNull().default('idle'),
  error: text('error'),
})

export type ProjectionCheckpointRow = typeof projectionCheckpoints.$inferSelect
