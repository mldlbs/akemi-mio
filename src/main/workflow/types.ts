export type WorkflowStepHandler =
  | 'subagent'
  | 'prompt'
  | 'tool'
  | 'api'
  | 'plan'
  | 'condition'
  | 'foreach'
  | 'transform'
  | 'gate'
  | 'aggregate'
  | 'subflow'
  | 'wait'
  | 'script'
  | 'event'

export type RunCondition = 'success' | 'failure'

/** Schema for validating structured I/O between steps */
export interface ValueSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  properties?: Record<string, ValueSchema>
  items?: ValueSchema
  optional?: boolean
  description?: string
}

export interface ConditionCase {
  /** 条件表达式，如 "> 7"、"== 'approve'"、"(&gt;= 4 and &lt;= 7)" */
  if: string
  /** 满足条件时跳转到此步骤 ID */
  goto: string
}

export interface ForeachConfig {
  /** 模板引用到数组变量，如 "{{steps.s2.result.platforms}}" */
  items: string
  /** 对每项执行的工作流 ID（引用已有） */
  workflowId?: string
  /** 或内联步骤定义 */
  inlineSteps?: WorkflowStepDef[]
  /** 并发数，默认 1 */
  concurrency?: number
}

export interface GateConfig {
  message: string
  /** 模板引用到预览内容 */
  preview: string
  options?: string[]
  /** 超时(ms)，默认 24h */
  timeoutMs?: number
}

export interface AggregateConfig {
  /** 要聚合的步骤 ID 列表 */
  sources: string[]
  /** 聚合策略 */
  strategy: 'merge' | 'concat' | 'pick-first' | 'custom'
  /** 自定义聚合的模板表达式 */
  expression?: string
}

export interface TransformConfig {
  /** 输入来源模板引用 */
  input: string
  /** 输出映射，key=新字段, value=模板表达式 */
  mapping: Record<string, string>
}

export interface ConditionConfig {
  /** 条件判断来源的模板引用 */
  source: string
  /** 条件分支列表 */
  cases: ConditionCase[]
  /** 无匹配时跳转到此步骤（可选） */
  defaultGoto?: string
}

export interface SubflowConfig {
  workflowId?: string
  inlineSteps?: WorkflowStepDef[]
  input?: Record<string, string>
}

export interface WaitConfig {
  /** 等待时长(ms) */
  durationMs?: number
  /** 或等待某步骤完成 */
  waitForStep?: string
  /** 或等待条件满足 */
  waitUntil?: string
}

export interface ScriptConfig {
  /** JS 函数体，接收 (ctx, steps) 参数，返回任意值 */
  code: string
}

export interface EventConfig {
  eventName: string
  payload?: string
}

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
    allowedTools?: string[]
    maxTurns?: number
    llmTimeoutMs?: number
    outputFile?: string

    // 新 handler 配置
    condition?: ConditionConfig
    foreach?: ForeachConfig
    transform?: TransformConfig
    gate?: GateConfig
    aggregate?: AggregateConfig
    subflow?: SubflowConfig
    wait?: WaitConfig
    script?: ScriptConfig
    event?: EventConfig
  }

  /** 输入 schema 声明——上游数据验证 */
  inputSchema?: Record<string, ValueSchema>
  /** 输出 schema 声明——下游数据契约 */
  outputSchema?: Record<string, ValueSchema>

  dependsOn: string[]
  runOn?: RunCondition

  /** 失败重试次数，默认 0 */
  retryCount?: number
  /** 重试间隔(ms)，默认 5000 */
  retryDelayMs?: number
}

export interface WorkflowDef {
  id: string
  name: string
  description: string
  steps: WorkflowStepDef[]
  createdAt: number
  updatedAt: number
  enabled?: boolean
  tags?: string[]
  inputSchema?: string
  outputDir?: string
  /** 调度触发器 */
  trigger?: WorkflowTrigger
  /** 最大并发步骤数，默认 5 */
  maxConcurrency?: number
}

export type StepRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface WorkflowStepRun {
  stepId: string
  status: StepRunStatus
  /** 结构化输出（JSON 序列化） */
  agentResult?: string
  error?: string
  startedAt?: number
  completedAt?: number
  /** 重试计数 */
  retryCount?: number
}

export type WorkflowRunStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed'

export interface WorkflowRun {
  runId: string
  workflowDefId: string
  workflowName: string
  status: WorkflowRunStatus
  steps: WorkflowStepRun[]
  startedAt: number
  completedAt?: number
  userInput?: string
  trigger?: WorkflowTrigger
  /** 执行上下文——每一步的结构化输出 */
  context?: Record<string, any>
  /** 当前等待 gate 的步骤 */
  pendingGate?: { stepId: string; message: string; preview: string; options: string[] }
}

export type WorkflowTriggerType = 'manual' | 'cron' | 'event' | 'webhook'

export interface WorkflowTrigger {
  type: WorkflowTriggerType
  cron?: string
  event?: string
  webhook?: {
    path: string
    method: 'POST' | 'GET'
    secret?: string
  }
  defaultInput?: string
}

export interface WorkflowStoreData {
  version: number
  definitions: WorkflowDef[]
  runs: WorkflowRun[]
}
