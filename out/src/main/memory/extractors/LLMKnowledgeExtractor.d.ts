export interface ExtractedTriple {
    entity: string;
    attribute: string;
    value: string;
    confidence: number;
}
export declare class LLMKnowledgeExtractor {
    private llm;
    setLlm(llm: {
        chatJson: Function;
    }): void;
    extract(content: string): Promise<ExtractedTriple[]>;
}
