/**
 * @deprecated TaskScheduler 已被 TaskRunner 取代。
 * stability.tick 已迁移到 TaskRunner，保留此类仅作参考。
 * 新代码请使用 src/main/core/tasks/unified/TaskRunner.ts
 */
import { Scheduler } from '../Scheduler';
import { TaskRegistry } from './TaskRegistry';
import { ResourceBudget } from '../ResourceBudget';
import { type Task, type TaskSchedule, type TaskPriority } from './types';
/** @deprecated 使用 TaskRunner 代替 */
export declare class TaskScheduler {
    private instances;
    private registry;
    private scheduler;
    private services;
    private emitFn;
    private logFn;
    private running;
    private taskIdSeq;
    private stabilityScore;
    private resourceBudget;
    private graph;
    constructor(registry: TaskRegistry, options?: {
        scheduler?: Scheduler;
        emit?: (event: string, payload: any) => void;
        log?: (level: string, msg: string, meta?: Record<string, any>) => void;
        taskGraph?: any;
        resourceBudget?: ResourceBudget;
    });
    setServices(svcs: Record<string, unknown>): void;
    setStabilityScore(ss: any): void;
    setBudget(budget: ResourceBudget): void;
    register<I, O>(type: string, schedule: TaskSchedule, input?: I, priority?: TaskPriority, tags?: string[]): string;
    start(): void;
    stop(): void;
    startTask(id: string): boolean;
    stopTask(id: string): boolean;
    trigger(id: string): Promise<void>;
    triggerByType(type: string): Promise<void>;
    pauseTask(id: string): boolean;
    resumeTask(id: string): boolean;
    listTasks(): {
        id: string;
        type: string;
        status: string;
        lastRun: number;
        failures: number;
    }[];
    getTask(id: string): Task | undefined;
    isRunning(): boolean;
    get size(): number;
    private scheduleInstance;
    private stopInstance;
    private executeTask;
    private emitLifecycle;
}
