export declare const EMBED_DIM = 384;
export declare function cosineSimilarity(a: number[], b: number[]): number;
/**
 * 基于字符 n-gram 哈希的 fallback 嵌入。
 * 不需要网络或预训练模型，确定性、跨会话一致。
 */
export declare function fallbackEmbed(text: string): number[];
export declare function getEmbedding(text: string): Promise<number[]>;
