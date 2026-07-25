/**
 * AsrLogCollector — ASR 识别日志分析采集器
 *
 * 作为 SignalCollector 接入自动化管道：
 * 1. 读取 AsrLogStore 中的用户纠正记录
 * 2. 通过频次聚类识别高频错误模式
 * 3. 标记新词汇（用户频繁输入但 ASR 常识别错的词）
 * 4. 生成 Problem 条目供执行器处理
 *
 * 运行条件：
 * - 最近 2 小时内至少存在 3 条纠正记录
 * - 或存在频次 >= 3 的同一错误模式
 */

import { log } from '../../logger/Logger'
import { asrLogStore } from '../../asr/AsrLogStore'
import { asrConfidenceScorer, DEFAULT_CONFIDENCE_THRESHOLD } from '../../asr/AsrConfidenceScorer'
import type { AsrErrorPattern, LowConfidenceSegment } from '../../asr/AsrLogStore'
import type { SignalCollector, Problem } from './types'

// =============================================================================
// 配置
// =============================================================================

/** 触发分析的最小纠正记录数 */
const MIN_CORRECTIONS_TO_ANALYZE = 3
/** 视为高频模式的最低频次 */
const HIGH_FREQ_THRESHOLD = 3
/** 分析窗口（毫秒）— 默认 2 小时 */
const ANALYSIS_WINDOW_MS = 2 * 60 * 60 * 1000
/** 单次采集最大生成的问题数（纠正模式） */
const MAX_PROBLEMS_PER_COLLECT = 5
/** 低置信度片段额外生成的最大问题数 */
const MAX_LOW_CONF_PROBLEMS = 3
/** 低置信度片段中视为"新兴词候补"的最小文本长度 */
const MIN_CANDIDATE_WORD_LENGTH = 2
/** 低置信度片段成为候补的最大文本长度（过长视为整句而非新词） */
const MAX_CANDIDATE_WORD_LENGTH = 6

// =============================================================================
// AsrLogCollector
// =============================================================================

export class AsrLogCollector implements SignalCollector {
  readonly name = 'AsrLogCollector'
  readonly source = 'log' as const
  private lastRunAt = 0

  shouldRun(): boolean {
    // 至少每隔一个分析窗口运行一次
    if (Date.now() - this.lastRunAt < ANALYSIS_WINDOW_MS) return false

    // 快速检查：最近窗口内是否有足够的纠正记录
    const recentCorrections = asrLogStore.getCorrectionsSince(Date.now() - ANALYSIS_WINDOW_MS)
    if (recentCorrections.length < MIN_CORRECTIONS_TO_ANALYZE) return false

    return true
  }

  getSkipReason(): string {
    if (Date.now() - this.lastRunAt < ANALYSIS_WINDOW_MS) {
      const remaining = Math.round((ANALYSIS_WINDOW_MS - (Date.now() - this.lastRunAt)) / 1000)
      return `cooldown: ${remaining}s remaining`
    }
    const recentCorrections = asrLogStore.getCorrectionsSince(Date.now() - ANALYSIS_WINDOW_MS)
    if (recentCorrections.length < MIN_CORRECTIONS_TO_ANALYZE) {
      return `insufficient_corrections: ${recentCorrections.length}/${MIN_CORRECTIONS_TO_ANALYZE}`
    }
    return 'unknown'
  }

