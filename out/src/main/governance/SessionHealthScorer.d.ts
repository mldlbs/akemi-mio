import type { HealthScoreResult, HealthLevel } from './SessionGovernorTypes';
export declare class SessionHealthScorer {
    private score;
    private toolWindow;
    private latencyWindow;
    private guardrailTripCount;
    private consecutiveFailures;
    private history;
    private readonly maxHistory;
    private readonly toolWindowSize;
    private readonly latencyWindowSize;
    getScore(): number;
    getLevel(): HealthLevel;
    getConsecutiveFailures(): number;
    recordToolResult(success: boolean): void;
    recordLatency(latencyMs: number): void;
    recordGuardrailTrip(): void;
    resetFailures(): void;
    private recompute;
    private computeInputs;
    private weightedScore;
    compute(): HealthScoreResult;
    private getTrend;
    getDiagnostics(): Record<string, unknown>;
    getSnapshot(): Record<string, unknown>;
    loadSnapshot(snap: Record<string, unknown>): void;
}
