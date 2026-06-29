/**
 * @deprecated 未在任何地方使用。TaskScheduler + TaskRegistry 是现用的执行路径。
 * 保留以供参考，未来的工作流执行器不应基于此实现。
 */
import { TaskRegistry } from './tasks/TaskRegistry';
import { type Task } from './tasks/types';
import { ResourceBudget } from './ResourceBudget';
export interface WorkerSlot {
    name: string;
    busy: boolean;
    currentTaskId: string | null;
    startedAt: number | null;
}
export declare class WorkerManager {
    private registry;
    private slots;
    private services;
    private budget;
    private emitFn;
    private logFn;
    constructor(registry: TaskRegistry, options?: {
        maxConcurrency?: number;
        emit?: (event: string, payload: any) => void;
        log?: (level: string, msg: string, meta?: Record<string, any>) => void;
        budget?: ResourceBudget;
    });
    setServices(svcs: Record<string, unknown>): void;
    setBudget(budget: ResourceBudget): void;
    execute<I, O>(task: Task<I, O>): Promise<O>;
    getBusyCount(): number;
    getAvailableSlots(): number;
    listSlots(): WorkerSlot[];
    private acquireSlot;
}
