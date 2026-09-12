/**
 * BehaviorPatternMiner — 用户行为关联规则挖掘器
 *
 * ## 职责
 * 每 2 小时分析最近 N 次交互记录，挖掘用户行为中的关联规则：
 * - 文本序列模式："用户说 X → 随后说 Y" 的条件概率
 * - 话题序列模式："用户聊话题 A → 随后聊话题 B" 的条件概率
 *
 * ## 算法
 * 对每对连续交互 (A, B) 提取关键词/话题作为 antecedents 和 consequents，
 * 计算条件概率 P(consequent | antecedent) = count(A→B) / count(A)。
 *
 * ## 集成点
 * - 读取 InteractionTracker 的运行时数据（最近 30 次交互）
 * - 写入 BehaviorPatternStore
 * - 定时器每 2 小时触发一次
 *
 * ## 隐私设计
 * - 仅分析交互中的关键词和话题标签，不保留原始消息
 * - 规则以概括性标签存储
 * - 不将任何数据发送至外部
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { InteractionRecord } from '@akemi-mio/intelligence-memory/types'
import { BehaviorPatternStore, type PatternSource, behaviorPatternStore as _behaviorPatternStore } from './BehaviorPatternStore'
import { BEHAVIOR_PATTERN_ANALYZER_INTERVAL, BEHAVIOR_PATTERN_MIN_INTERACTIONS, BEHAVIOR_PATTERN_WINDOW_SIZE } from '@akemi-mio/core/config'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 分析窗口大小：取最近 N 次交互进行分析 */
const DEFAULT_WINDOW_SIZE = 30

/** 最小交互数要求：低于此值不执行分析 */
const DEFAULT_MIN_INTERACTIONS = 6

/** 分析定时器间隔（毫秒），默认 2 小时 */
const DEFAULT_ANALYZER_INTERVAL_MS = 2 * 60 * 60 * 1000

/** 话题标签模式的最小转移次数 */
const MIN_TOPIC_TRANSITION_COUNT = 2

// ══════════════════════════════════════════
//  中文常用话题关键词映射表
// ══════════════════════════════════════════

/** 话题 → 关键词列表映射（用于从用户文本提取可匹配的话题标签） */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  天气: ['天气', '温度', '下雨', '下雪', '刮风', '晴', '阴', '台风', '气温', '预报'],
  时间: ['时间', '几点', '现在', '日期', '今天', '明天', '昨天', '星期', '月份', '钟'],
  新闻: ['新闻', '时事', '报道', '最新', '热点', '头条', '消息'],
  编程: ['代码', '编程', '写代码', 'bug', '调试', '重构', '算法', '编译', '部署', '程序'],
  写作: ['写', '文章', '内容', '创作', '文案', '文本', '文档', '编辑'],
  学习: ['学习', '教程', '教学', '课程', '练习', '理解', '概念'],
  翻译: ['翻译', '英文', '中文', '语言', '外语', '意思'],
  图片: ['图片', '图像', '照片', '画画', '生成图', '画图', '设计图'],
  音乐: ['音乐', '歌', '播放', '曲', '旋律', '歌词'],
  视频: ['视频', '播放', '看', '电影', '剧', '短视频'],
  搜索: ['搜索', '查找', '找', '查询', '搜一下'],
  设置: ['设置', '配置', '修改', '调整', '更改', '选项'],
  帮助: ['帮助', '怎么', '如何', '能不能', '可以吗', '怎样'],
  推荐: ['推荐', '建议', '什么好', '选择', '推'],
}

/** 从文本中提取话题关键词 */
function extractKeywords(text: string): string[] {
  if (!text) return []
  const keywords: string[] = []
  const lower = text.toLowerCase()

  for (const [topic, words] of Object.entries(TOPIC_KEYWORDS)) {
    for (const word of words) {
      if (lower.includes(word)) {
        keywords.push(topic)
        break // 一 topic 只匹配一次
      }
    }
  }

  // 限制关键词数量
  return [...new Set(keywords)].slice(0, 3)
}

// ══════════════════════════════════════════
//  BehaviorPatternMiner
// ══════════════════════════════════════════

export class BehaviorPatternMiner {
  private store: BehaviorPatternStore
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private lastAnalyzedAt: number = 0
  private lastRuleCount: number = 0

  /** 分析窗口大小 */
  private windowSize: number
  /** 最小交互数 */
  private minInteractions: number

