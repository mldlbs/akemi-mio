/**
 * BehaviorUsagePatternAnalyzer — 使用模式分析器
 *
 * 从 UserBehavior 交互日志中提取使用模式，供进化系统在 2 小时周期中
 * 动态调整系统参数（TTS 音色、Memory 摘要增强等）。
 *
 * ## 分析维度
 *
 * 1. **时段模式 (timePattern)**
 *    - 按小时统计交互频次，识别高峰时段
 *    - 检测深夜活跃（23:00-05:59）：通常需要更柔和的 TTS 音色
 *    - 输出活跃时段列表 + 深夜活跃标记
 *
 * 2. **提问类型分类 (questionType)**
 *    - 将用户消息按关键词模式分类：
 *      debug（调试/报错）、code_gen（编码/实现）、query（查询/搜索）、
 *      chat（聊天/日常）、command（指令/操作）、creative（创作/写作）
 *    - 输出类型分布（占比）
 *
 * 3. **情感倾向分析 (sentiment)**
 *    - 基于文本标记的简单情感检测：
 *      急迫（urgent）、沮丧（frustrated）、满意（satisfied）、中性（neutral）
 *    - 输出情感分布
 *
 * 4. **重复模式检测 (repeatedPattern)**
 *    - 对连续交互的话题标签做相似度比较
 *    - 检测反复出现的同一话题/问题
 *    - 输出重复话题列表
 *
 * ## 数据源
 * - 优先读取 interaction_log 表（DB）：最近 200 条记录
 * - 降级使用 userBehaviorAnalyzer 的运行时数据
 *
 * ## 集成点
 * - BehaviorUsageCollector（evolution/automation）在管道的 collect 阶段调用 analyze()
 * - 分析结果转换为 Problem 后由 BehaviorParamAdjustmentExecutor 执行调整
 *
 * @module behavior
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { getRawDb } from '@akemi-mio/core/db/connection'

// ══════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════

/** 时段分析结果 */
export interface TimePatternAnalysis {
  /** 按小时统计的交互频次（0-23） */
  hourlyCounts: number[]
  /** 高峰时段（交互数 >= 均值 + 1 标准差的小时） */
  peakHours: number[]
  /** 当前是否处于深夜时段（23:00-05:59） */
  isCurrentlyLateNight: boolean
  /** 最近 N 次交互中，深夜时段占比 */
  lateNightRatio: number
  /** 总交互数 */
  totalInteractions: number
}

/** 提问类型枚举 */
export type QuestionType = 'debug' | 'code_gen' | 'query' | 'chat' | 'command' | 'creative' | 'other'

/** 提问类型分析结果 */
export interface QuestionTypeAnalysis {
  /** 各类型频次 */
  counts: Record<QuestionType, number>
  /** 各类型占比（0-1） */
  ratios: Record<QuestionType, number>
  /** 主导类型 */
  dominantType: QuestionType
  /** 总消息数 */
  totalMessages: number
}

/** 情感倾向 */
export type SentimentLabel = 'urgent' | 'frustrated' | 'satisfied' | 'neutral'

/** 情感分析结果 */
export interface SentimentAnalysis {
  /** 各情感标签频次 */
  counts: Record<SentimentLabel, number>
  /** 当前趋势（与上次分析相比） */
  trend: 'worsening' | 'improving' | 'stable'
  /** 负面情感占比（urgent + frustrated） */
  negativeRatio: number
  /** 总分析消息数 */
  totalAnalyzed: number
}

/** 重复模式检测结果 */
export interface RepeatedPatternAnalysis {
  /** 检测到的重复话题标签（按频次降序） */
  repeatedTopics: Array<{ topic: string; count: number }>
  /** 是否检测到显著的重复提问模式 */
  hasSignificantRepeat: boolean
  /** 窗口内交互数 */
  totalInteractions: number
  /** 高度相似的交互对数量 */
  similarPairCount: number
}

