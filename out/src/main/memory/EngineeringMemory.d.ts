export interface EngineeringEntry {
    id: string;
    type: 'architecture_pattern' | 'coding_convention' | 'design_decision' | 'test_pattern' | 'failure_pattern';
    content: string;
    source: string;
    confidence: number;
    relatedFiles: string[];
    tags: string[];
    createdAt: number;
    updatedAt: number;
}
export declare class EngineeringMemory {
    store(entry: Omit<EngineeringEntry, 'id' | 'createdAt' | 'updatedAt'>): void;
    query(params?: {
        types?: string[];
        tags?: string[];
        topK?: number;
    }): EngineeringEntry[];
    search(text: string, topK?: number): EngineeringEntry[];
    getFormattedContext(topK?: number): string;
    getRelatedFiles(filePath: string): string[];
    private prune;
}