  async collect(): Promise<Problem[]> {
    this.lastRunAt = Date.now()
    log('INFO', 'asr_log_collector_start')

    const problems: Problem[] = []

    try {
      // 1. 获取最近窗口内的错误模式
      const since = Date.now() - ANALYSIS_WINDOW_MS
      const patterns = asrLogStore.getErrorPatterns(since)

      log('INFO', 'asr_log_collector_patterns', {
        total_patterns: patterns.length,
        window_hours: ANALYSIS_WINDOW_MS / 3600000,
        window_corrections: asrLogStore.getCorrectionsSince(since).length,
      })

      // 2. 过滤高频模式
      const highFreqPatterns = patterns.filter((p) => p.frequency >= HIGH_FREQ_THRESHOLD)
      const mediumFreqPatterns = patterns.filter((p) => p.frequency >= 2 && p.frequency < HIGH_FREQ_THRESHOLD)

      // 3. 生成 Problem — 高频模式优先
      for (const pat of highFreqPatterns) {
        if (problems.length >= MAX_PROBLEMS_PER_COLLECT) break
        const problem = this.buildProblem(pat)
        if (problem) problems.push(problem)
      }

      // 4. 补充中频模式（如果有名额）
      for (const pat of mediumFreqPatterns) {
        if (problems.length >= MAX_PROBLEMS_PER_COLLECT) break
        // 跳过与高频模式相似的（避免重复）
        if (highFreqPatterns.some((hp) => isSimilarPattern(hp, pat))) continue
        const problem = this.buildProblem(pat)
        if (problem) problems.push(problem)
      }

      // 5. 处理低置信度识别片段 → 提取新兴/未登录词候补
      const lowConfProblems = this.collectLowConfidenceProblems(since)
      for (const p of lowConfProblems) {
        if (problems.length >= MAX_PROBLEMS_PER_COLLECT + MAX_LOW_CONF_PROBLEMS) break
        problems.push(p)
      }

      // 6. 检查待评估的快照（为下一轮评估提供数据）
      const pendingSnapshots = asrLogStore.getPendingSnapshots()
      if (pendingSnapshots.length > 0) {
        log('INFO', 'asr_log_collector_pending_eval', {
          count: pendingSnapshots.length,
          oldest: new Date(pendingSnapshots[0].timestamp).toISOString(),
        })
      }

      log('INFO', 'asr_log_collector_result', {
        problems_generated: problems.length,
        from_corrections: problems.length - lowConfProblems.length,
        from_low_confidence: lowConfProblems.length,
      })
    } catch (err) {
      log('ERROR', 'asr_log_collector_error', { error: String(err) })
    }

    return problems
  }

  /**
   * 将错误模式转换为 Problem 条目。
   */
  private buildProblem(pattern: AsrErrorPattern): Problem | null {
    if (!pattern.original || !pattern.corrected) return null

    const id = `asr_${pattern.original}_${pattern.corrected}`
      .replace(/[^a-zA-Z0-9_一-鿿]/g, '_')
      .slice(0, 64)

    const categoryLabel = this.getCategoryLabel(pattern.category)
    const title = `ASR 识别纠正: "${pattern.original}" → "${pattern.corrected}"`

    const description = [
      `【ASR 自进化问题】`,
      ``,
      `- 错误原文: "${pattern.original}"`,
      `- 正确文本: "${pattern.corrected}"`,
      `- 出现次数: ${pattern.frequency} 次`,
      `- 分类: ${categoryLabel}`,
      `- 最近出现: ${new Date(pattern.lastSeen).toLocaleString('zh-CN')}`,
      ``,
      this.getSuggestion(pattern),
    ].join('\n')

    return {
      id,
      source: 'log',
      severity: pattern.frequency >= HIGH_FREQ_THRESHOLD ? 'warning' : 'info',
      title,
      description,
      estimatedCostChars: description.length + 100,
      lastSeen: pattern.lastSeen,
      occurrenceCount: pattern.frequency,
      context: {
        raw: JSON.stringify(pattern),
        metadata: {
          asr_original: pattern.original,
          asr_corrected: pattern.corrected,
          asr_category: pattern.category,
          asr_frequency: String(pattern.frequency),
        },
      },
    }
  }

  /**
   * 为错误模式生成优化建议文本。
   */
  private getSuggestion(pattern: AsrErrorPattern): string {
    switch (pattern.category) {
      case 'homophone':
        return `建议: 将 "${pattern.corrected}" 添加为热词，帮助 ASR 引擎优先识别该词。`
      case 'new_word':
        return `建议: 检测到新领域词汇 "${pattern.corrected}"，添加为热词可提升识别率。`
      case 'domain_term':
        return `建议: 领域术语 "${pattern.corrected}" 识别不稳定，建议加入热词列表。`
      case 'partial_match':
        return `建议: ASR 识别 "${pattern.original}" 时漏掉部分内容，正确文本 "${pattern.corrected}" 可能含有热词。`
      case 'incomplete':
        return `建议: ASR 识别不完整，正确文本 "${pattern.corrected}" 可能包含生僻词或术语。`
      default:
        return `建议: 将 "${pattern.corrected}" 加入热词列表以提升识别准确率。`
    }
  }

