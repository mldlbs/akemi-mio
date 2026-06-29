import type { SummaryEntry } from './types';
export declare class SummaryMemory {
    private entries;
    private dirty;
    constructor();
    private load;
    private parseJsonField;
    addSummary(summary: string, turnStart: number, turnEnd: number, options?: {
        topics?: string[];
        decisions?: string[];
        keyEntities?: string[];
    }): void;
    getRecent(limit?: number): string[];
    getRecentFull(limit?: number): SummaryEntry[];
    getAll(): SummaryEntry[];
    flush(): void;
    private saveToDb;
    private flushToDb;
}