  constructor(
    store: BehaviorPatternStore,
    config?: {
      windowSize?: number
      minInteractions?: number
    },
  ) {
    this.store = store
    this.windowSize = config?.windowSize ?? BEHAVIOR_PATTERN_WINDOW_SIZE ?? DEFAULT_WINDOW_SIZE
    this.minInteractions = config?.minInteractions ?? BEHAVIOR_PATTERN_MIN_INTERACTIONS ?? DEFAULT_MIN_INTERACTIONS
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /**
   * 启动定时分析器。
   * 首次执行延迟 60 秒（等系统稳定），后续按 intervalMs 定时运行。
   */
  start(intervalMs: number = BEHAVIOR_PATTERN_ANALYZER_INTERVAL ?? DEFAULT_ANALYZER_INTERVAL_MS): void {
    if (this.timer) return

    log('INFO', 'behavior_pattern_miner_started', {
      intervalMs,
      intervalMinutes: Math.round(intervalMs / 60_000),
      windowSize: this.windowSize,
    })

    // 首次延迟 60 秒
    setTimeout(() => {
      this.runAnalysis().catch((err) => log('WARN', 'behavior_pattern_miner_first_run_failed', { error: String(err) }))
    }, 60_000)

    this.timer = setInterval(() => {
      this.runAnalysis().catch((err) => log('WARN', 'behavior_pattern_miner_cycle_failed', { error: String(err) }))
    }, intervalMs)
  }

  /** 停止定时分析器 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    log('INFO', 'behavior_pattern_miner_stopped')
  }

  // ══════════════════════════════════════════
  //  主分析入口
  // ══════════════════════════════════════════

  /**
   * 执行一次完整的行为模式挖掘。
   * 1. 分析交互序列中的文本序列模式
   * 2. 分析话题转移模式
   * 3. 生成关联规则并存储到 BehaviorPatternStore
   *
   * @param interactions 外部传入的交互记录（可选，不传入时仅基于已有记录）
   * @returns 本次挖掘生成的有效规则数
   */
  async runAnalysis(interactions?: InteractionRecord[]): Promise<number> {
    if (this.running) return 0
    this.running = true

    const startMs = Date.now()
    let rulesCreated = 0

    try {
      if (!interactions || interactions.length < this.minInteractions) {
        log('INFO', 'behavior_pattern_miner_skip', {
          count: interactions?.length ?? 0,
          minRequired: this.minInteractions,
        })
        return 0
      }

      // 取最近 windowSize 条交互
      const window = interactions.slice(-this.windowSize)
      if (window.length < this.minInteractions) return 0

      // 1. 文本序列模式挖掘
      const textPatterns = this.mineTextSequencePatterns(window)
      for (const pattern of textPatterns) {
        this.store.upsertRule(pattern)
        rulesCreated++
      }

      // 2. 话题序列模式挖掘
      const topicPatterns = this.mineTopicSequencePatterns(window)
      for (const pattern of topicPatterns) {
        this.store.upsertRule(pattern)
        rulesCreated++
      }

      this.lastAnalyzedAt = Date.now()
      this.lastRuleCount = this.store.getAll().length

      log('INFO', 'behavior_pattern_miner_complete', {
        interactions: window.length,
        textPatterns: textPatterns.length,
        topicPatterns: topicPatterns.length,
        rulesCreated,
        totalRules: this.lastRuleCount,
        durationMs: Date.now() - startMs,
      })
    } catch (err: any) {
      log('ERROR', 'behavior_pattern_miner_error', { error: String(err).slice(0, 500) })
    } finally {
      this.running = false
    }

    return rulesCreated
  }

  // ══════════════════════════════════════════
  //  1. 文本序列模式挖掘
  // ══════════════════════════════════════════

  /**
   * 从连续交互中挖掘文本层面的关联规则。
   * 对每对连续交互 (A, B)：
   * - 从 A 的文本提取关键词作为 antecedent
   * - 从 B 的文本提取关键词作为 consequent
   * - 计算 P(consequent | antecedent)
   */
  private mineTextSequencePatterns(interactions: InteractionRecord[]): Array<{
    antecedent: string
    consequent: string
    probability: number
    source: PatternSource
  }> {
    if (interactions.length < 2) return []

    // 统计：antecedent → count 和 antecedent&consequent → count
    const antecedentCounts = new Map<string, number>()
    const pairCounts = new Map<string, Map<string, number>>()

    for (let i = 0; i < interactions.length - 1; i++) {
      const current = interactions[i]
      const next = interactions[i + 1]

      const currentKeywords = extractKeywords(current.userText)
      const nextKeywords = extractKeywords(next.userText)

      if (currentKeywords.length === 0 || nextKeywords.length === 0) continue

      // 对每对关键词组合建立关联
      for (const antecedent of currentKeywords) {
        antecedentCounts.set(antecedent, (antecedentCounts.get(antecedent) || 0) + 1)

        for (const consequent of nextKeywords) {
          if (antecedent === consequent) continue // 跳过自环

          if (!pairCounts.has(antecedent)) {
            pairCounts.set(antecedent, new Map())
          }
          const pairMap = pairCounts.get(antecedent)!
          pairMap.set(consequent, (pairMap.get(consequent) || 0) + 1)
        }
      }
    }

    // 计算条件概率并生成规则
    const patterns: Array<{
      antecedent: string
      consequent: string
      probability: number
      source: PatternSource
    }> = []

    for (const [antecedent, pairMap] of pairCounts) {
      const antecedentTotal = antecedentCounts.get(antecedent) || 0
      if (antecedentTotal < 2) continue // 至少出现 2 次才构成模式

      for (const [consequent, pairCount] of pairMap) {
        if (pairCount < 2) continue // 至少 2 次才有效

        const probability = pairCount / antecedentTotal

        // 至少需要 30% 概率才认为有预测价值
        if (probability >= 0.3) {
          patterns.push({
            antecedent,
            consequent,
            probability: Math.round(probability * 100) / 100,
            source: 'text_sequence',
          })
        }
      }
    }

    // 按概率降序
    patterns.sort((a, b) => b.probability - a.probability)

    // 去重：相同的 antecedent→consequent 只保留最高概率的
    const seen = new Set<string>()
    const deduped: typeof patterns = []
    for (const p of patterns) {
      const key = `${p.antecedent}→${p.consequent}`
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(p)
      }
    }

    return deduped
  }

