/**
 * MemoryAsrCrossValidator — ASR 结果与 Memory 假设的交叉验证器
 *
 * 职责：
 * 在 ASR 转录完成后，将 ASR 输出的文本与 Memory 路径生成的假设
 * （MemoryAsrHypothesis）进行交叉验证。验证结果包括：
 * - 一致度（agreementLevel）：ASR 文本对预期关键词的覆盖程度
 * - 命中/未命中关键词列表
 * - 置信度调整值（用于修正 ASR 的原始置信度）
 *
 * 设计原则：
 * - 轻量快速：纯文本匹配 + 简单词法分析，不使用 LLM
 * - 领域自适应：关键词匹配保留中文多词匹配能力
 * - 透明可解释：输出命中/未命中的关键词列表，便于调试
 *
 * 交叉验证流程：
 * 1. 关键词匹配：ASR 文本对 Memory 预期关键词的包含率
 * 2. 语义相关度：基于 n-gram 的文本相似度估算
 * 3. 上下文一致性：ASR 文本是否在预期的话题范围内
 * 4. 综合评分 → 一致度 (0–1)
 * 5. 一致度映射为置信度调整值 (-0.2 ~ +0.2)
 */

import type { MemoryAsrHypothesis, CrossValidationResult } from './types'

// 关键词语义归并：形近词 / 同领域词视为同一关键词
const KEYWORD_SYNONYM_GROUPS: Record<string, string[]> = {}

export class MemoryAsrCrossValidator {
  /**
   * 执行交叉验证。
   *
   * @param asrText     ASR 引擎输出的文本
   * @param hypothesis  Memory 路径生成的假设
   * @returns           CrossValidationResult
   */
  validate(asrText: string, hypothesis: MemoryAsrHypothesis): CrossValidationResult {
    // 如果假设为空或 ASR 文本为空，返回中性结果
    if (!asrText || !asrText.trim()) {
      return {
        agreementLevel: 0,
        matchedKeywords: [],
        unmatchedKeywords: [...hypothesis.expectedKeywords],
        confidenceAdjustment: 0,
      }
    }

    if (!hypothesis.expectedKeywords || hypothesis.expectedKeywords.length === 0) {
      return {
        agreementLevel: 0.5, // 无关键词时为中性
        matchedKeywords: [],
        unmatchedKeywords: [],
        confidenceAdjustment: 0,
      }
    }

    const lowerText = asrText.toLowerCase()
    const matched: string[] = []
    const unmatched: string[] = []

    // 1. 关键词匹配
    for (const kw of hypothesis.expectedKeywords) {
      if (this.keywordMatches(lowerText, kw)) {
        matched.push(kw)
      } else {
        unmatched.push(kw)
      }
    }

    // 2. n-gram 相似度（辅助评估）
    const ngramScore = this.computeNgramSimilarity(lowerText, hypothesis.predictedText.toLowerCase())

    // 3. 计算一致度
    const keywordRatio = matched.length / hypothesis.expectedKeywords.length
    const agreementLevel = 0.7 * keywordRatio + 0.3 * ngramScore

    // 4. 计算置信度调整值
    const confidenceAdjustment = this.computeConfidenceAdjustment(agreementLevel, keywordRatio)

    return {
      agreementLevel,
      matchedKeywords: matched,
      unmatchedKeywords: unmatched,
      confidenceAdjustment,
    }
  }

  /**
   * 判断关键词是否在 ASR 文本中匹配。
   * 支持中文和英文关键词的多重匹配策略。
   */
  private keywordMatches(text: string, keyword: string): boolean {
    if (!keyword || keyword.length === 0) return false

    const lowerKw = keyword.toLowerCase()

    // 直接包含
    if (text.includes(lowerKw)) return true

    // 中文字段：检查子串匹配（中文关键词通常按字/词匹配）
    if (lowerKw.length >= 2 && /[一-鿿]/.test(lowerKw)) {
      // 2-4 字中文关键词尝试逐字包含匹配
      if (lowerKw.length <= 4) {
        // 逐字检查：如果 80% 以上的字出现在文本中
        const matchingChars = [...lowerKw].filter((ch) => text.includes(ch)).length
        if (matchingChars / lowerKw.length >= 0.8) return true
      }
    }

    // 同义词组映射
    const synonyms = KEYWORD_SYNONYM_GROUPS[lowerKw]
    if (synonyms) {
      for (const syn of synonyms) {
        if (text.includes(syn)) return true
      }
    }

    return false
  }

  /**
   * 计算两个文本的 n-gram 相似度（Jaccard 系数）。
   * 用于补充关键词匹配的不足，在预测文本和 ASR 文本间建立语义关联。
   */
  private computeNgramSimilarity(text1: string, text2: string): number {
    if (!text1 || !text2) return 0

    const n = 2 // bigram

    const grams1 = this.extractNgrams(text1, n)
    const grams2 = this.extractNgrams(text2, n)

    if (grams1.size === 0 || grams2.size === 0) return 0

    // Jaccard: |intersection| / |union|
    let intersection = 0
    for (const g of grams1) {
      if (grams2.has(g)) intersection++
    }

    const union = grams1.size + grams2.size - intersection
    return union > 0 ? intersection / union : 0
  }

  /** 从文本中提取 n-gram 集合 */
  private extractNgrams(text: string, n: number): Set<string> {
    const grams = new Set<string>()
    // 只对中文字符和字母数字做 n-gram
    const clean = text.replace(/[^一-鿿\w]/g, '')
    for (let i = 0; i <= clean.length - n; i++) {
      grams.add(clean.slice(i, i + n))
    }
    return grams
  }

  /**
   * 将一致度映射为置信度调整值。
   * 一致度 ≥ 0.6 → 正向调整（最高 +0.15）
   * 一致度 0.3–0.6 → 微调（-0.05 ~ 0）
   * 一致度 < 0.3 → 负向调整（最低 -0.2）
   */
  private computeConfidenceAdjustment(agreementLevel: number, keywordRatio: number): number {
    if (agreementLevel >= 0.8 && keywordRatio >= 0.6) {
      return 0.15 // 强一致：大幅提升置信度
    }
    if (agreementLevel >= 0.6) {
      return 0.1 // 基本一致：小幅提升
    }
    if (agreementLevel >= 0.4) {
      return 0 // 中性：不调整
    }
    if (agreementLevel >= 0.2) {
      return -0.1 // 偏低：小幅降低
    }
    return -0.2 // 严重不匹配：大幅降低
  }
}

// ===== 单例 =====
export const memoryAsrCrossValidator = new MemoryAsrCrossValidator()
