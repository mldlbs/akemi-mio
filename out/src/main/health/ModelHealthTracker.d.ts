export interface ModelHealthResult {
    score: number;
    errorBreakdown: Record<string, number>;
    totalToolCalls: number;
    successCount: number;
    failureCount: number;
}
/**
 * ModelHealthTracker — 4-health-dimension: LLM/tool error rate tracking.
 *
 * Listens to EventBus for tool completion/failure and error classification
 * events, producing a health score (0-100) for the model dimension.
 */
export declare class ModelHealthTracker {
    private errorCounts;
    private successCount;
    private failureCount;
    private subs;
    private _started;
    start(): void;
    stop(): void;
    getHealth(): ModelHealthResult;
    getDiagnostics(): Record<string, unknown>;
}
