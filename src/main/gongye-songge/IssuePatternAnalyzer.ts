/**
 * IssuePatternAnalyzer — 修正问题模式分析器
 *
 * 将 UserBehavior 的「BehaviorFeatureExtractor」模式分析能力移植到
 * Plan:修正工业颂歌19-27章 上下文。
 *
 * ── 移植的算法模式 ──
 *
 * 1. n-gram 序列分析（来自 BehaviorFeatureExtractor.extractSequences）
 *    原始：对工具调用顺序做 n-gram 提取，发现高频序列
 *    适配：对跨章节的修正问题类别做 n-gram 提取，发现问题共现模式
 *
 * 2. 频率分布分析（来自 BehaviorFeatureExtractor.extractFrequentTools）
 *    原始：统计工具调用频率
 *    适配：统计问题类别分布，识别主导问题类型
 *
 * 3. 趋势计算（来自 BehaviorHeatmapService.computeTrend）
 *    原始：模块使用占比变化趋势（rising/declining/stable）
 *    适配：章节评分趋势（improving/declining/stable）
 *
 * 4. 密度检测（来自 BehaviorFeatureExtractor.extractPausePoints）
 *    原始：检测工具调用间的异常等待时间
 *    适配：检测问题密度变化区域（问题集中爆发 vs 稀疏）
 *
 * ── 使用 ──
 * ```ts
 * const analyzer = new IssuePatternAnalyzer()
 * const analysis = analyzer.analyze(correctionResult)
 * // analysis.clusters[] — 问题共现簇
 * // analysis.severityTrend — 评分趋势
 * // analysis.issueDensity — 问题密度分布
 * // analysis.summary — 可读报告
 * ```
 *
 * ── 与 BehaviorFeatureExtractor 的差异 ──
 * - BehaviorFeatureExtractor 依赖 UserBehaviorAnalyzer 运行时数据
 * - IssuePatternAnalyzer 依赖 CorrectionResult（Plan 评估输出）
 * - 算法核心相同，数据类型不同
 */

import { log } from '../logger/Logger'
import type {
  CorrectionResult,
  ChapterCorrectionSnapshot,
  CorrectionSeverity,
  CorrectionCategory,
} from './PlanSonggeCorrectionAdapter'

// ═══════════════════════════════════════════════════════════════════
//  配置常量
// ═══════════════════════════════════════════════════════════════════

/** 共现分析：最小共现次数 */
const MIN_CO_OCCURRENCE = 2

/** 趋势分析：变化阈值（评分变化 >= 此值视为有意义） */
const TREND_CHANGE_THRESHOLD = 0.10

/** 密度分析：高密度阈值（章节问题数 >= 总平均 + 此倍标准差） */
const DENSITY_HIGH_MULTIPLIER = 1.5

/** 密度分析：低密度阈值（章节问题数 <= 总平均 - 此倍标准差 * 0.5） */
const DENSITY_LOW_MULTIPLIER = 0.5

// ═══════════════════════════════════════════════════════════════════
//  输出类型
// ═══════════════════════════════════════════════════════════════════

/** 问题共现簇 — 哪些问题类别倾向于同时出现 */
export interface IssueCluster {
  /** 共现的问题类别列表 */
  categories: CorrectionCategory[]
  /** 共现次数 */
  occurrenceCount: number
  /** 共现的章节索引 */
  chapterIndices: number[]
  /** 共现概率（0-1）— 在所有包含这些类别的章节中的比例 */
  probability: number
}

/** 评分趋势方向 */
export type ScoreTrend = 'improving' | 'declining' | 'volatile' | 'stable'

/** 评分趋势分析 */
export interface ScoreTrendAnalysis {
  /** 趋势方向 */
  direction: ScoreTrend
  /** 首章到末章的变化量（末章评分 - 首章评分） */
  delta: number
  /** 变化百分比 */
  deltaPercent: number
  /** 各章节评分序列（按章节号升序） */
  scoreSeries: Array<{ chapterIndex: number; compositeScore: number }>
  /** 评分方差（波动性指标） */
  variance: number
  /** 最高评分章节 */
  peakChapter: { chapterIndex: number; score: number } | null
  /** 最低评分章节 */
  valleyChapter: { chapterIndex: number; score: number } | null
}

