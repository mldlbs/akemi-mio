/**
 * EvolutionExecutor — 进化流水线 Stage 3
 *
 * 职责：执行进化计划的下一步，管理 Git 快照/回滚，指数退避重试
 * 生命周期：init() → [executeNextStep()] → destroy()
 */
import type { AgentService } from '../../agent/AgentService';
import type { PlanManagerLike } from '../types';
import type { EvolutionGitOps } from '../EvolutionGitOps';
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../../core/lifecycle/types';
import type { ExecutionInput, ExecutionResult } from './types';
export declare class EvolutionExecutor implements ISubsystem {
    readonly name = "EvolutionExecutor";
    state: SubsystemState;
    private agentService;
    private planManager;
    private gitOps;
    private planExecTimeoutMs;
    private stepRetryBaseMs;
    private planExecConsecutiveErrors;
    private executeFailures;
    private currentSnapshotBranch;
    private executionLock;
    private proposalValidator;
    private safetyMode;
    constructor(agentService: AgentService, planManager: PlanManagerLike | null, options?: {
        planExecTimeoutMs?: number;
        stepRetryBaseMs?: number;
    });
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
    setGitOps(gitOps: EvolutionGitOps | null): void;
    setProposalValidator(v: any): void;
    setSafetyMode(mode: string): void;
    getExecuteFailures(): number;
    hasPendingStep(): boolean;
    getPlanProgress(): {
        completed: number;
        total: number;
    };
    executeNextStep(input: ExecutionInput): Promise<ExecutionResult>;
    private executeStep;
    private handleStepFailure;
    private cleanupSnapshot;
    /** 重置执行计数器（外部调用，如冷却恢复时） */
    resetFailures(): void;
    private autoGitCommit;
}
