import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
export const conceptCombos = sqliteTable('concept_combos', {
    id: text('id').primaryKey(),
    sources: text('sources').notNull(),
    description: text('description').notNull(),
    createdAt: integer('created_at').notNull(),
});
export const hypotheses = sqliteTable('hypotheses', {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    idea: text('idea').notNull(),
    expectedBenefit: text('expected_benefit').notNull(),
    risk: text('risk').notNull(),
    sourceLabels: text('source_labels').notNull(),
    novelty: real('novelty').notNull(),
    feasibility: real('feasibility').notNull(),
    impact: real('impact').notNull(),
    status: text('status', { enum: ['draft', 'active', 'experimenting', 'validated', 'rejected'] })
        .notNull()
        .default('draft'),
    createdAt: integer('created_at').notNull(),
});
export const experiments = sqliteTable('experiments', {
    hypothesisId: text('hypothesis_id').primaryKey(),
    title: text('title').notNull(),
    steps: text('steps').notNull(),
    successCriteria: text('success_criteria').notNull(),
    estimatedDuration: text('estimated_duration').notNull(),
    createdAt: integer('created_at').notNull(),
});
export const dreamCycles = sqliteTable('dream_cycles', {
    timestamp: integer('timestamp').primaryKey(),
    sourcesExamined: integer('sources_examined').notNull(),
    combosGenerated: integer('combos_generated').notNull(),
    hypothesesGenerated: integer('hypotheses_generated').notNull(),
    topIdea: text('top_idea'),
});
