export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';
export type TaskPriority = 'critical' | 'normal' | 'background';
/** 任务层级：critical/standard 进 TaskGraph，background 直接执行 */
export type TaskTier = 'critical' | 'standard' | 'background';
export interface TaskSchedule {
    type: 'interval' | 'cron' | 'conditional' | 'manual';
    intervalMs?: number;
    cron?: {
        minute?: number | '*';
        hour?: number | '*';
    };
    shouldRun?: () => boolean | Promise<boolean>;
    jitterMs?: number;
    minGapMs?: number;
    tier?: TaskTier;
}
export interface Task<I = void, O = void> {
    id: string;
    type: string;
    input: I;
    status: TaskStatus;
    schedule: TaskSchedule;
    priority: TaskPriority;
    tier?: TaskTier;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    output?: O;
    error?: string;
    tags?: string[];
}
export type TaskHandler<I = any, O = any> = (task: Task<I, O>, context: TaskExecutionContext) => Promise<O>;
export interface TaskExecutionContext {
    signal: AbortSignal;
    services: Record<string, unknown>;
    emit: (event: string, payload: any) => void;
    log: (level: string, message: string, meta?: Record<string, any>) => void;
}
export interface TaskLifecycleEvent {
    taskId: string;
    type: string;
    status: TaskStatus;
    durationMs?: number;
    error?: string;
}