/** 问题密度分布 */
export interface DensityDistribution {
  /** 高密度章节（问题数异常多） */
  highDensity: Array<{ chapterIndex: number; issueCount: number }>
  /** 低密度章节（问题数异常少） */
  lowDensity: Array<{ chapterIndex: number; issueCount: number }>
  /** 平均每章问题数 */
  averagePerChapter: number
  /** 问题数标准差 */
  standardDeviation: number
  /** 问题数最多/最少的章节区间 */
  range: { from: number; to: number; totalIssues: number } | null
}

/** 问题类别频率统计（类比 BehaviorFeatureExtractor.extractFrequentTools） */
export interface CategoryFrequency {
  /** 问题类别 */
  category: CorrectionCategory
  /** 出现总次数 */
  count: number
  /** 在所有问题中的占比 (0-1) */
  ratio: number
  /** 影响的章节数 */
  affectedChapters: number
  /** 该类别问题的平均严重程度 */
  avgSeverity: number
}

/** 完整模式分析结果 */
export interface IssuePatternAnalysis {
  /** 问题共现簇列表 */
  clusters: IssueCluster[]
  /** 评分趋势分析 */
  severityTrend: ScoreTrendAnalysis
  /** 问题密度分布 */
  density: DensityDistribution
  /** 各问题类别频率 */
  categoryFrequencies: CategoryFrequency[]
  /** 数据是否足够做分析 */
  hasSufficientData: boolean
  /** 分析的章节数 */
  totalChapters: number
  /** 总问题数 */
  totalIssues: number
  /** 分析时间戳 */
  analyzedAt: number
  /** 可读的分析摘要文本 */
  summary: string
}

// ═══════════════════════════════════════════════════════════════════
//  严重程度映射（用于频率统计中的数值平均）
// ═══════════════════════════════════════════════════════════════════

const SEVERITY_ORDER: Record<CorrectionSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  info: 1,
}

// ═══════════════════════════════════════════════════════════════════
//  IssuePatternAnalyzer
// ═══════════════════════════════════════════════════════════════════

