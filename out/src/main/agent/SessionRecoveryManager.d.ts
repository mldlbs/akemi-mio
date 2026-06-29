import type { RunContext } from './runstate';
import type { ConversationContext } from './context';
import type { ResourceBudget } from '../core/ResourceBudget';
import type { CircuitBreaker } from '../core/CircuitBreaker';
export interface CheckpointData {
    meta: {
        version: 1;
        runId: string;
        timestamp: number;
        trigger: 'milestone' | 'error' | 'interrupt' | 'shutdown';
    };
    runContext: {
        step: number;
        state: string;
        consecutiveTimeouts: number;
        consecutiveToolErrors: number;
        forceContinueCount: number;
        forceContinueStagnation: number;
        interruptFlag: boolean;
        interruptReason: string;
    };
    conversationSummary: string;
    conversationStats: {
        totalMessages: number;
        totalTurns: number;
        lastUserMessage: string;
        lastAssistantMessage: string;
    };
    shortTermMemory: Array<{
        user: string;
        assistant: string;
    }>;
    planState: {
        activePlanId: string | null;
        activePlanTitle: string | null;
        sessionPlanIds: string[];
        pendingStepDescriptions: string[];
    };
    resourceState: Record<string, number>;
    circuitBreakerState: Record<string, {
        state: string;
        failures: number;
    }>;
    timestamps: {
        sessionStartedAt: number;
        lastCheckpointAt: number;
    };
}
export interface CheckpointParams {
    trigger: CheckpointData['meta']['trigger'];
    runContext: RunContext | null;
    context: ConversationContext;
    runId: string;
    planState: {
        activePlanId: string | null;
        activePlanTitle: string | null;
        sessionPlanIds: string[];
        pendingStepDescriptions?: string[];
    };
    resourceBudget?: ResourceBudget;
    circuitBreaker?: CircuitBreaker;
    error?: string;
}
export declare class SessionRecoveryManager {
    private baseDir;
    private checkpointsDir;
    private sessionStartedAt;
    /** 最近一次创建检查点的时间戳，用于防抖 */
    private lastCheckpointTime;
    constructor(baseDir: string);
    private ensureDirs;
    createCheckpoint(params: CheckpointParams): Promise<string>;
    restoreLatestCheckpoint(): CheckpointData | null;
    hasInterruptedSession(): boolean;
    clearSession(): void;
    /** 获取最近恢复的 checkpoints 记录条数，用于恢复循环检测 */
    getRecoveryFailCount(): number;
    /** 增加恢复失败计数 */
    incrementRecoveryFailCount(): void;
    /** 重置恢复失败计数 */
    resetRecoveryFailCount(): void;
    /** 记录当前日期用于恢复循环时间窗口检测 */
    recordRecoveryAttempt(): void;
    /** 检查恢复循环：连续 3 次恢复且 60 秒内 */
    isRecoveryLoop(): boolean;
    private assembleCheckpointData;
    private writeTaskStatus;
    private writeSummaryStatus;
    private appendHistory;
    private getCheckpointCount;
}