  private getCategoryLabel(category: string): string {
    const labels: Record<string, string> = {
      homophone: '同音字',
      new_word: '新词汇',
      domain_term: '领域术语',
      partial_match: '部分匹配',
      incomplete: '识别不完整',
      noise: '噪声',
      low_confidence: '低置信度',
      candidate_word: '新词候选',
      unknown: '未分类',
    }
    return labels[category] || category
  }

  // ── 低置信度片段处理 ──

  /**
   * 从低置信度识别片段中提取新兴/未登录词候补。
   *
   * 策略：
   * 1. 筛选出窗口中低置信（< threshold）且未被纠正的识别片段
   * 2. 对文本进行分词，提取长度 2–6 字的候选词
   * 3. 过滤停用词、纯数字、纯标点
   * 4. 按文本去重，每个唯一文本生成一个问题
   */
  private collectLowConfidenceProblems(since: number): Problem[] {
    const segments = asrLogStore.getUncorrectedLowConfidenceSegments(since)
    if (segments.length === 0) return []

    log('INFO', 'asr_log_collector_low_conf', {
      total_segments: segments.length,
      window_since: new Date(since).toISOString(),
    })

    const problems: Problem[] = []
    const seenTexts = new Set<string>()

    for (const seg of segments) {
      if (problems.length >= MAX_LOW_CONF_PROBLEMS) break

      const text = seg.text.trim()
      if (text.length < MIN_CANDIDATE_WORD_LENGTH) continue
      if (text.length > MAX_CANDIDATE_WORD_LENGTH && !text.includes(' ')) continue
      if (/^\d+$/.test(text)) continue // 纯数字
      if (seenTexts.has(text)) continue

      // 检查是否已存在于纠正记录中（已通过其他渠道修复）
      const recentPatterns = asrLogStore.getErrorPatterns(since)
      const alreadyKnown = recentPatterns.some(
        (p) => p.original === text || p.corrected === text,
      )
      if (alreadyKnown) continue

      seenTexts.add(text)

      const id = `asr_lowconf_${text}`
        .replace(/[^a-zA-Z0-9_一-鿿]/g, '_')
        .slice(0, 64)

      problems.push({
        id,
        source: 'log',
        severity: 'info',
        title: `ASR 低置信度: "${text}"`,
        description: [
          `【ASR 新词候补 — 低置信度识别】`,
          ``,
          `- 识别文本: "${text}"`,
          `- 置信度: ${Math.round(seg.confidence * 100)}%`,
          `- 引擎: ${seg.engine}`,
          `- 片段长度: ${text.length} 字`,
          ``,
          `该片段置信度低于 ${Math.round(seg.threshold * 100)}%，可能包含`,
          `新兴词汇、未登录词或领域术语。建议将其添加为热词以提升后续识别率。`,
        ].join('\n'),
        estimatedCostChars: 200,
        lastSeen: seg.timestamp,
        occurrenceCount: 1,
        context: {
          raw: JSON.stringify(seg),
          metadata: {
            asr_original: text,
            asr_corrected: text,
            asr_category: 'candidate_word',
            asr_confidence: String(Math.round(seg.confidence * 100)),
            asr_segment_id: seg.id,
          },
        },
      })
    }

    return problems
  }
}

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 判断两个错误模式是否相似（避免生成重复问题）。
 */
function isSimilarPattern(a: AsrErrorPattern, b: AsrErrorPattern): boolean {
  if (a.original === b.original || a.corrected === b.corrected) return true
  // 编辑距离较小时认为相似
  const dist = levenshteinDistance(a.corrected, b.corrected)
  return dist <= 2
}

/**
 * 计算两个字符串的莱文斯坦编辑距离。
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = []
  for (let i = 0; i <= m; i++) {
    dp[i] = [i]
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      )
    }
  }
  return dp[m][n]
}
