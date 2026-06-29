/**
 * EvolutionAnalyzer — 进化流水线 Stage 1
 *
 * 职责：收集指标、检测进化需求、构建分析 Prompt、执行 LLM 分析、管理历史记录
 * 生命周期：init() → [analyze() 循环] → destroy()
 */
import type { AgentService } from '../../agent/AgentService';
import type { PlanManagerLike } from '../types';
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../../core/lifecycle/types';
import type { AnalysisInput, AnalysisResult } from './types';
/** 单次 evolution 的历史记录 */
export interface EvolutionHistoryEntry {
    timestamp: number;
    perspective: string;
    summary: string;
    planCreated: boolean;
    planTitle?: string;
    stepsCompleted: number;
    stepsTotal: number;
    success: boolean;
}
export interface EvolutionHistory {
    cycles: EvolutionHistoryEntry[];
}
export declare class EvolutionAnalyzer implements ISubsystem {
    readonly name = "EvolutionAnalyzer";
    state: SubsystemState;
    private agentService;
    private planManager;
    private historyPath;
    private livingPlanDir;
    private maxLivingPlanBytes;
    private promptTrimMode;
    private historyMaxEntries;
    private currentAnalysisTimeoutMs;
    private degenerationThreshold;
    private recentAnalysisFingerprints;
    /** prompt 修正 overlay（由 PromptEvolutionManager 设置） */
    private promptOverlay;
    constructor(agentService: AgentService, planManager: PlanManagerLike | null, options?: {
        historyPath?: string;
        maxLivingPlanBytes?: number;
        analysisTimeoutMs?: number;
        degenerationThreshold?: number;
    });
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
    analyze(input: AnalysisInput): Promise<AnalysisResult>;
    private loadHistory;
    private saveHistory;
    private recordCycle;
    getHistorySummary(): string;
    loadRecentFailures(): Array<{
        task: string;
        error: string;
        timestamp: number;
    }>;
    detectPlanMode(): {
        mode: AnalysisInput['mode'];
        planContext: string;
        planSummary?: AnalysisResult['planSummary'];
    };
    private getActivePlanProgress;
    /**
     * 检测活跃计划是否已卡住（超过 15 分钟无更新）。
     * 卡住的计划允许 evolution 分析穿透，以便 LLM 发现并处理社交任务。
     */
    private isActivePlanStale;
    /**
     * 检查是否有到期的社交排程任务需要执行。
     * 此检查绕过 active_plan_exists 规则，确保社交运营不被阻塞。
     */
    hasPendingSocialTask(): Promise<boolean>;
    /**
     * 廉价预过滤：在调用 LLM 分析前检查是否有必要运行。
     * Level 1 规则（无 LLM 调用）：退化检测、计划进展、近期空闲周期。
     */
    shouldAnalyze(): {
        shouldRun: boolean;
        reason?: string;
    };
    buildLivingPlanContext(): string;
    private readLivingPlanFile;
    private computeFingerprint;
    isDegenerate(): boolean;
    recordFingerprint(summary: string): void;
    setPromptTrimMode(v: boolean): void;
    setPromptOverlay(overlay: string): void;
    setHistoryMaxEntries(n: number): void;
    setAnalysisTimeout(ms: number): void;
    getAnalysisTimeout(): number;
    getPromptTrimMode(): boolean;
    getHistoryMaxEntries(): number;
    getFingerprints(): string[];
    /** 最近一次指纹的时间戳（毫秒）。无指纹返回 Infinity */
    getFingerprintAgeMs(): number;
    resetFingerprints(): void;
    resetDegenerationCount(): void;
}
