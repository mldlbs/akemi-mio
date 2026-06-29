import type { MemoryService } from './MemoryService';
import type { EngineeringMemory, EngineeringEntry } from './EngineeringMemory';
import type { KnowledgeGraph } from './KnowledgeGraph';
import type { WorkerPool } from '../core/WorkerPool';
export declare class MemoryIndexer {
    private memoryService;
    private engineering;
    private knowledgeGraph;
    private timer;
    private intervalMs;
    private lastIndexed;
    private lastEntryCount;
    private workerPool;
    constructor(intervalMinutes?: number);
    setWorkerPool(wp: WorkerPool | null): void;
    setMemoryService(ms: MemoryService): void;
    setEngineering(eng: EngineeringMemory): void;
    setKnowledgeGraph(kg: KnowledgeGraph): void;
    start(): void;
    stop(): void;
    private tick;
    /** 纯函数：对条目执行匹配逻辑（供 worker 和 inline fallback 共享） */
    runIndex(entries: Array<{
        id?: string;
        type: string;
        content: string;
        confidence: number;
        updatedAt: number;
    }>, lastIndexed: number): {
        knowledgeEntries: Array<{
            content: string;
            confidence: number;
        }>;
        engineeringEntries: EngineeringEntry[];
    };
    /** 根据类型和内容推断标签 */
    private inferTags;
}
