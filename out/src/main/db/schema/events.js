import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const events = sqliteTable('events', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channel: text('channel').notNull(),
    payload: text('payload').notNull(),
    source: text('source'),
    traceId: text('trace_id'),
    timestamp: integer('timestamp').notNull(),
});
