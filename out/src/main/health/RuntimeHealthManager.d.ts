import type { ISubsystem, HealthCheckResult, SubsystemState } from '../core/lifecycle/types';
import type { HealthLevel } from '../governance/SessionGovernorTypes';
import { ModelHealthTracker, type ModelHealthResult } from './ModelHealthTracker';
export interface DimensionHealth {
    score: number;
    level: HealthLevel;
    trend: 'improving' | 'declining' | 'stable';
}
export interface RuntimeHealthSnapshot {
    timestamp: number;
    composite: DimensionHealth;
    session: DimensionHealth;
    capability: DimensionHealth;
    task: DimensionHealth;
    model: ModelHealthResult;
    recommendedActions: string[];
}
export interface SessionHealthProvider {
    getScore(): number;
    getLevel(): HealthLevel;
    getConsecutiveFailures(): number;
}
export interface CapabilityHealthProvider {
    getCapabilitySummary(): {
        totalCapabilityHealth: number;
        servers: Array<{
            name: string;
            healthScore: number;
            driftDetected: boolean;
        }>;
    };
}
export interface TaskHealthProvider {
    getTaskHealthSummary(): Array<{
        type: string;
        status: string;
        consecutiveFailures: number;
        tier: string;
        disabled: boolean;
    }>;
}
/**
 * RuntimeHealthManager — Phase 5D: 统一四维健康总控。
 *
 * 整合 SessionHealth / CapabilityHealth / TaskHealth / ModelHealth 四个维度，
 * 输出 composite health score + severity + recommended actions。
 *
 * 注册为 ISubsystem，通过 HealthChecker 周期性检查。
 */
export declare class RuntimeHealthManager implements ISubsystem {
    readonly name = "RuntimeHealthManager";
    state: SubsystemState;
    readonly modelHealth: ModelHealthTracker;
    private sessionProvider;
    private capabilityProvider;
    private taskProvider;
    private tickTimer;
    private readonly tickIntervalMs;
    private history;
    private readonly maxHistory;
    private lastCompositeScore;
    constructor();
    setSessionHealthProvider(provider: SessionHealthProvider): void;
    setCapabilityHealthProvider(provider: CapabilityHealthProvider): void;
    setTaskHealthProvider(provider: TaskHealthProvider): void;
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
    getSnapshot(): RuntimeHealthSnapshot;
    getCompositeScore(): number;
    getRecommendedActions(): string[];
    getDiagnostics(): Record<string, unknown>;
    private evaluateAll;
    private computeComposite;
    private getSessionDimension;
    private getCapabilityDimension;
    private getTaskDimension;
    private computeTrend;
}
