import { SummaryMemory } from './SummaryMemory';
import { VectorMemory } from './VectorMemory';
import { KnowledgeGraph } from './KnowledgeGraph';
import { EngineeringMemory } from './EngineeringMemory';
import { DecisionStore } from './DecisionStore';
import { MetaController } from './MetaController';
import { UnifiedMemoryQuery } from './UnifiedMemoryQuery';
import type { MemoryEntry } from './types';
export declare class MemoryService {
    private entries;
    private messageCount;
    private lastUserText;
    private removedIds;
    readonly summary: SummaryMemory;
    readonly vector: VectorMemory;
    readonly knowledgeGraph: KnowledgeGraph;
    readonly engineering: EngineeringMemory;
    readonly decisionStore: DecisionStore;
    readonly metaController: MetaController;
    readonly unifiedQuery: UnifiedMemoryQuery;
    constructor();
    private load;
    addEntry(type: MemoryEntry['type'], content: string, confidence: number, options?: {
        tier?: MemoryEntry['tier'];
    }): void;
    /** 自动晋升逻辑 */
    private tryPromote;
    addFact(content: string, confidence?: number, options?: {
        tier?: MemoryEntry['tier'];
    }): void;
    recordInteraction(): void;
    getInteractionCount(): number;
    /** 设置最近的用户消息文本，用于 getFormattedContext 中的语义召回 */
    setLastUserText(text: string): void;
    getFormattedContext(): string;
    /** 按衰减后分数排序 */
    private getScoredEntries;
    flush(): void;
    shutdown(): void;
    clear(): void;
    getEntries(): MemoryEntry[];
    private prune;
    private pruneTier;
    /** 永久层超出上限时移除最弱的 */
    private prunePermanent;
    private upsertInDb;
    private flushAllToDb;
}
