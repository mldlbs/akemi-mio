import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const workflowDefs = sqliteTable('workflow_defs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  definition: text('definition').notNull(), // JSON: full WorkflowDef
  enabled: integer('enabled').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const workflowRuns = sqliteTable('workflow_runs', {
  runId: text('run_id').primaryKey(),
  workflowDefId: text('workflow_def_id').notNull(),
  workflowName: text('workflow_name').notNull(),
  status: text('status', { enum: ['pending', 'running', 'paused', 'done', 'failed'] })
    .notNull()
    .default('pending'),
  trigger: text('trigger'), // JSON: WorkflowTrigger
  context: text('context'), // JSON: execution context (step results)
  pendingGate: text('pending_gate'), // JSON: awaiting gate info
  userInput: text('user_input'),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at'),
})

export const workflowStepRuns = sqliteTable('workflow_step_runs', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => workflowRuns.runId, { onDelete: 'cascade' }),
  stepId: text('step_id').notNull(),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed', 'skipped'] })
    .notNull()
    .default('pending'),
  input: text('input'), // JSON: step input
  output: text('output'), // JSON: structured output (agentResult)
  error: text('error'),
  retryCount: integer('retry_count').notNull().default(0),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
})
