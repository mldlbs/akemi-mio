/**
 * 状态持久化管理器 — save/restore cooling state across restarts。
 * 从 SelfEvolutionService 提取。
 */
export declare class EvolutionStateManager {
    private stateFilePath;
    tryRunFailures: number;
    recoveryCooldownUntil: number;
    lastSuccessTime: number;
    recentAnalysisFingerprints: string[];
    currentAnalysisTimeoutMs: number;
    promptTrimMode: boolean;
    historyMaxEntries: number;
    analysisStuckTimeoutMs: number;
    constructor(stateFilePath: string);
    load(): void;
    save(): void;
    computeFingerprint(summary: string): string;
    isDegenerate(threshold: number): {
        degenerate: boolean;
        reason?: string;
    };
    recordAnalysisFingerprint(summary: string): void;
}
