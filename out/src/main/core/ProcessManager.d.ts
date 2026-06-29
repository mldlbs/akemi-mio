import { ChildProcess } from 'child_process';
import type { ISubsystem, HealthCheckResult, SubsystemState } from './lifecycle/types';
export interface ProcessRegistration {
    name: string;
    modulePath: string;
    proc: ChildProcess | null;
    state: 'stopped' | 'starting' | 'running' | 'stopping';
    startTime: number;
    restartCount: number;
    lastRestartTime: number;
    maxMemoryMb: number;
    maxCpuMs: number;
    healthPings: number;
    failedPings: number;
    pendingRequests: Map<string, {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>;
}
export interface ProcessConfig {
    maxMemoryMb?: number;
    maxCpuMs?: number;
    healthPingIntervalMs?: number;
    maxRestarts?: number;
    restartWindowMs?: number;
}
export type ProcessMessage = {
    type: 'result';
    requestId: string;
    success: true;
    data: unknown;
} | {
    type: 'result';
    requestId: string;
    success: false;
    error: string;
} | {
    type: 'lifecycle';
    event: 'started';
} | {
    type: 'lifecycle';
    event: 'error';
    error: string;
} | {
    type: 'pong';
    id: number;
} | {
    type: 'memory_usage';
    heapMb: number;
} | {
    type: 'shutdown_ack';
};
/**
 * ProcessManager — Agent OS 子进程生命周期管理器。
 *
 * 使用 child_process.fork() 隔离重型服务（ASR/TTS/Evolution worker）。
 * 支持健康探针、自动重启、资源预算强制执行和优雅关闭。
 */
export declare class ProcessManager implements ISubsystem {
    readonly name = "ProcessManager";
    state: SubsystemState;
    private processes;
    private healthTimer;
    private nextRequestId;
    private configDefaults;
    constructor(config?: ProcessConfig);
    /** 注册并启动一个子进程 */
    register(name: string, modulePath: string, config?: ProcessConfig): void;
    /** 子进程间通信（request/response） */
    sendRequest(name: string, method: string, data: unknown, timeoutMs?: number): Promise<unknown>;
    /** 停止并卸载一个子进程 */
    unregister(name: string): Promise<void>;
    isRunning(name: string): boolean;
    getUtilization(name: string): {
        running: boolean;
        heapMb?: number;
        uptimeMs: number;
    } | null;
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
    private startProcess;
    private handleMessage;
    private handleExit;
    private attemptRestart;
    private gracefulShutdown;
    private checkAllProcesses;
}
