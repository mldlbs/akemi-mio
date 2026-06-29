export type InitPriority = 'critical' | 'normal' | 'background';
export interface InitTask {
    name: string;
    priority: InitPriority;
    fn: () => Promise<void> | void;
    delayMs?: number;
    timeoutMs?: number;
}
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';
/**
 * 延迟初始化调度器 — 按优先级分阶段启动非关键服务
 * 替代 LazyInitScheduler（重构保留原行为）
 *
 * 关键(critical) → 立即（微任务）
 * 普通(normal) → 下一帧（setImmediate/setTimeout 0）
 * 背景(background) → 延迟 3s 后启动
 */
export declare class LazyServiceGroup {
    private tasks;
    private _started;
    private _completed;
    private timers;
    private completedCount;
    private failedCount;
    add(task: InitTask): this;
    addMany(tasks: InitTask[]): this;
    start(): void;
    private scheduleTask;
    private withTimeout;
    private checkAllDone;
    getStatus(): {
        started: boolean;
        completed: boolean;
        total: number;
        done: number;
        failed: number;
        tasks: {
            name: string;
            status: TaskStatus;
            error?: string;
        }[];
    };
    cancel(): void;
    get isCompleted(): boolean;
}
export {};
