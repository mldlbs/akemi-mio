import { Worker } from 'worker_threads';
import type { ISubsystem, HealthCheckResult, SubsystemState } from './lifecycle/types';
export type WorkerTaskMessage = {
    type: 'task';
    taskId: string;
    name: string;
    method: string;
    data: any;
};
export type WorkerResultMessage = {
    type: 'result';
    taskId: string;
    success: boolean;
    data: any;
    error?: string;
};
export type WorkerLifecycleMessage = {
    type: 'lifecycle';
    event: 'started' | 'stopped' | 'error';
    workerName: string;
    error?: string;
};
export type WorkerPingMessage = {
    type: 'ping';
    id: number;
};
export type WorkerPongMessage = {
    type: 'pong';
    id: number;
};
export type WorkerShutdownMessage = {
    type: 'shutdown';
};
export type WorkerMessage = WorkerTaskMessage | WorkerResultMessage | WorkerLifecycleMessage | WorkerPingMessage | WorkerPongMessage | WorkerShutdownMessage;
export interface WorkerPoolOptions {
    maxWorkers?: number;
    workerDir?: string;
}
export interface WorkerRegistration {
    name: string;
    worker: Worker;
    busy: boolean;
    startTime: number;
    failedPings: number;
    restartCount: number;
    lastRestartTime: number;
    workerFile: string;
    pendingTasks: Set<string>;
}
/**
 * Worker 线程池 — 管理后台服务的 Worker 生命周期。
 *
 * 实现 ISubsystem 接口，支持：
 * - 健康探针（ping/pong，15s 间隔）
 * - 自动重启（指数退避 1s→2s→4s→8s→30s）
 * - 优雅关闭（5s 超时后 terminate）
 * - 重启风暴检测（5分钟 >5 次 → 发出事件）
 */
export declare class WorkerPool implements ISubsystem {
    readonly name = "WorkerPool";
    state: SubsystemState;
    private workers;
    private maxWorkers;
    private workerDir;
    private healthTimer;
    private responseHandlers;
    constructor(options?: WorkerPoolOptions);
    register(name: string, workerFile: string): void;
    sendTask(name: string, taskId: string, method: string, data: any): void;
    sendTaskAndWait(name: string, method: string, data: any, timeoutMs?: number): Promise<any>;
    isActive(name: string): boolean;
    isBusy(name: string): boolean;
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
    private spawnWorker;
    private gracefulShutdown;
    private checkAllWorkers;
    private attemptRestart;
}
