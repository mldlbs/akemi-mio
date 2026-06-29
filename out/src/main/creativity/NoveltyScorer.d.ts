/**
 * NoveltyScorer — 代码层新颖度评估
 *
 * 在 LLM 自评 novelty 之外，通过文本相似度对输入假设进行再评估：
 * 1. 与近期假设（past 30）的 idea 文本对比，Jaccard 相似度 > 0.5 → 扣 15 分
 * 2. 与已拒绝假设的 idea 文本对比，Jaccard 相似度 > 0.6 → 标记为 rejected
 */
/** Jaccard 相似度：|A ∩ B| / |A ∪ B| */
export declare function jaccardSimilarity(a: string, b: string): number;
export interface NoveltyVerdict {
    /** 调整后的新颖度（0-100），可能被扣分 */
    adjustedNovelty: number;
    /** 是否应被自动拒绝（与已拒绝假设高度相似） */
    shouldReject: boolean;
    /** 为什么拒绝 */
    rejectReason?: string;
    /** 与最相似假设的信息 */
    mostSimilarTitle?: string;
    mostSimilarScore: number;
}
/**
 * 对一条新假设进行代码层新颖度评估
 *
 * @param candidate 新假设
 * @param recentHypotheses 近期假设（用于扣分）
 * @param rejectedHypotheses 已拒绝假设（用于自动拒绝）
 * @returns NoveltyVerdict
 */
export declare function evaluateNovelty(candidate: {
    title: string;
    idea: string;
    novelty: number;
}, recentHypotheses: {
    title: string;
    idea: string;
    novelty: number;
}[], rejectedHypotheses: {
    title: string;
    idea: string;
}[]): NoveltyVerdict;