  // ══════════════════════════════════════════
  //  2. 话题序列模式挖掘
  // ══════════════════════════════════════════

  /**
   * 从交互的话题标签序列中挖掘话题转移规则。
   * 类似 TopicTransitionPredictor 但输出为 explicit 规则。
   */
  private mineTopicSequencePatterns(interactions: InteractionRecord[]): Array<{
    antecedent: string
    consequent: string
    probability: number
    source: PatternSource
  }> {
    if (interactions.length < 2) return []

    // 构建紧凑的话题序列（去重连续相同话题）
    const topicSeq: Array<{ topic: string; ts: number }> = []
    for (const rec of interactions) {
      if (!rec.topics || rec.topics.length === 0) continue
      for (const topic of [...new Set(rec.topics)]) {
        const last = topicSeq[topicSeq.length - 1]
        if (last && last.topic === topic) continue // 连续相同跳过
        topicSeq.push({ topic, ts: rec.timestamp })
      }
    }

    if (topicSeq.length < 2) return []

    // 统计：antecedent → count 和 pair → count
    const antecedentCounts = new Map<string, number>()
    const pairCounts = new Map<string, Map<string, number>>()

    for (let i = 0; i < topicSeq.length - 1; i++) {
      const from = topicSeq[i].topic
      const to = topicSeq[i + 1].topic

      if (from === to) continue

      antecedentCounts.set(from, (antecedentCounts.get(from) || 0) + 1)

      if (!pairCounts.has(from)) {
        pairCounts.set(from, new Map())
      }
      const pairMap = pairCounts.get(from)!
      pairMap.set(to, (pairMap.get(to) || 0) + 1)
    }

    const patterns: Array<{
      antecedent: string
      consequent: string
      probability: number
      source: PatternSource
    }> = []

    for (const [antecedent, pairMap] of pairCounts) {
      const antecedentTotal = antecedentCounts.get(antecedent) || 0
      if (antecedentTotal < MIN_TOPIC_TRANSITION_COUNT) continue

      for (const [consequent, pairCount] of pairMap) {
        if (pairCount < MIN_TOPIC_TRANSITION_COUNT) continue

        const probability = pairCount / antecedentTotal
        if (probability >= 0.25) {
          patterns.push({
            antecedent,
            consequent,
            probability: Math.round(probability * 100) / 100,
            source: 'topic_sequence',
          })
        }
      }
    }

    patterns.sort((a, b) => b.probability - a.probability)

    // 去重
    const seen = new Set<string>()
    const deduped: typeof patterns = []
    for (const p of patterns) {
      const key = `${p.antecedent}→${p.consequent}`
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(p)
      }
    }

    return deduped
  }

  // ══════════════════════════════════════════
  //  状态查询
  // ══════════════════════════════════════════

  /** 获取上次分析时间 */
  getLastAnalyzedAt(): number {
    return this.lastAnalyzedAt
  }

  /** 获取当前规则总数 */
  getRuleCount(): number {
    return this.store.getAll().length
  }

  /** 手动触发一次分析 */
  async analyzeNow(interactions: InteractionRecord[]): Promise<number> {
    return this.runAnalysis(interactions)
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const behaviorPatternMiner = new BehaviorPatternMiner(_behaviorPatternStore)