export class IssuePatternAnalyzer {
  /**
   * 对修正评估结果进行跨章节模式分析。
   *
   * 算法来源：BehaviorFeatureExtractor
   *   extractSequences  →  issue co-occurrence n-gram
   *   extractFrequentTools →  category frequency aggregation
   *   BehaviorHeatmapService.computeTrend  →  score trend analysis
   *   extractPausePoints  →  issue density clustering
   */
  analyze(result: CorrectionResult): IssuePatternAnalysis {
    if (!result || result.snapshots.length === 0) {
      return {
        clusters: [],
        severityTrend: this.emptyTrend(),
        density: this.emptyDensity(),
        categoryFrequencies: [],
        hasSufficientData: false,
        totalChapters: 0,
        totalIssues: 0,
        analyzedAt: Date.now(),
        summary: '【模式分析】数据不足，尚未生成。',
      }
    }

    const snapshots = result.snapshots
    const totalChapters = snapshots.length
    const totalIssues = result.totalIssues

    // 并行提取各维度模式
    const clusters = this.detectClusters(snapshots)
    const severityTrend = this.analyzeScoreTrend(snapshots)
    const density = this.analyzeDensity(snapshots)
    const categoryFrequencies = this.aggregateCategoryFrequencies(snapshots)

    const hasSufficientData = snapshots.length >= 2 && totalIssues >= 1

    // 生成可读摘要
    const summary = this.buildSummary(
      clusters,
      severityTrend,
      density,
      categoryFrequencies,
      totalChapters,
      totalIssues,
    )

    log('INFO', 'issue_pattern_analysis_done', {
      totalChapters,
      totalIssues,
      clusters: clusters.length,
      trend: severityTrend.direction,
      highDensityChapters: density.highDensity.length,
    })

    return {
      clusters,
      severityTrend,
      density,
      categoryFrequencies,
      hasSufficientData,
      totalChapters,
      totalIssues,
      analyzedAt: Date.now(),
      summary,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  1. 问题共现检测（n-gram 适配）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 检测跨章节的问题类别共现模式。
   *
   * 算法来源：BehaviorFeatureExtractor.extractSequences
   * 原始：提取工具名的 n-gram 序列（连续工具调用）
   * 适配：提取同一章节内的问题类别组合（非有序，共现）
   */
  private detectClusters(snapshots: ChapterCorrectionSnapshot[]): IssueCluster[] {
    // 每章的问题类别集合
    const chapterCategories = snapshots
      .filter((s) => s.issues.length > 0)
      .map((s) => ({
        chapterIndex: s.chapterIndex,
        categories: [...new Set(s.issues.map((i) => i.category))],
      }))

    if (chapterCategories.length < 2) return []

    // 统计所有成对/三组合的共现
    const coOccurrenceMap = new Map<string, { count: number; chapters: number[] }>()

    for (const { chapterIndex, categories } of chapterCategories) {
      if (categories.length < 2) continue

      // 2-组合（成对共现）
      for (let i = 0; i < categories.length; i++) {
        for (let j = i + 1; j < categories.length; j++) {
          const key = this.sortKey([categories[i], categories[j]])
          const entry = coOccurrenceMap.get(key) ?? { count: 0, chapters: [] }
          entry.count++
          if (!entry.chapters.includes(chapterIndex)) {
            entry.chapters.push(chapterIndex)
          }
          coOccurrenceMap.set(key, entry)
        }
      }

      // 3-组合（三元共现，仅当章节至少有 3 种问题类别）
      if (categories.length >= 3) {
        for (let i = 0; i < categories.length; i++) {
          for (let j = i + 1; j < categories.length; j++) {
            for (let k = j + 1; k < categories.length; k++) {
              const key = this.sortKey([categories[i], categories[j], categories[k]])
              const entry = coOccurrenceMap.get(key) ?? { count: 0, chapters: [] }
              entry.count++
              if (!entry.chapters.includes(chapterIndex)) {
                entry.chapters.push(chapterIndex)
              }
              coOccurrenceMap.set(key, entry)
            }
          }
        }
      }
    }

    // 过滤低频 → 排序 → 输出
    const clusters: IssueCluster[] = []
    const totalAffectedChapters = chapterCategories.length

    for (const [key, data] of coOccurrenceMap) {
      if (data.count < MIN_CO_OCCURRENCE) continue

      const categories = key.split('|') as CorrectionCategory[]
      const probability = data.chapters.length / Math.max(1, totalAffectedChapters)

      clusters.push({
        categories,
        occurrenceCount: data.count,
        chapterIndices: data.chapters.sort((a, b) => a - b),
        probability: Math.min(1, probability),
      })
    }

    // 按共现次数降序排列
    clusters.sort((a, b) => b.occurrenceCount - a.occurrenceCount)

    return clusters
  }

  /** 将类别数组排序后以 | 连接（用于共现 key） */
  private sortKey(categories: CorrectionCategory[]): string {
    return [...categories].sort().join('|')
  }

  // ═══════════════════════════════════════════════════════════════
  //  2. 评分趋势分析
  // ═══════════════════════════════════════════════════════════════

  /**
   * 分析第19-27章的评分趋势。
   *
   * 算法来源：BehaviorHeatmapService.computeTrend
   * 原始：模块使用占比变化趋势
   * 适配：各章节复合评分变化趋势
   *
   * 趋势判断：
   * - improving: 末章评分比首章高 TREND_CHANGE_THRESHOLD 以上且方差低
   * - declining: 末章评分比首章低 TREND_CHANGE_THRESHOLD 以上且方差低
   * - volatile: 方差高、无明显方向
   * - stable: 变化量在阈值内
   */
  private analyzeScoreTrend(snapshots: ChapterCorrectionSnapshot[]): ScoreTrendAnalysis {
    if (snapshots.length < 2) return this.emptyTrend()

    // 按章节号排序
    const sorted = [...snapshots].sort((a, b) => a.chapterIndex - b.chapterIndex)

    const scoreSeries = sorted.map((s) => ({
      chapterIndex: s.chapterIndex,
      compositeScore: s.compositeScore,
    }))

    const scores = scoreSeries.map((s) => s.compositeScore)

    // 首末变化
    const first = scores[0]
    const last = scores[scores.length - 1]
    const delta = last - first
    const deltaPercent = first > 0 ? (delta / first) * 100 : 0

    // 方差
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length

    // 峰值/谷值
    let peakIdx = 0
    let valleyIdx = 0
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > scores[peakIdx]) peakIdx = i
      if (scores[i] < scores[valleyIdx]) valleyIdx = i
    }

    // 趋势判定
    const direction: ScoreTrend = (() => {
      if (variance > 0.05) return 'volatile'
      if (delta > TREND_CHANGE_THRESHOLD) return 'improving'
      if (delta < -TREND_CHANGE_THRESHOLD) return 'declining'
      return 'stable'
    })()

    return {
      direction,
      delta,
      deltaPercent,
      scoreSeries,
      variance,
      peakChapter: { chapterIndex: scoreSeries[peakIdx].chapterIndex, score: scores[peakIdx] },
      valleyChapter: { chapterIndex: scoreSeries[valleyIdx].chapterIndex, score: scores[valleyIdx] },
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  3. 问题密度分析
  // ═══════════════════════════════════════════════════════════════

  /**
   * 分析问题密度分布。
   *
   * 算法来源：BehaviorFeatureExtractor.extractPausePoints
   * 原始：检测工具调用间的异常等待时间
   * 适配：检测单章问题数偏离平均值程度
   *
   * 密度判定：
   * - highDensity: 问题数 >= mean + DENSITY_HIGH_MULTIPLIER * stddev
   * - lowDensity: 问题数 <= mean - DENSITY_LOW_MULTIPLIER * stddev
   */
  private analyzeDensity(snapshots: ChapterCorrectionSnapshot[]): DensityDistribution {
    if (snapshots.length === 0) return this.emptyDensity()

    const issueCounts = snapshots.map((s) => ({
      chapterIndex: s.chapterIndex,
      issueCount: s.issues.length,
    }))

    const counts = issueCounts.map((c) => c.issueCount)
    const total = counts.reduce((a, b) => a + b, 0)
    const mean = total / counts.length
    const stddev = Math.sqrt(counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length)

    const highThreshold = mean + DENSITY_HIGH_MULTIPLIER * stddev
    const lowThreshold = Math.max(0, mean - DENSITY_LOW_MULTIPLIER * stddev)

    const highDensity = issueCounts
      .filter((c) => c.issueCount >= highThreshold)
      .map((c) => ({ chapterIndex: c.chapterIndex, issueCount: c.issueCount }))

    const lowDensity = issueCounts
      .filter((c) => c.issueCount <= lowThreshold && c.issueCount > 0)
      .map((c) => ({ chapterIndex: c.chapterIndex, issueCount: c.issueCount }))

    // 找到问题最密集的连续章节区间
    let bestRange: { from: number; to: number; totalIssues: number } | null = null
    if (snapshots.length >= 3) {
      let maxIssues = 0
      for (let i = 0; i <= snapshots.length - 3; i++) {
        const rangeIssues = snapshots.slice(i, i + 3).reduce((s, snap) => s + snap.issues.length, 0)
        if (rangeIssues > maxIssues) {
          maxIssues = rangeIssues
          bestRange = {
            from: snapshots[i].chapterIndex,
            to: snapshots[i + 2].chapterIndex,
            totalIssues: rangeIssues,
          }
        }
      }
    }

    return {
      highDensity,
      lowDensity,
      averagePerChapter: mean,
      standardDeviation: stddev,
      range: bestRange,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  4. 问题类别频率统计
  // ═══════════════════════════════════════════════════════════════

  /**
   * 聚合各问题类别的频率。
   *
   * 算法来源：BehaviorFeatureExtractor.extractFrequentTools
   * 原始：统计各工具调用频率
   * 适配：统计各问题类别出现频率
   */
  private aggregateCategoryFrequencies(snapshots: ChapterCorrectionSnapshot[]): CategoryFrequency[] {
    const stats = new Map<
      CorrectionCategory,
      { count: number; chapters: Set<number>; severitySum: number }
    >()

    for (const snap of snapshots) {
      for (const issue of snap.issues) {
        const entry = stats.get(issue.category) ?? {
          count: 0,
          chapters: new Set(),
          severitySum: 0,
        }
        entry.count++
        entry.chapters.add(snap.chapterIndex)
        entry.severitySum += SEVERITY_ORDER[issue.severity] ?? 1
        stats.set(issue.category, entry)
      }
    }

    const totalIssues = Array.from(stats.values()).reduce((s, e) => s + e.count, 0)

    const frequencies: CategoryFrequency[] = Array.from(stats.entries())
      .map(([category, data]) => ({
        category,
        count: data.count,
        ratio: totalIssues > 0 ? data.count / totalIssues : 0,
        affectedChapters: data.chapters.size,
        avgSeverity: data.count > 0 ? data.severitySum / data.count : 1,
      }))
      .sort((a, b) => b.count - a.count)

    return frequencies
  }

  // ═══════════════════════════════════════════════════════════════
  //  5. 摘要生成
  // ═══════════════════════════════════════════════════════════════

  /**
   * 生成可读的模式分析摘要。
   * 供 PlanFirstCorrectionPipeline 的最终输出使用。
   */
  private buildSummary(
    clusters: IssueCluster[],
    trend: ScoreTrendAnalysis,
    density: DensityDistribution,
    frequencies: CategoryFrequency[],
    totalChapters: number,
    totalIssues: number,
  ): string {
    const lines: string[] = []

    lines.push('📊 【跨章节模式分析 — 基于第19-27章修正评估】')
    lines.push('')
    lines.push(`共分析 ${totalChapters} 章，发现 ${totalIssues} 个问题。`)
    lines.push('')

    // 趋势
    const trendIcon =
      trend.direction === 'improving' ? '📈' :
      trend.direction === 'declining' ? '📉' :
      trend.direction === 'volatile' ? '📊' : '➡️'
    lines.push(`${trendIcon} 评分趋势：${this.trendLabel(trend.direction)}`)
    if (trend.peakChapter) {
      lines.push(`  · 最高分：第${trend.peakChapter.chapterIndex}章（${(trend.peakChapter.score * 100).toFixed(1)}%）`)
    }
    if (trend.valleyChapter) {
      lines.push(`  · 最低分：第${trend.valleyChapter.chapterIndex}章（${(trend.valleyChapter.score * 100).toFixed(1)}%）`)
    }
    if (trend.delta !== 0) {
      const arrow = trend.delta > 0 ? '↑' : '↓'
      lines.push(`  · 首末变化：${arrow} ${(Math.abs(trend.delta) * 100).toFixed(1)}%`)
    }
    lines.push('')

    // 问题类别分布
    if (frequencies.length > 0) {
      lines.push('🔍 问题类别分布（Top 3）：')
      for (const freq of frequencies.slice(0, 3)) {
        const sevLabel = this.severityLabel(freq.avgSeverity)
        lines.push(
          `  · ${freq.category}：${freq.count} 次（${(freq.ratio * 100).toFixed(0)}%），` +
          `影响 ${freq.affectedChapters} 章，平均严重度 ${sevLabel}`,
        )
      }
      lines.push('')
    }

    // 问题共现模式
    if (clusters.length > 0) {
      lines.push('🔗 问题共现模式（Top 3）：')
      for (const cluster of clusters.slice(0, 3)) {
        const chStr = cluster.chapterIndices.join('、')
        lines.push(
          `  · 「${cluster.categories.join(' + ')}」共现 ${cluster.occurrenceCount} 次` +
          `（第${chStr}章，概率 ${(cluster.probability * 100).toFixed(0)}%）`,
        )
      }
      lines.push('')
    }

    // 密度分布
    if (density.highDensity.length > 0) {
      lines.push('⚡ 问题高密度章节：')
      for (const hd of density.highDensity) {
        lines.push(`  · 第${hd.chapterIndex}章：${hd.issueCount} 个问题（均值 ${density.averagePerChapter.toFixed(1)}）`)
      }
      lines.push('')
    }

    if (density.range) {
      lines.push(
        `📌 问题最密集区间：第${density.range.from}-${density.range.to}章（${density.range.totalIssues} 个问题）`,
      )
    }

    return lines.join('\n')
  }

  private trendLabel(direction: ScoreTrend): string {
    switch (direction) {
      case 'improving': return '整体改善 ✅'
      case 'declining': return '整体下滑 ⚠️'
      case 'volatile': return '波动较大 📊'
      case 'stable': return '基本稳定 ➡️'
    }
  }

  private severityLabel(avgSeverity: number): string {
    if (avgSeverity >= 3.5) return '严重'
    if (avgSeverity >= 2.5) return '中等'
    if (avgSeverity >= 1.5) return '轻微'
    return '信息'
  }

  // ═══════════════════════════════════════════════════════════════
  //  空值工厂
  // ═══════════════════════════════════════════════════════════════

  private emptyTrend(): ScoreTrendAnalysis {
    return {
      direction: 'stable',
      delta: 0,
      deltaPercent: 0,
      scoreSeries: [],
      variance: 0,
      peakChapter: null,
      valleyChapter: null,
    }
  }

  private emptyDensity(): DensityDistribution {
    return {
      highDensity: [],
      lowDensity: [],
      averagePerChapter: 0,
      standardDeviation: 0,
      range: null,
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  单例
// ═══════════════════════════════════════════════════════════════════

export const issuePatternAnalyzer = new IssuePatternAnalyzer()
