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
    /** 允许子代理看到的工具名列表。不设置则看到全部工具。设为 [] 禁所有工具。 */
    allowedTools?: string[]
    /** 子代理最大工具调用轮次，缺省 15 */
    maxTurns?: number
    /** 单次 LLM 请求超时(ms)，缺省 120000 */
    llmTimeoutMs?: number
    /** 输出文件路径。如果设置，agentResult 会写入此路径 */
    outputFile?: string
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
  /** 是否启用，false 时不允许启动 */
  enabled?: boolean
  /** 用户输入参数描述，格式如 "主题: string, 目标平台: string" */
  inputSchema?: string
  /** 成果输出目录，如 "~/Desktop/业绩筛查输出"。缺省存到 runs 目录下 */
  outputDir?: string
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
  /** 用户输入的主题/参数 */
  userInput?: string
}

export interface WorkflowStoreData {
  version: number
  definitions: WorkflowDef[]
  runs: WorkflowRun[]
}
