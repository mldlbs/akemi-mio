/**
 * SelfEvolutionService — 进化调度编排器（薄层）
 *
 * 职责：
 * 1. 调度状态机（IDLE→ANALYZING→EXECUTING→VERIFYING→COOLDOWN）
 * 2. 编排 4 阶段流水线：Analyzer → Strategizer → Executor → Reviewer
 * 3. 系统状态持久化（冷却/失败计数跨重启）
 * 4. 安全模式管理、用户活跃保护、完整性检查
 *
 * 非职责（已下沉到各阶段）：
 * - LLM 分析/计划创建 → EvolutionAnalyzer
 * - 策略选择/评分 → EvolutionStrategizer
 * - 步骤执行/Git 回滚 → EvolutionExecutor
 * - 合规验证/回归检测 → EvolutionReviewer
 */
import { Scheduler } from '../core/Scheduler';
import { EventBus } from '../core/EventBus';
import { EvolutionAnalyzer } from './pipeline/EvolutionAnalyzer';
import { EvolutionStrategizer } from './pipeline/EvolutionStrategizer';
import { EvolutionExecutor } from './pipeline/EvolutionExecutor';
import { EvolutionReviewer } from './pipeline/EvolutionReviewer';
import type { AgentService } from '../agent/AgentService';
import type { PlanManagerLike } from './types';
import type { CognitiveService } from '../cognitive';
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../core/lifecycle/types';
import { PromptEvolutionManager } from './PromptEvolutionManager';
import { EvolutionSelfEvaluator } from './EvolutionSelfEvaluator';
import { MetaLearner } from './MetaLearner';
import { EvaluatorCalibrator } from './EvaluatorCalibrator';
export declare enum EvolutionSchedulerState {
    IDLE = "IDLE",
    ANALYZING = "ANALYZING",
    EXECUTING = "EXECUTING",
    VERIFYING = "VERIFYING",
    COOLDOWN = "COOLDOWN"
}
type SafetyMode = 'review' | 'auto';
/**
 * SelfEvolutionService — 进化调度编排器
 *
 * 薄层协调器：维护调度状态机，编排 Analyzer→Strategizer→Executor→Reviewer 流水线。
 * 与外部系统（AgentService, PlanManager, CognitiveService）对接。
 */
export declare class SelfEvolutionService implements ISubsystem {
    readonly name = "SelfEvolutionService";
    state: SubsystemState;
    private agentService;
    private scheduler;
    private eventBus;
    private planManager;
    private cognitiveService;
    readonly analyzer: EvolutionAnalyzer;
    readonly strategizer: EvolutionStrategizer;
    readonly executor: EvolutionExecutor;
    readonly reviewer: EvolutionReviewer;
    private schedulerState;
    private schedulerTickId;
    /** 后备心跳间隔（30 分钟），事件驱动是主触发方式 */
    private schedulerTickMs;
    private lastAnalysisTime;
    private lastExecutionTime;
    private lastRun;
    private mioActive;
    private mioActiveSince;
    private lastUserInputTime;
    private static readonly USER_COOLDOWN_MS;
    private static readonly MIO_ACTIVE_TIMEOUT_MS;
    private safetyMode;
    private safetyModeAutoPromoted;
    private tryRunFailures;
    private executeFailures;
    private maxFailures;
    private recoveryCooldownUntil;
    private lastSuccessTime;
    private intervalMs;
    private readonly evolutionLock;
    private firstRunComplete;
    private analysisStuckTimeoutMs;
    readonly promptEvolutionManager: PromptEvolutionManager;
    readonly selfEvaluator: EvolutionSelfEvaluator;
    readonly metaLearner: MetaLearner;
    readonly evaluatorCalibrator: EvaluatorCalibrator;
    private consecutiveCleanCycles;
    private consecutiveDegenerateDetections;
    private stateFilePath;
    private historyPath;
    private eventSubscriptions;
    /** 最近一次来自创造力系统的优质假设，注入到下一次分析 prompt 中 */
    private creativityHypothesis;
    constructor(agentService: AgentService, sched?: Scheduler, bus?: EventBus, planManager?: PlanManagerLike, options?: {
        historyPath?: string;
        planExecTimeoutMs?: number;
        analysisTimeoutMs?: number;
        analysisStuckTimeoutMs?: number;
        stepRetryBaseMs?: number;
        maxLivingPlanBytes?: number;
        stateFilePath?: string;
        maxReasoningSteps?: number;
        degenerationThreshold?: number;
    });
    private eventCooldownUntil;
    private static readonly EVENT_COOLDOWN_MS;
    /**
     * 事件触发入口：带冷却保护，防止事件风暴导致频繁分析
     */
    private onTriggerEvent;
    private createResponseValidator;
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    private disposeEventSubscriptions;
    healthCheck(): Promise<HealthCheckResult>;
    scheduleEvolution(intervalHours?: number): void;
    stopExistingTick(): void;
    triggerNow(): Promise<void>;
    getSchedulerState(): EvolutionSchedulerState;
    getSafetyMode(): SafetyMode;
    getLastRun(): number;
    getConsecutiveFailures(): number;
    getExecuteFailures(): number;
    getRecoveryCooldown(): {
        active: boolean;
        remainingMs: number;
    };
    setSafetyMode(mode: SafetyMode): void;
    setVerificationRunner(runner: any, verifyAfter?: boolean): void;
    setRegressionDetector(detector: any): void;
    setCognitiveService(cs: CognitiveService | null): void;
    setProposalValidator(v: any): void;
    setGitOps(gitOps: any): void;
    schedulerTick(): Promise<void>;
    private runAnalysisCycle;
    private runExecutionCycle;
    private warmupFirstRun;
    private performIntegrityCheck;
    private handleRecoveryParam;
    private transitionState;
    private collectChangedFiles;
    private loadState;
    private saveState;
}
export {};
