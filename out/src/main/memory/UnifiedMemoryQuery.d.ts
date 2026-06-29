export interface QueryResult {
    store: string;
    content: string;
    score: number;
    metadata: Record<string, any>;
    timestamp: number;
}
export interface MemoryQueryOptions {
    types?: ('user_fact' | 'engineering' | 'summary' | 'knowledge_graph' | 'vector')[];
    topK?: number;
    minConfidence?: number;
}
export declare class UnifiedMemoryQuery {
    private stores;
    register(name: string, store: any): void;
    query(text: string, options?: MemoryQueryOptions): Promise<QueryResult[]>;
    getFormattedContext(options?: MemoryQueryOptions): Promise<string>;
}
