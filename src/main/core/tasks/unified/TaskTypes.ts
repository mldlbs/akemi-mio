/** 后台任务类型 */
export type BackgroundTaskType =
  | 'evolution.analysis'
  | 'evolution.execution'
  | 'creativity.cycle'
  | 'creativity.dream'
  | 'insight.analysis'
  | 'memory.index'
  | 'telegram.outbox'
  | 'stability.tick'

/** 后台任务状态 */
export type BackgroundTaskStatus = 'idle' | 'running' | 'failed' | 'cooldown'

/** 统一后台任务状态 */
export interface BackgroundTaskState {
  type: BackgroundTaskType
  status: BackgroundTaskStatus
  lastRunAt: number
  consecutiveFailures: number
  cooldownUntil: number
  metadata: Record<string, unknown>
}

/** 任务执行结果 */
export interface TaskExecutionResult {
  success: boolean
  summary?: string
}

/** 任务执行器 */
export type TaskExecutor = (ctx: { state: BackgroundTaskState; signal: AbortSignal }) => Promise<TaskExecutionResult>
