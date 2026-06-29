import type { VectorEntry } from './types';
export declare class VectorMemory {
    private entries;
    private dirty;
    constructor();
    private load;
    store(content: string, confidence: number, source: VectorEntry['source']): Promise<void>;
    query(query: string, topK?: number): Promise<string[]>;
    /** 同步版本：使用 fallback 嵌入，用于 getFormattedContext 等同步调用路径 */
    querySync(query: string, topK?: number): string[];
    private prune;
    flush(): void;
    private saveToDb;
    private updateInDb;
    private flushToDb;
}
