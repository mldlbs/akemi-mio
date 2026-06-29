export type InitPriority = 'critical' | 'normal' | 'background';
export interface InitTask {
    name: string;
    priority: InitPriority;
    fn: () => Promise<void> | void;
    /** 普通任务延迟毫秒数（默认 0），背景任务默认 3000 */
    delayMs?: number;
    /** 超时毫秒数，超时后标记为 failed 但不阻塞后续 */
    timeoutMs?: number;
}
type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';
/**
 * 延迟初始化调度器 — 按优先级分阶段启动非关键服务
 *
 * 关键(critical) → 立即（微任务）
 * 普通(normal) → 下一帧（setImmediate/setTimeout 0）
 * 背景(background) → 延迟 3s 后启动
 *
 * 调度器本身极轻量，不产生额外依赖
 */
export declare class LazyInitScheduler {
    private tasks;
    private _started;
    private _completed;
    private timers;
    private completedCount;
    private failedCount;
    add(task: InitTask): this;
    /** 批量添加任务 */
    addMany(tasks: InitTask[]): this;
    /** 启动调度 */
    start(): void;
    private scheduleTask;
    private withTimeout;
    private checkAllDone;
    /** 获取任务状态报告 */
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
    /** 停止所有待执行的任务 */
    cancel(): void;
    /** 是否所有任务已完成（含失败） */
    get isCompleted(): boolean;
}
export {};
