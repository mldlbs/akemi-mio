import type { BackgroundTaskType, TaskExecutor } from './TaskTypes';
import { TaskTier } from './TaskTypes';
import { TaskStore } from './TaskStore';
export interface RegisteredTask {
    type: BackgroundTaskType;
    executor: TaskExecutor;
    intervalMs: number;
    /** 冷却时间（毫秒），失败后等待 */
    cooldownMs: number;
    /** 最大失败次数触发冷却 */
    maxFailures: number;
    /** 指数退避基础延时 */
    retryBaseMs: number;
    /** 任务优先级等级，影响 maxFailures 的默认值 */
    tier: TaskTier;
}
/**
 * 统一后台任务执行编排器。
 * 内置：冷却管理、指数退避、最小间隔、事件发射。
 */
export declare class TaskRunner {
    private tasks;
    private timers;
    private abortControllers;
    private store;
    private started;
    constructor(taskStore?: TaskStore);
    register(type: BackgroundTaskType, executor: TaskExecutor, intervalMs: number, options?: {
        cooldownMs?: number;
        maxFailures?: number;
        retryBaseMs?: number;
        tier?: TaskTier;
    }): void;
    private startTimer;
    start(): void;
    stop(): void;
    stopType(type: BackgroundTaskType): void;
    triggerNow(type: BackgroundTaskType): Promise<void>;
    getState(type: BackgroundTaskType): import("./TaskTypes").BackgroundTaskState;
    has(type: BackgroundTaskType): boolean;
    /** 获取所有任务的健康摘要 */
    getTaskHealthSummary(): Array<{
        type: string;
        status: string;
        consecutiveFailures: number;
        tier: string;
        disabled: boolean;
    }>;
    private tick;
}
