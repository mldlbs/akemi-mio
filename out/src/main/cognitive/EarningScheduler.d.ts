import { TokenAccount } from './TokenEconomy';
interface EarningResult {
    date: string;
    totalEstimated: number;
    totalConfirmed: number;
    results: Array<{
        taskId: string;
        stage: string;
        estimatedEarnings: number;
        confirmedEarnings: number;
        effortMinutes: number;
        success: boolean;
        note?: string;
    }>;
}
export declare class EarningScheduler {
    private tokenAccount;
    private initialized;
    constructor(tokenAccount: TokenAccount);
    initialize(): void;
    runOnce(): Promise<EarningResult | null>;
    private runEarningCycle;
    getLastResult(): Promise<EarningResult | null>;
}
export {};
