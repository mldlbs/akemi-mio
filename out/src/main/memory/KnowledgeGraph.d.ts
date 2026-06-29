import { LLMKnowledgeExtractor } from './extractors/LLMKnowledgeExtractor';
export declare class KnowledgeGraph {
    private llmExtractor;
    setLLMExtractor(extractor: LLMKnowledgeExtractor): void;
    /** 从事实中提取实体关系并存储 */
    ingest(content: string, confidence: number): void;
    /** 查询指定实体的所有属性 */
    query(entity: string): Array<{
        attribute: string;
        value: string;
        confidence: number;
    }>;
    /** 构建可注入 prompt 的知识图谱上下文 */
    getFormattedContext(): string;
    private listEntities;
    /** 清除所有数据 */
    clear(): void;
}
