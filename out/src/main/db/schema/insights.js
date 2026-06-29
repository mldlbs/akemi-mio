import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
export const insights = sqliteTable('insights', {
    id: text('id').primaryKey(),
    detector: text('detector').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    evidence: text('evidence').notNull(),
    score: real('score').notNull(),
    confidence: real('confidence').notNull(),
    reported: integer('reported', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
});
