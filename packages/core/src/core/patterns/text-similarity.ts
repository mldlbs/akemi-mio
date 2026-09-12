/**
 * text-similarity — 文本相似度工具函数
 *
 * 纯字符串运算，不依赖任何外部库，适合在热路径上使用。
 * 从 UserBehaviorAnalyzer 的 computeBigramJaccard 中提取，
 * 供 UserBehavior、Plan:修正工业颂歌 及其他模块复用。
 *
 * 当前功能：
 * - computeBigramJaccard — 字符 bigram Jaccard 相似度
 *
 * 设计原则：
 * - 纯函数、无副作用
 * - 无偏见、不依赖业务类型
 * - 可在任意上下文使用
 */

// ════════════════════════════════════════════════════════════════
//  Bigram Jaccard 相似度
// ════════════════════════════════════════════════════════════════

/**
 * 计算两个文本的字符 bigram Jaccard 相似度。
 * 纯字符串运算，不依赖任何外部库，适合在热路径上使用。
 *
 * 算法：
 * 1. 将文本转为小写并提取所有相邻字符对（bigram）
 * 2. Jaccard = |交集| / |并集|
 * 3. 返回 0~1 之间的相似度
 *
 * 示例：
 *   "hello" → ["he","el","ll","lo"]
 *   "helo"  → ["he","el","lo"]
 *   Jaccard = 3/5 = 0.6
 *
 * @param a 第一个字符串
 * @param b 第二个字符串
 * @returns 0~1 的相似度值
 */
export function computeBigramJaccard(a: string, b: string): number {
  if (a === b) return 1.0
  if (!a || !b) return 0

  const bigramsA = new Set<string>()
  const bigramsB = new Set<string>()

  for (let i = 0; i < a.length - 1; i++) {
    bigramsA.add(a.slice(i, i + 2))
  }
  for (let i = 0; i < b.length - 1; i++) {
    bigramsB.add(b.slice(i, i + 2))
  }

  if (bigramsA.size === 0 && bigramsB.size === 0) return 0

  // 计算交集大小
  let intersection = 0
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++
  }

  const union = bigramsA.size + bigramsB.size - intersection
  if (union === 0) return 0

  return intersection / union
}
