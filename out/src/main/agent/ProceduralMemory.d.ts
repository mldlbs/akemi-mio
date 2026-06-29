export interface Procedure {
    id: string;
    name: string;
    description: string;
    steps: string[];
    triggerKeywords: string[];
    successCount: number;
    failCount: number;
    embedding?: number[];
    createdAt: number;
    updatedAt: number;
}
/**
 * ProceduralMemory — 记录可复用的成功操作序列。
 *
 * LLM 通过 remember_procedure 工具保存流程，
 * 系统通过触发词在 system prompt 中注入相关流程。
 */
export declare class ProceduralMemory {
    save(params: {
        name: string;
        description: string;
        steps: string[];
        triggerKeywords: string[];
    }): Procedure;
    /** 从组合文本生成向量嵌入（同步 fallback） */
    private computeEmbedding;
    /** 按语义向量搜索相关流程 */
    findByEmbedding(query: string, topK?: number): Procedure[];
    /** 按触发词搜索相关流程 */
    findByKeywords(keywords: string[], topK?: number): Procedure[];
    private findByName;
    listAll(): Procedure[];
    recordHit(name: string): void;
    recordFail(name: string): void;
    /** 格式化上下文注入 */
    getFormattedContext(keywords?: string[]): string;
    private prune;
    private rowToProc;
}
