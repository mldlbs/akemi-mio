import type { TaskState, DagStateFile } from './types';
export declare class DagStateMachine {
    private dagDir;
    constructor(observerBaseDir: string);
    /** 创建今天的 DAG 任务。如果已有未完成的任务则返回它。 */
    createTask(): DagStateFile;
    /** 尝试状态转移。返回更新后的 DAG 文件；如果转移非法则抛出。 */
    transition(dag: DagStateFile, to: TaskState, data?: Partial<DagStateFile['data']>): DagStateFile;
    /** 标记失败（带错误信息）。自动处理重试：attempt < max 时回退 INIT。 */
    failTask(dag: DagStateFile, error: {
        message: string;
        phase: string;
    }): DagStateFile;
    /** 读取指定 task 的 DAG 文件 */
    readState(taskId: string): DagStateFile | null;
    /** 获取今天任务 */
    getTodayTask(): DagStateFile | null;
    /** 判断今天是否有已完成的任务 */
    isTodayCompleted(): boolean;
    /** 获取最近 N 天的所有 DAG 文件摘要 */
    getRecentSummary(days?: number): {
        taskId: string;
        state: TaskState;
        attempt: number;
    }[];
    /** 获取可重试的失败任务 */
    getRetryableTasks(): DagStateFile[];
    private persist;
}
