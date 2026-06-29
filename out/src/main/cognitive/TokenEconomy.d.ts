export declare class TokenAccount {
    private initialized;
    private cachedBalance;
    initialize(): Promise<void>;
    /** 公开的自动补充入口 — 可在运行时周期性调用 */
    refreshAllowance(): void;
    private applyAutoAllowance;
    getBalance(): number;
    earn(amount: number, category: string, note?: string): void;
    spend(amount: number, category: string, note?: string): void;
    canAfford(estimatedCost: number): boolean;
    getWealthLevel(): 'poor' | 'moderate' | 'rich';
    getRecentSummary(count?: number): string;
    getFormattedContext(): string;
    getLifetimeStats(): {
        earned: number;
        spent: number;
    };
}
export declare class CostEstimator {
    estimateLLMCall(prompt: string, systemPrompt: string): number;
    estimateTask(taskType: string, complexity?: 'low' | 'medium' | 'high'): number;
    estimateContentRevenue(contentLength: number): number;
    isWorthwhile(earnings: number, cost: number, threshold?: number): boolean;
}
