import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
export const memories = sqliteTable('memories', {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['user_fact', 'interaction'] }).notNull(),
    content: text('content').notNull(),
    confidence: real('confidence').notNull().default(0.5),
    tier: text('tier', { enum: ['permanent', 'semi', 'ephemeral'] }).notNull().default('ephemeral'),
    reinforceCount: integer('reinforce_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
});
export const memoryArchive = sqliteTable('memory_archive', {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['user_fact', 'interaction'] }).notNull(),
    content: text('content').notNull(),
    confidence: real('confidence').notNull(),
    tier: text('tier', { enum: ['permanent', 'semi', 'ephemeral'] }).notNull(),
    reason: text('reason').notNull().default('pruned'),
    archivedAt: integer('archived_at').notNull(),
});
export const knowledgeGraph = sqliteTable('knowledge_graph', {
    id: text('id').primaryKey(),
    entity: text('entity').notNull(),
    attribute: text('attribute').notNull(),
    value: text('value').notNull(),
    confidence: real('confidence').notNull().default(0.5),
    updatedAt: integer('updated_at').notNull(),
});
export const memorySummaries = sqliteTable('memory_summaries', {
    id: text('id').primaryKey(),
    summary: text('summary').notNull(),
    turnStart: integer('turn_start').notNull(),
    turnEnd: integer('turn_end').notNull(),
    createdAt: integer('created_at').notNull(),
});
export const memoryVectors = sqliteTable('memory_vectors', {
    id: text('id').primaryKey(),
    content: text('content').notNull(),
    embedding: text('embedding').notNull(),
    confidence: real('confidence').notNull(),
    source: text('source', { enum: ['user_fact', 'summary'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
});
