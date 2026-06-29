import type { Insight } from './types';
export declare class InsightStore {
    private data;
    private filePath;
    constructor(filePath: string);
    private load;
    private save;
    addMany(insights: Insight[]): void;
    getUnreported(): Insight[];
    getHighValueUnreported(scoreThreshold?: number, confidenceThreshold?: number): Insight[];
    markReported(id: string): void;
    markAllReported(): void;
    getAll(): Insight[];
    prune(maxAgeDays?: number): number;
    count(): number;
}