/** 完整的使用模式分析报告 */
export interface UsagePatternReport {
  /** 时段模式 */
  timePattern: TimePatternAnalysis
  /** 提问类型分析 */
  questionType: QuestionTypeAnalysis
  /** 情感分析 */
  sentiment: SentimentAnalysis
  /** 重复模式 */
  repeatedPattern: RepeatedPatternAnalysis
  /** 是否拥有足够的数据 */
  hasSufficientData: boolean
  /** 分析时间戳 */
  analyzedAt: number
}

// ══════════════════════════════════════════
// 分析选项
// ══════════════════════════════════════════

export interface AnalyzeOptions {
  /** 分析窗口（最近多少条交互） */
  windowSize?: number
  /** 是否跳过情感分析（节省计算） */
  skipSentiment?: boolean
}

// ══════════════════════════════════════════
// 常量
// ══════════════════════════════════════════

/** 默认分析窗口 */
const DEFAULT_WINDOW = 200

/** 深夜时段定义：23:00 ~ 05:59 */
const LATE_NIGHT_START = 23
const LATE_NIGHT_END = 5

/** 高峰时段 z-score 阈值 */
const PEAK_Z_SCORE_THRESHOLD = 1.0

/** 重复话题检测：最小出现次数 */
const REPEAT_MIN_COUNT = 3

/** 相似交互对判定：相同话题数 >= 此值视为相似 */
const SIMILAR_TOPIC_THRESHOLD = 2

/** 默认 DB 行接口 */
interface InteractionLogRow {
  id: string
  user_text: string
  topics: string
  timestamp: number
}

// ══════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════

