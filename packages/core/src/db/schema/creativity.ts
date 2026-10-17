import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const conceptCombos = sqliteTable('concept_combos', {
  id: text('id').primaryKey(),
  sources: text('sources').notNull(),
  description: text('description').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const hypotheses = sqliteTable('hypotheses', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  idea: text('idea').notNull(),
  expectedBenefit: text('expected_benefit').notNull(),
  risk: text('risk').notNull(),
  sourceLabels: text('source_labels').notNull(),
  sourceDetails: text('source_details'),
  novelty: real('novelty').notNull(),
  feasibility: real('feasibility').notNull(),
  impact: real('impact').notNull(),
  status: text('status', { enum: ['draft', 'active', 'testing', 'validated', 'rejected'] })
    .notNull()
    .default('draft'),
  createdAt: integer('created_at').notNull(),
  implementedCommitSha: text('implemented_commit_sha'),
  implementedAt: integer('implemented_at'),
  implementationNote: text('implementation_note'),
  proposedRelations: text('proposed_relations'),
  falsificationConditions: text('falsification_conditions'),
  sourceObservationIds: text('source_observation_ids'),
})

export const experiments = sqliteTable('experiments', {
  hypothesisId: text('hypothesis_id').primaryKey(),
  title: text('title').notNull(),
  steps: text('steps').notNull(),
  successCriteria: text('success_criteria').notNull(),
  estimatedDuration: text('estimated_duration').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const dreamCycles = sqliteTable('dream_cycles', {
  timestamp: integer('timestamp').primaryKey(),
  sourcesExamined: integer('sources_examined').notNull(),
  combosGenerated: integer('combos_generated').notNull(),
  hypothesesGenerated: integer('hypotheses_generated').notNull(),
  topIdea: text('top_idea'),
})

/** 正向反馈闭环 P0：证据事件权威表（migration v51）。append-only；纠错用更正事件。 */
export const hypothesisFeedbackEvents = sqliteTable('hypothesis_feedback_events', {
  id: text('id').primaryKey(),
  hypothesisId: text('hypothesis_id').notNull(),
  eventType: text('event_type', {
    enum: ['validated', 'adopted', 'implemented', 'rejected', 'regression_failed'],
  })
    .notNull(),
  sourceType: text('source_type', { enum: ['experiment', 'memory', 'adoption', 'commit', 'manual'] }).notNull(),
  sourceId: text('source_id').notNull(),
  sourceVersion: text('source_version'),
  commitSha: text('commit_sha'),
  experimentRunId: text('experiment_run_id'),
  evidenceRef: text('evidence_ref'),
  occurredAt: integer('occurred_at').notNull(),
  ingestedAt: integer('ingested_at').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  schemaVersion: integer('schema_version').notNull().default(1),
})
