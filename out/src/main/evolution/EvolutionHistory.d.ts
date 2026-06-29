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
/** 历史记录文件结构 */
export interface EvolutionHistory {
    cycles: EvolutionHistoryEntry[];
}
/**
 * 历史记录管理 — 加载/保存/摘要。
 * 从 SelfEvolutionService 提取。
 */
export declare class EvolutionHistoryManager {
    private historyPath;
    constructor(historyPath?: string);
    load(): EvolutionHistory;
    save(history: EvolutionHistory): void;
    recordCycle(entry: EvolutionHistoryEntry): void;
    getHistorySummary(maxEntries?: number): string;
    loadRecentFailures(): Array<{
        task: string;
        error: string;
        timestamp: number;
    }>;
}
