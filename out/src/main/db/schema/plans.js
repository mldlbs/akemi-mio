import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const plans = sqliteTable('plans', {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    status: text('status', { enum: ['active', 'completed', 'abandoned'] })
        .notNull()
        .default('active'),
    reflection: text('reflection'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
});
export const planSteps = sqliteTable('plan_steps', {
    id: text('id').primaryKey(),
    planId: text('plan_id')
        .notNull()
        .references(() => plans.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    description: text('description').notNull(),
    status: text('status', { enum: ['pending', 'in_progress', 'done', 'failed'] })
        .notNull()
        .default('pending'),
    result: text('result'),
});