/** 安全解析 JSON 数组字段 */
function parseJsonArray(raw: any): string[] {
  if (raw === null || raw === undefined) return []
  if (Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 计算均值 */
function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

/** 计算标准差 */
function stdDev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

// ══════════════════════════════════════════
// 关键词模式表
// ══════════════════════════════════════════

/** 提问类型 → 关键词模式映射 */
const QUESTION_TYPE_PATTERNS: Record<QuestionType, RegExp[]> = {
  debug: [/报错|错误|error|bug|失败|异常|故障|不正确|不对|坏了|崩溃|闪退|不工作/i],
  code_gen: [/实现|写一个|创建|开发|代码|编程|写.*程序|写.*功能|make.*|create.*|implement/i],
  query: [/什么|怎么|能否|哪里|为什么|如何|哪个|搜索|查找|查询|tell me|what is|how to/i],
  chat: [/你好|嗨|早上好|晚安|吃饭|开心|怎么样|哈哈|嗯|好的|谢谢|拜拜|hi|hello|hey/i],
  command: [/执行|运行|调用|打开|关闭|启动|停止|删除|修改|配置|设置|切换|deploy|run|exec/i],
  creative: [/写.*小说|写.*故事|创作|画|图片|图像|设计|风格|灵感|角色|场景|情节/i],
  other: [],
}

/** 情感倾向 → 关键词模式映射 */
const SENTIMENT_PATTERNS: Record<SentimentLabel, RegExp[]> = {
  urgent: [/快点|尽快|马上|立刻|急|抓紧|赶紧|asap|urgent|hurry|quickly|现在.*就|必须.*现在/i],
  frustrated: [/烦|气死|无语|糟糕|又.*错了|总是.*不行|什么鬼|垃圾|差劲|annoying|frustrating|useless|terrible|waste/i],
  satisfied: [/很好|不错|完美|厉害|棒|太好了|赞|满意|感谢|thank|nice|great|excellent|perfect|love|beautiful/i],
  neutral: [],
}

// ══════════════════════════════════════════
// BehaviorUsagePatternAnalyzer
// ══════════════════════════════════════════

export class BehaviorUsagePatternAnalyzer {
  /** 上次分析结果缓存 */
  private lastReport: UsagePatternReport | null = null
  /** 上次分析的情感分布（用于趋势比较） */
  private lastSentimentCounts: Record<SentimentLabel, number> | null = null

  /**
   * 执行一次完整的使用模式分析。
   * 从 DB 加载最近交互记录，提取时段、提问类型、情感、重复模式。
   */
  analyze(options: AnalyzeOptions = {}): UsagePatternReport {
    const windowSize = options.windowSize ?? DEFAULT_WINDOW
    const skipSentiment = options.skipSentiment ?? false

    const interactions = this.loadInteractions(windowSize)

    if (interactions.length < 5) {
      log('INFO', 'usage_pattern_insufficient_data', { count: interactions.length, minRequired: 5 })
      return this.getEmptyReport()
    }

    const texts = interactions.map((r) => r.userText).filter(Boolean)
    const topics = interactions.map((r) => r.topics || [])
    const timestamps = interactions.map((r) => r.timestamp).filter((t) => t > 0)

    // 阶段 1：时段模式分析
    const timePattern = this.analyzeTimePattern(timestamps)

    // 阶段 2：提问类型分类
    const questionType = this.classifyQuestionTypes(texts)

    // 阶段 3：情感倾向分析
    const sentiment = skipSentiment ? this.getDefaultSentiment() : this.analyzeSentiment(texts)

    // 阶段 4：重复模式检测
    const repeatedPattern = this.detectRepeatedPatterns(topics, texts)

    const report: UsagePatternReport = {
      timePattern,
      questionType,
      sentiment,
      repeatedPattern,
      hasSufficientData: true,
      analyzedAt: Date.now(),
    }

    this.lastReport = report
    this.lastSentimentCounts = { ...sentiment.counts }

    log('INFO', 'usage_pattern_analysis_complete', {
      interactions: interactions.length,
      peakHours: timePattern.peakHours.length,
      lateNightRatio: (timePattern.lateNightRatio * 100).toFixed(0) + '%',
      dominantQuestionType: questionType.dominantType,
      negativeSentimentRatio: (sentiment.negativeRatio * 100).toFixed(0) + '%',
      hasRepeat: repeatedPattern.hasSignificantRepeat,
    })

    return report
  }

  /** 获取上次分析结果 */
  getLastReport(): UsagePatternReport | null {
    return this.lastReport
  }

  // ══════════════════════════════════════════
  //  1. 时段模式分析
  // ══════════════════════════════════════════

  /**
   * 从时间戳列表分析时段模式。
   * - 按小时分桶统计交互频次
   * - 用 z-score 识别高峰时段
   * - 检测深夜活跃比例
   */
  private analyzeTimePattern(timestamps: number[]): TimePatternAnalysis {
    // 按小时分桶
    const hourlyCounts = new Array(24).fill(0)
    for (const ts of timestamps) {
      const hour = new Date(ts).getHours()
      hourlyCounts[hour]++
    }

    // 简化版本：用均值 + 标准差找高峰
    const m = mean(hourlyCounts)
    const sd = stdDev(hourlyCounts)
    const threshold = m + (sd > 0 ? sd * PEAK_Z_SCORE_THRESHOLD : 1)

    const peakHours: number[] = []
    for (let h = 0; h < 24; h++) {
      if (hourlyCounts[h] >= threshold) {
        peakHours.push(h)
      }
    }

    // 深夜交互数统计
    let lateNightCount = 0
    for (const ts of timestamps) {
      const hour = new Date(ts).getHours()
      if (hour >= LATE_NIGHT_START || hour <= LATE_NIGHT_END) {
        lateNightCount++
      }
    }

    const now = new Date().getHours()
    const isCurrentlyLateNight = now >= LATE_NIGHT_START || now <= LATE_NIGHT_END

    return {
      hourlyCounts,
      peakHours,
      isCurrentlyLateNight,
      lateNightRatio: timestamps.length > 0 ? lateNightCount / timestamps.length : 0,
      totalInteractions: timestamps.length,
    }
  }

  // ══════════════════════════════════════════
  //  2. 提问类型分类
  // ══════════════════════════════════════════

  /**
   * 按关键词模式对每条消息分类。
   * 一条消息可能存在多种类型特征，取匹配数最多的类型。
   * 无匹配时归为 'other'。
   */
  private classifyQuestionTypes(texts: string[]): QuestionTypeAnalysis {
    const counts: Record<QuestionType, number> = {
      debug: 0,
      code_gen: 0,
      query: 0,
      chat: 0,
      command: 0,
      creative: 0,
      other: 0,
    }

    for (const text of texts) {
      const matchCounts: Record<string, number> = {}
      for (const [type, patterns] of Object.entries(QUESTION_TYPE_PATTERNS)) {
        matchCounts[type] = 0
        for (const pattern of patterns) {
          const matches = text.match(pattern)
          if (matches) matchCounts[type] += matches.length
        }
      }

      // 找匹配数最多的类型（排除 other）
      let bestType: QuestionType = 'other'
      let bestCount = 0
      for (const [type, count] of Object.entries(matchCounts)) {
        if (type !== 'other' && count > bestCount) {
          bestCount = count
          bestType = type as QuestionType
        }
      }

      counts[bestType]++
    }

    const total = texts.length || 1
    const ratios: Record<QuestionType, number> = {} as Record<QuestionType, number>
    let dominantType: QuestionType = 'other'
    let maxCount = 0
    for (const [type, count] of Object.entries(counts)) {
      ratios[type as QuestionType] = Math.round((count / total) * 100) / 100
      if (count > maxCount) {
        maxCount = count
        dominantType = type as QuestionType
      }
    }

    return {
      counts,
      ratios,
      dominantType,
      totalMessages: texts.length,
    }
  }

  // ══════════════════════════════════════════
  //  3. 情感倾向分析
  // ══════════════════════════════════════════

  /**
   * 分析每条消息中的情感倾向标记。
   * 基于关键词模式匹配。
   */
  private analyzeSentiment(texts: string[]): SentimentAnalysis {
    const counts: Record<SentimentLabel, number> = {
      urgent: 0,
      frustrated: 0,
      satisfied: 0,
      neutral: 0,
    }

    for (const text of texts) {
      let matched = false
      for (const [label, patterns] of Object.entries(SENTIMENT_PATTERNS)) {
        for (const pattern of patterns) {
          if (pattern.test(text)) {
            counts[label as SentimentLabel]++
            matched = true
            break
          }
        }
        if (matched) break
      }
      if (!matched) {
        counts.neutral++
      }
    }

    const total = texts.length || 1
    const totalNegative = counts.urgent + counts.frustrated

    // 与前次分析比较趋势
    let trend: SentimentAnalysis['trend'] = 'stable'
    if (this.lastSentimentCounts) {
      const prevNegative = this.lastSentimentCounts.urgent + this.lastSentimentCounts.frustrated
      const currNegative = counts.urgent + counts.frustrated
      const diff = currNegative - prevNegative
      if (diff > 2) trend = 'worsening'
      else if (diff < -2) trend = 'improving'
    }

    return {
      counts,
      trend,
      negativeRatio: Math.round((totalNegative / total) * 100) / 100,
      totalAnalyzed: texts.length,
    }
  }

  private getDefaultSentiment(): SentimentAnalysis {
    return {
      counts: { urgent: 0, frustrated: 0, satisfied: 0, neutral: 0 },
      trend: 'stable',
      negativeRatio: 0,
      totalAnalyzed: 0,
    }
  }

  // ══════════════════════════════════════════
  //  4. 重复模式检测
  // ══════════════════════════════════════════

  /**
   * 检测交互中的重复模式。
   * - 看话题标签的重复出现频率
   * - 看连续交互中的高度相似对
   */
  private detectRepeatedPatterns(topicsList: string[][], texts: string[]): RepeatedPatternAnalysis {
    // 话题频次统计
    const topicCounts = new Map<string, number>()
    for (const topics of topicsList) {
      for (const t of [...new Set(topics)]) {
        topicCounts.set(t, (topicCounts.get(t) || 0) + 1)
      }
    }

    const repeatedTopics = [...topicCounts.entries()]
      .filter(([, count]) => count >= REPEAT_MIN_COUNT)
      .sort((a, b) => b[1] - a[1])
      .map(([topic, count]) => ({ topic, count }))

    // 检测相邻交互的相似度（简单的关键词交集）
    let similarPairCount = 0
    for (let i = 0; i < texts.length - 1; i++) {
      const current = texts[i]
      const next = texts[i + 1]
      if (!current || !next) continue

      // 提取关键词：取长度 >= 2 的中文词
      const currentWords = new Set((current.match(/[一-鿿]{2,}/g) || []).slice(0, 10))
      const nextWords = new Set((next.match(/[一-鿿]{2,}/g) || []).slice(0, 10))

      // 计算交集大小
      let overlap = 0
      for (const w of currentWords) {
        if (nextWords.has(w)) overlap++
      }

      if (overlap >= SIMILAR_TOPIC_THRESHOLD) {
        similarPairCount++
      }
    }

    return {
      repeatedTopics,
      hasSignificantRepeat: repeatedTopics.length >= 2 && repeatedTopics[0].count >= REPEAT_MIN_COUNT,
      totalInteractions: texts.length,
      similarPairCount,
    }
  }

  // ══════════════════════════════════════════
  //  数据加载
  // ══════════════════════════════════════════

  /**
   * 从 DB 加载最近 N 条交互记录。
   * 来源：interaction_log 表 + UserBehaviorAnalyzer 运行时数据。
   */
  private loadInteractions(limit: number): Array<{ userText: string; topics: string[]; timestamp: number }> {
    const records: Array<{ userText: string; topics: string[]; timestamp: number }> = []

    try {
      const db = getRawDb()
      const result = db.exec(`SELECT id, user_text, topics, timestamp FROM interaction_log ORDER BY timestamp DESC LIMIT ${limit}`)

      if (result && result.length > 0) {
        const columns = result[0].columns
        for (const row of result[0].values) {
          const obj: any = {}
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i]
          const r = obj as InteractionLogRow
          records.push({
            userText: r.user_text || '',
            topics: parseJsonArray(r.topics),
            timestamp: r.timestamp || 0,
          })
        }
      }
    } catch (err) {
      log('WARN', 'usage_pattern_load_failed', { error: String(err) })
    }

    // 按时间升序排列
    records.sort((a, b) => a.timestamp - b.timestamp)
    return records.slice(-limit)
  }

  /** 空报告模板 */
  private getEmptyReport(): UsagePatternReport {
    return {
      timePattern: {
        hourlyCounts: new Array(24).fill(0),
        peakHours: [],
        isCurrentlyLateNight: new Date().getHours() >= LATE_NIGHT_START || new Date().getHours() <= LATE_NIGHT_END,
        lateNightRatio: 0,
        totalInteractions: 0,
      },
      questionType: {
        counts: { debug: 0, code_gen: 0, query: 0, chat: 0, command: 0, creative: 0, other: 0 },
        ratios: { debug: 0, code_gen: 0, query: 0, chat: 0, command: 0, creative: 0, other: 0 },
        dominantType: 'other',
        totalMessages: 0,
      },
      sentiment: this.getDefaultSentiment(),
      repeatedPattern: {
        repeatedTopics: [],
        hasSignificantRepeat: false,
        totalInteractions: 0,
        similarPairCount: 0,
      },
      hasSufficientData: false,
      analyzedAt: Date.now(),
    }
  }
}

// ══════════════════════════════════════════
// 全局单例
// ══════════════════════════════════════════

export const behaviorUsagePatternAnalyzer = new BehaviorUsagePatternAnalyzer()
