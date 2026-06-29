import { EventBus } from '../core/EventBus';
import { AsyncLock } from '../utils/AsyncLock';
import type { AgentService } from '../agent/AgentService';
/**
 * 调度状态机状态枚举
 * IDLE → ANALYZING → IDLE 或 → EXECUTING → IDLE
 * EXECUTING → VERIFYING → IDLE（验证模式启用时）
 * COOLDOWN → IDLE（冷却超时后自动转换）
 */
export declare enum EvolutionSchedulerState {
    IDLE = "IDLE",
    ANALYZING = "ANALYZING",
    EXECUTING = "EXECUTING",
    VERIFYING = "VERIFYING",
    COOLDOWN = "COOLDOWN"
}
export type SchedulerCallbacks = {
    onAnalyze: () => Promise<void>;
    onExecute: () => Promise<void>;
};
/**
 * 调度状态机 — 管理 Evolution 的分析/执行/冷却周期。
 * 从 SelfEvolutionService 提取，职责单一。
 */
export declare class EvolutionScheduler {
    private agentService;
    private eventBus;
    currentState: EvolutionSchedulerState;
    private callbacks;
    schedulerTickId: string | null;
    schedulerTaskId: string | null;
    schedulerTickMs: number;
    lastAnalysisTime: number;
    lastExecutionTime: number;
    lastRun: number;
    tryRunFailures: number;
    executeFailures: number;
    maxFailures: number;
    recoveryCooldownUntil: number;
    lastSuccessTime: number;
    intervalMs: number;
    planExecTimeoutMs: number;
    currentAnalysisTimeoutMs: number;
    analysisStuckTimeoutMs: number;
    readonly evolutionLock: AsyncLock;
    constructor(agentService: AgentService, callbacks: SchedulerCallbacks, bus?: EventBus, options?: {
        schedulerTickMs?: number;
        planExecTimeoutMs?: number;
        analysisTimeoutMs?: number;
        analysisStuckTimeoutMs?: number;
    });
    start(): void;
    stop(): void;
    getState(): EvolutionSchedulerState;
    getRecoveryCooldown(): {
        active: boolean;
        remainingMs: number;
    };
    transitionState(newState: EvolutionSchedulerState, reason: string): void;
    schedulerTick(): Promise<void>;
    hasPendingPlanStep(planManager: {
        getActivePlan: () => any;
    } | null): boolean;
}
