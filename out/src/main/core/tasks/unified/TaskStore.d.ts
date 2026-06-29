import type { BackgroundTaskState, BackgroundTaskType } from './TaskTypes';
/**
 * 统一任务状态持久化。
 * 替代 CreativityService/InsightService 各自的 setInterval 调度状态。
 */
export declare class TaskStore {
    private data;
    get(type: BackgroundTaskType): BackgroundTaskState;
    update(type: BackgroundTaskType, partial: Partial<BackgroundTaskState>): void;
    reset(type: BackgroundTaskType): void;
}
