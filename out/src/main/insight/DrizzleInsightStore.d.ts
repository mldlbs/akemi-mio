import type { Insight } from './types';
export declare class DrizzleInsightStore {
    getAll(): Insight[];
    addMany(items: Insight[]): void;
    getUnreported(): Insight[];
    getHighValueUnreported(scoreThreshold?: number, confidenceThreshold?: number): Insight[];
    markReported(id: string): void;
    markAllReported(): void;
    prune(maxAgeDays?: number): number;
    count(): number;
    private rowsToInsights;
}
