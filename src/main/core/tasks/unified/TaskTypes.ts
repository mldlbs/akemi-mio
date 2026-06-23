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

/** 任务优先级等级 */
export enum TaskTier {
  /** 用户可见，必须成功 */
  CRITICAL = 'critical',
  /** 系统健康相关，有限重试 */
  IMPORTANT = 'important',
  /** 锦上添花，失败即跳过 */
  BEST_EFFORT = 'best_effort',
}

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
