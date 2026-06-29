/**
 * NoveltyScorer — 代码层新颖度评估
 *
 * 在 LLM 自评 novelty 之外，通过文本相似度对输入假设进行再评估：
 * 1. 与近期假设（past 30）的 idea 文本对比，Jaccard 相似度 > 0.5 → 扣 15 分
 * 2. 与已拒绝假设的 idea 文本对比，Jaccard 相似度 > 0.6 → 标记为 rejected
 */
// ==================== Tokenizer ====================
/**
 * 简易 tokenizer：将文本拆分为 token 集合
 * - 英文词按空格/标点分割、转小写
 * - 中文按二元组（bigram）拆分（中文分词需要词典，这里用 bigram 近似）
 * - 去重、去空
 */
function tokenize(text) {
    const tokens = new Set();
    // 英文/数字 token
    const enTokens = text
        .toLowerCase()
        .split(/[^a-z0-9一-鿿]+/g)
        .filter((t) => t.length > 1 && /[a-z0-9]/.test(t));
    for (const t of enTokens)
        tokens.add(t);
    // 中文 bigram
    const chChars = text.replace(/[^一-鿿]/g, '');
    for (let i = 0; i < chChars.length - 1; i++) {
        tokens.add(chChars.slice(i, i + 2));
    }
    return tokens;
}
// ==================== Similarity ====================
/** Jaccard 相似度：|A ∩ B| / |A ∪ B| */
export function jaccardSimilarity(a, b) {
    const setA = tokenize(a);
    const setB = tokenize(b);
    const union = new Set([...setA, ...setB]);
    if (union.size === 0)
        return 0;
    let intersection = 0;
    for (const t of setA) {
        if (setB.has(t))
            intersection++;
    }
    return intersection / union.size;
}
/**
 * 对一条新假设进行代码层新颖度评估
 *
 * @param candidate 新假设
 * @param recentHypotheses 近期假设（用于扣分）
 * @param rejectedHypotheses 已拒绝假设（用于自动拒绝）
 * @returns NoveltyVerdict
 */
export function evaluateNovelty(candidate, recentHypotheses, rejectedHypotheses) {
    const candidateText = `${candidate.title} ${candidate.idea}`;
    let adjustedNovelty = candidate.novelty;
    let mostSimilarTitle = '';
    let mostSimilarScore = 0;
    // 1. 与近期假设对比
    for (const h of recentHypotheses) {
        const sim = jaccardSimilarity(candidateText, `${h.title} ${h.idea}`);
        if (sim > mostSimilarScore) {
            mostSimilarScore = sim;
            mostSimilarTitle = h.title;
        }
    }
    if (mostSimilarScore > 0.5) {
        adjustedNovelty = Math.max(0, adjustedNovelty - 15);
    }
    // 2. 与已拒绝假设对比 — 高度相似则自动拒绝
    for (const h of rejectedHypotheses) {
        const sim = jaccardSimilarity(candidateText, `${h.title} ${h.idea}`);
        if (sim > 0.6) {
            return {
                adjustedNovelty,
                shouldReject: true,
                rejectReason: `与已拒绝假设"${h.title}"内容高度相似 (Jaccard=${sim.toFixed(2)})`,
                mostSimilarTitle: h.title,
                mostSimilarScore: sim,
            };
        }
    }
    return {
        adjustedNovelty,
        shouldReject: false,
        mostSimilarTitle,
        mostSimilarScore,
    };
}
