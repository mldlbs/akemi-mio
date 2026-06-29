/**
 * KnowledgeBaseService — 跨存储知识整合编排器
 *
 * 跨 MemoryService / SummaryMemory / KnowledgeGraph / EngineeringMemory / DecisionStore 五个存储：
 * 1. 统一查询并去重（精确匹配 + 前缀模糊匹配）
 * 2. 按优先级排序：permanent fact(100) > engineering(70) > summary(60) > ephemeral(40) > kg(30) > decision(10)
 * 3. 交叉引用：当 user_fact 话题也出现在 summary 中时合并标注
 */
export type KBStoreName = 'memory' | 'vector' | 'summary' | 'kg' | 'engineering' | 'decisions';
export interface KBResult {
    content: string;
    source: KBStoreName;
    priority: number;
    confidence: number;
    timestamp: number;
    dedupKey: string;
    crossReferences?: string[];
}
export interface KBQueryOptions {
    topK?: number;
    includeStores?: KBStoreName[];
    minConfidence?: number;
    queryText?: string;
}
export declare class KnowledgeBaseService {
    private memoryService;
    private unifiedQuery;
    setDeps(deps: {
        memoryService: any;
        unifiedQuery: any;
    }): void;
    /** 跨存储统一查询 */
    query(options?: KBQueryOptions): KBResult[];
    private toResult;
    /** 精确去重 + 前缀模糊去重 */
    private deduplicate;
    private computeDedupKey;
    private fuzzyMatch;
    /** 交叉引用：当不同存储的内容涉及相同话题时合并标注 */
    private crossReference;
    private extractKeywords;
    /** 构建格式化上下文块（用于 system prompt 注入） */
    getFormattedContext(options?: {
        queryText?: string;
        topK?: number;
    }): string;
    private storeLabel;
}
