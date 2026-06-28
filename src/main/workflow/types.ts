export type WorkflowStepHandler = 'subagent' | 'prompt' | 'tool' | 'api' | 'plan'

export interface WorkflowStepDef {
  id: string
  name: string
  description: string
  handler: WorkflowStepHandler
  config: {
    prompt?: string
    tool?: string
    apiUrl?: string
    apiMethod?: string
    planPrompt?: string
  }
  dependsOn: string[]
  /** 执行条件: 'success'=仅当所有依赖都成功时执行(默认), 'failure'=仅当至少一个依赖失败时执行 */
  runOn?: 'success' | 'failure'
}

export interface WorkflowDef {
  id: string
  name: string
  description: string
  steps: WorkflowStepDef[]
  createdAt: number
  updatedAt: number
}

export type StepRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface WorkflowStepRun {
  stepId: string
  status: StepRunStatus
  agentResult?: string
  error?: string
  startedAt?: number
  completedAt?: number
}

export type WorkflowRunStatus = 'pending' | 'running' | 'done' | 'failed'

export interface WorkflowRun {
  runId: string
  workflowDefId: string
  workflowName: string
  status: WorkflowRunStatus
  steps: WorkflowStepRun[]
  startedAt: number
  completedAt?: number
}

export interface WorkflowStoreData {
  version: number
  definitions: WorkflowDef[]
  runs: WorkflowRun[]
}
