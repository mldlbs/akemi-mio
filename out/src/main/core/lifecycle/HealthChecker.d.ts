import type { ISubsystem, HealthCheckResult, SubsystemState } from './types';
/**
 * HealthChecker — 周期性健康检查调度器
 *
 * 对所有注册的子系统定期执行健康检查。
 * 维护滚动健康历史，状态变更时发射事件。
 */
export declare class HealthChecker implements ISubsystem {
    readonly name = "HealthChecker";
    state: SubsystemState;
    private subsystems;
    private healthHistory;
    private timer;
    private readonly maxHistory;
    private intervalMs;
    private checkInProgress;
    constructor(intervalMs?: number);
    /** 设置检查间隔（运行时调整） */
    setInterval(ms: number): void;
    /** 注册子系统 */
    register(subsystem: ISubsystem): void;
    /** 注销子系统 */
    unregister(name: string): void;
    /** 获取子系统最近的健康状态摘要 */
    getHealthSummary(): Array<{
        name: string;
        healthy: boolean;
        detail?: string;
        trend: string;
    }>;
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
    private runAllChecks;
    private recordHealth;
    private computeTrend;
    private restartTimer;
}
