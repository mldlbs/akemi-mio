/**
 * BehaviorPredictiveMemoryPrewarmer — 行为预测式记忆预热
 *
 * ## 职责
 * 1. 在 Agent 会话启动时，分析最近交互的时间间隔和话题转移概率
 * 2. 结合用户历史偏好话题和情绪模式，预测当前会话最可能需要的记忆
 * 3. 从 MemoryService 预取 Top-3 记忆片段，注入会话初始状态
 * 4. 减少用户重复描述历史背景，提升对话连贯性和响应速度
 *
 * ## 算法
 * - 交互间隔分析：计算最近 N 次交互的时间间隔模式，检测中断/续接场景
 * - 话题转移概率：复用 TopicTransitionPredictor 的马尔可夫链模型
 * - 综合评分：结合 话题置信度 × 近因权重 × 转移概率 × 行为得分 得到最终排序
 * - Top-3 输出：取综合评分最高的 3 条记忆片段
 *
 * ## 与现有系统的关系
 * - InteractionTracker — 提供最近交互记录和话题标签
 * - TopicTransitionPredictor — 提供话题转移概率预测
 * - MemoryService — 提供记忆条目的行为加权查询
 * - BehaviorPreloaderService — 工具级预热（互补，不重叠）
 * - BehaviorPeriodicPreloadService — 时段级预热（互补，不重叠）
 *
 * ## 资源保护
 * - 仅在会话启动时执行一次
 * - 数据不足时静默跳过（少于 2 次交互或少于 3 条记忆）
 * - 预取结果带 TTL 缓存，避免重复计算
 * - 低置信度预测不注入
 *
 * @module behavior
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { type MemoryEntry } from '@akemi-mio/intelligence-memory/types'
import type { InteractionRecord } from '@akemi-mio/intelligence-memory/types'
import type { TopicPrediction } from '@akemi-mio/intelligence-memory/TopicTransitionPredictor'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 分析窗口：最近 N 次交互用于间隔分析 */
const INTERACTION_WINDOW = 4

/** 最少交互次数要求（至少 2 次才能计算间隔） */
const MIN_INTERACTIONS_REQUIRED = 2

/** 最少记忆条目要求（低于此值不执行预热） */
const MIN_MEMORIES_REQUIRED = 3

/** 每次预热返回的记忆数 */
const PREWARM_TOP_K = 3

/** 新对话注入的置信度阈值 */
const INJECTION_CONFIDENCE_THRESHOLD = 0.3

/** 间隔异常阈值：超过此值（毫秒）视为中断/新会话 */
const GAP_THRESHOLD_MS = 30 * 60 * 1000 // 30 分钟

/** 近因权重衰减半衰期（小时）：超过此时间长度的话题权重减半 */
const RECENCY_HALF_LIFE_HOURS = 4

/** 中断续接话题的基础 boost */
const RESUMED_TOPIC_BOOST = 0.25

/** Top-N 转移预测取多少条用于评分 */
const TRANSITION_TOP_N = 3

/** 预取结果缓存 TTL（毫秒） */
const PREWARM_CACHE_TTL_MS = 5 * 60 * 1000 // 5 分钟

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 交互间隔分析结果 */
export interface InteractionIntervalResult {
  /** 最近 N 次交互的时间戳列表 */
  timestamps: number[]
  /** 交互间隔（毫秒），按时间顺序排列 */
  intervals: number[]
  /** 平均间隔（毫秒） */
  averageIntervalMs: number
  /** 距离上次交互的时间（毫秒） */
  timeSinceLastInteraction: number
  /** 是否检测到中断（间隔 > GAP_THRESHOLD_MS） */
  hasGap: boolean
  /** 是否为长时间中断后恢复（间隔 > 2h） */
  isLongBreak: boolean
  /** 最近一次交互的话题标签 */
  lastTopics: string[]
}

/** 话题评分明细 */
export interface TopicScoreDetail {
  /** 话题标签 */
  topic: string
  /** 综合评分 (0-1) */
  combinedScore: number
  /** 话题基础置信度 */
  baseConfidence: number
  /** 近因权重 (0-1) */
  recencyWeight: number
  /** 转移概率 (如果有) */
  transitionProbability: number
  /** 是否来自转移预测 */
  fromTransition: boolean
  /** 行为加权得分 */
  behaviorScore: number
}

/** 单条预热记忆结果 */
export interface PrewarmedMemory {
  /** 记忆条目 */
  entry: MemoryEntry
  /** 综合相关性评分 (0-1) */
  relevanceScore: number
  /** 匹配的话题 */
  matchedTopic: string
  /** 评分明细 */
  scoreDetail: TopicScoreDetail
}

/** 预热完整结果 */
export interface PrewarmResult {
  /** Top-3 预热记忆 */
  memories: PrewarmedMemory[]
  /** 是否成功（数据充足） */
  success: boolean
  /** 交互间隔分析 */
  intervalAnalysis: InteractionIntervalResult
  /** 话题评分详情（所有评估过的话题） */
  topicDetails: TopicScoreDetail[]
  /** 推断的会话场景 */
  inferredScene: 'continue' | 'new' | 'resume_after_gap'
  /** 场景描述文本 */
  sceneDescription: string
  /** 是否使用缓存 */
  fromCache: boolean
  /** 计算耗时（毫秒） */
  durationMs: number
}

/** 外部依赖接口，便于测试 */
export interface PrewarmerDependencies {
  /** 获取最近交互记录 */
  getRecentInteractions: (limit: number) => InteractionRecord[]
  /** 获取所有交互记录 */
  getAllInteractions: () => InteractionRecord[]
  /** 基于当前话题预测下一话题 */
  predictNextTopics: (currentTopics: string[], topK: number) => TopicPrediction[]
  /** 按行为加权得分查询记忆 */
  getBehaviorWeightedEntries: (tier?: MemoryEntry['tier'], limit?: number) => MemoryEntry[]
  /** 获取所有 user_fact 类型条目 */
  getEntries: () => MemoryEntry[]
  /** 获取话题转移统计摘要 */
  getTopicTransitionStats?: () => {
    totalTransitions: number
    uniqueFromTopics: number
    uniqueToTopics: number
    cacheSize: number
  }
}

// ══════════════════════════════════════════
//  BehaviorPredictiveMemoryPrewarmer
// ══════════════════════════════════════════

export class BehaviorPredictiveMemoryPrewarmer {
  /** 外部依赖 */
  private deps: PrewarmerDependencies | null = null

  /** 缓存的上次预热结果 */
  private cachedResult: PrewarmResult | null = null
  /** 缓存时间戳 */
  private cachedAt = 0

  // ══════════════════════════════════════════
  //  依赖注入
  // ══════════════════════════════════════════

  /**
   * 注入外部依赖。
   * 通常在 AppRuntime 启动期间由初始化代码调用。
   */
  setDependencies(deps: PrewarmerDependencies): void {
    this.deps = deps
    log('INFO', 'predictive_prewarmer_deps_set')
  }

  /** 获取当前依赖引用（用于检查是否已注入） */
  getDependencies(): PrewarmerDependencies | null {
    return this.deps
  }

  // ══════════════════════════════════════════
  //  核心 API
  // ══════════════════════════════════════════

  /**
   * 执行行为预测式记忆预热。
   * 在 Agent 会话启动时调用，分析交互模式和话题转移概率，
   * 返回 Top-3 最可能需要的记忆片段。
   *
   * @param forceRefresh 是否强制刷新缓存
   * @returns 预热结果（数据不足时 success=false）
   */
  prewarmForSession(forceRefresh = false): PrewarmResult {
    const startTime = Date.now()

    // 缓存检查（5 分钟内有效）
    if (!forceRefresh && this.cachedResult && Date.now() - this.cachedAt < PREWARM_CACHE_TTL_MS) {
      log('DEBUG', 'predictive_prewarmer_cache_hit')
      return { ...this.cachedResult, fromCache: true }
    }

    // 依赖检查
    if (!this.deps) {
      log('WARN', 'predictive_prewarmer_no_deps')
      return this.emptyResult('依赖未注入', startTime)
    }

    const { getRecentInteractions, getAllInteractions, predictNextTopics, getBehaviorWeightedEntries, getEntries } = this.deps

    // ── 1. 交互间隔分析 ──
    const recentInteractions = getRecentInteractions(INTERACTION_WINDOW)
    const allInteractions = getAllInteractions()

    if (recentInteractions.length < MIN_INTERACTIONS_REQUIRED) {
      log('INFO', 'predictive_prewarmer_insufficient_interactions', {
        count: recentInteractions.length,
        minRequired: MIN_INTERACTIONS_REQUIRED,
      })
      return this.emptyResult('交互数据不足', startTime)
    }

    const intervalAnalysis = this.analyzeIntervals(recentInteractions)

    // ── 2. 话题评分 ──
    // 从交互记录和话题转移预测两个来源收集话题及评分
    const topicScores = this.computeTopicScores(recentInteractions, allInteractions, intervalAnalysis, predictNextTopics)

    if (topicScores.length === 0) {
      log('INFO', 'predictive_prewarmer_no_topics')
      return this.emptyResult('无可评估的话题', startTime)
    }

    // ── 3. 匹配记忆条目 ──
    const allMemories = getEntries().filter((e) => e.type === 'user_fact')
    if (allMemories.length < MIN_MEMORIES_REQUIRED) {
      log('INFO', 'predictive_prewarmer_insufficient_memories', {
        count: allMemories.length,
        minRequired: MIN_MEMORIES_REQUIRED,
      })
      return this.emptyResult('记忆数据不足', startTime)
    }

    // 取行为加权 Top-N 记忆作为候选池
    const candidateMemories = getBehaviorWeightedEntries(undefined, 20)

    // 对每条候选记忆按话题匹配度评分
    const scoredMemories: PrewarmedMemory[] = []

    for (const entry of candidateMemories) {
      const entryTopics = entry.topics || []
      if (entryTopics.length === 0) continue

      // 找最匹配的话题
      let bestScore = 0
      let bestTopic = ''
      let bestDetail: TopicScoreDetail | null = null

      for (const topic of entryTopics) {
        const detail = topicScores.find((t) => t.topic === topic)
        if (!detail) continue

        if (detail.combinedScore > bestScore) {
          bestScore = detail.combinedScore
          bestTopic = topic
          bestDetail = detail
        }
      }

      if (bestDetail && bestScore >= INJECTION_CONFIDENCE_THRESHOLD) {
        scoredMemories.push({
          entry,
          relevanceScore: bestScore,
          matchedTopic: bestTopic,
          scoreDetail: bestDetail,
        })
      }
    }

    // 按综合评分降序排列，取 Top-3
    scoredMemories.sort((a, b) => b.relevanceScore - a.relevanceScore)
    const topMemories = scoredMemories.slice(0, PREWARM_TOP_K)

    // ── 4. 场景推断 ──
    const inferredScene = this.inferScene(intervalAnalysis, topMemories)

    const result: PrewarmResult = {
      memories: topMemories,
      success: topMemories.length > 0,
      intervalAnalysis,
      topicDetails: topicScores,
      inferredScene,
      sceneDescription: this.getSceneDescription(inferredScene, intervalAnalysis),
      fromCache: false,
      durationMs: Date.now() - startTime,
    }

    // 缓存结果
    this.cachedResult = result
    this.cachedAt = Date.now()

    log('INFO', 'predictive_prewarmer_complete', {
      memories: topMemories.length,
      scene: inferredScene,
      topics: topicScores.length,
      hasGap: intervalAnalysis.hasGap,
      durationMs: result.durationMs,
    })

    return result
  }

  /**
   * 获取预热结果作为上下文文本（用于注入 system prompt）。
   * 如果预热成功且存在高置信度记忆，返回格式化文本；
   * 否则返回空字符串。
   */
  getPrewarmContext(forceRefresh = false): string {
    const result = this.prewarmForSession(forceRefresh)

    if (!result.success || result.memories.length === 0) return ''

    const lines: string[] = []
    lines.push('---')
    lines.push('【行为预测式记忆预热】')
    lines.push('根据你的历史对话模式和当前场景，以下记忆可能与此对话相关：')

    for (let i = 0; i < result.memories.length; i++) {
      const pm = result.memories[i]
      lines.push(`${i + 1}. ${pm.entry.content}`)
    }

    // 场景提示
    if (result.inferredScene === 'resume_after_gap') {
      lines.push('')
      lines.push('（检测到较长时间间隔，似乎是从之前的对话中断处继续）')
    } else if (result.inferredScene === 'continue') {
      lines.push('')
      lines.push('（检测到连续交互模式，正在延续之前的对话脉络）')
    }

    lines.push('---')
    return lines.join('\n')
  }

  /**
   * 清除缓存（用于测试或会话重置）。
   */
  clearCache(): void {
    this.cachedResult = null
    this.cachedAt = 0
    log('DEBUG', 'predictive_prewarmer_cache_cleared')
  }

  // ══════════════════════════════════════════
  //  交互间隔分析
  // ══════════════════════════════════════════

  /**
   * 分析最近 N 次交互的时间间隔模式。
   */
  private analyzeIntervals(interactions: InteractionRecord[]): InteractionIntervalResult {
    const timestamps = interactions
      .map((r) => r.timestamp)
      .filter((t) => t > 0)
      .sort((a, b) => a - b)

    const intervals: number[] = []
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1])
    }

    const averageIntervalMs = intervals.length > 0 ? intervals.reduce((s, v) => s + v, 0) / intervals.length : 0

    const now = Date.now()
    const lastTimestamp = timestamps.length > 0 ? timestamps[timestamps.length - 1] : now
    const timeSinceLastInteraction = now - lastTimestamp

    const hasGap = intervals.some((i) => i > GAP_THRESHOLD_MS) || timeSinceLastInteraction > GAP_THRESHOLD_MS
    const isLongBreak = timeSinceLastInteraction > 2 * 60 * 60 * 1000 // > 2h

    // 获取最近一次交互的话题
    const lastInteraction = interactions[interactions.length - 1]
    const lastTopics = lastInteraction?.topics || []

    return {
      timestamps,
      intervals,
      averageIntervalMs,
      timeSinceLastInteraction,
      hasGap,
      isLongBreak,
      lastTopics,
    }
  }

  // ══════════════════════════════════════════
  //  话题综合评分
  // ══════════════════════════════════════════

  /**
   * 从交互记录和话题转移预测两个来源，计算每个话题的综合评分。
   *
   * 评分公式：
   *   combinedScore = baseConfidence × recencyWeight + transitionProbabilityBoost + resumedBoost
   *
   * 其中：
   *   - baseConfidence: 话题在最近交互中的出现频率占比
   *   - recencyWeight: 近因权重，随时间衰减（半衰期 RECENCY_HALF_LIFE_HOURS）
   *   - transitionProbabilityBoost: 转移概率 × 0.3（来自 TopicTransitionPredictor）
   *   - resumedBoost: 中断续接场景下，最后话题获得额外 boost
   */
  private computeTopicScores(
    recentInteractions: InteractionRecord[],
    allInteractions: InteractionRecord[],
    intervalAnalysis: InteractionIntervalResult,
    predictNextTopics: (topics: string[], topK: number) => TopicPrediction[],
  ): TopicScoreDetail[] {
    const topicMap = new Map<
      string,
      {
        count: number
        lastSeen: number
        fromTransition: boolean
        transitionProb: number
      }
    >()

    // ── 来源 A：最近交互中的话题频率 ──
    for (const rec of recentInteractions) {
      if (!rec.topics || rec.topics.length === 0) continue
      for (const topic of [...new Set(rec.topics)]) {
        const existing = topicMap.get(topic)
        if (existing) {
          existing.count++
          existing.lastSeen = Math.max(existing.lastSeen, rec.timestamp)
        } else {
          topicMap.set(topic, {
            count: 1,
            lastSeen: rec.timestamp,
            fromTransition: false,
            transitionProb: 0,
          })
        }
      }
    }

    // ── 来源 B：话题转移预测（基于最后话题预测下一话题） ──
    const lastTopics = intervalAnalysis.lastTopics
    if (lastTopics.length > 0) {
      const predictions = predictNextTopics(lastTopics, TRANSITION_TOP_N)
      for (const pred of predictions) {
        const existing = topicMap.get(pred.topic)
        if (existing) {
          existing.fromTransition = true
          existing.transitionProb = Math.max(existing.transitionProb, pred.probability)
        } else {
          topicMap.set(pred.topic, {
            count: 1,
            lastSeen: Date.now(),
            fromTransition: true,
            transitionProb: pred.probability,
          })
        }
      }
    }

    // ── 计算综合评分 ──
    const now = Date.now()
    const totalInteractions = recentInteractions.length
    const details: TopicScoreDetail[] = []

    for (const [topic, data] of topicMap) {
      // baseConfidence: 话题在窗口内的出现频率占比
      const baseConfidence = totalInteractions > 0 ? data.count / totalInteractions : 0

      // recencyWeight: 近因权重（随时间衰减）
      const hoursSinceLastSeen = (now - data.lastSeen) / (1000 * 60 * 60)
      const recencyWeight = Math.max(0.1, Math.exp(-hoursSinceLastSeen / RECENCY_HALF_LIFE_HOURS))

      // transitionProbabilityBoost: 转移预测的贡献
      const transitionBoost = data.transitionProb * 0.3

      // resumedBoost: 中断续接场景下，最后话题获得额外 boost
      const resumedBoost = intervalAnalysis.hasGap && lastTopics.includes(topic) ? RESUMED_TOPIC_BOOST : 0

      // 综合评分
      const combinedScore = Math.min(1, Math.round((baseConfidence * recencyWeight + transitionBoost + resumedBoost) * 100) / 100)

      details.push({
        topic,
        combinedScore,
        baseConfidence: Math.round(baseConfidence * 100) / 100,
        recencyWeight: Math.round(recencyWeight * 100) / 100,
        transitionProbability: data.transitionProb,
        fromTransition: data.fromTransition,
        behaviorScore: baseConfidence,
      })
    }

    // 按综合评分降序排列
    details.sort((a, b) => b.combinedScore - a.combinedScore)

    return details
  }

  // ══════════════════════════════════════════
  //  场景推断
  // ══════════════════════════════════════════

  /**
   * 根据交互间隔和预热结果推断当前会话场景。
   */
  private inferScene(
    intervalAnalysis: InteractionIntervalResult,
    _topMemories: PrewarmedMemory[],
  ): 'continue' | 'new' | 'resume_after_gap' {
    if (intervalAnalysis.isLongBreak) {
      return 'resume_after_gap'
    }
    if (intervalAnalysis.hasGap && intervalAnalysis.timeSinceLastInteraction > GAP_THRESHOLD_MS) {
      return 'resume_after_gap'
    }
    if (intervalAnalysis.intervals.length > 0) {
      return 'continue'
    }
    return 'new'
  }

  /**
   * 获取场景描述文本。
   */
  private getSceneDescription(scene: 'continue' | 'new' | 'resume_after_gap', _analysis: InteractionIntervalResult): string {
    switch (scene) {
      case 'continue':
        return '连续对话模式，维持在之前的话题上'
      case 'resume_after_gap':
        return '中断后恢复，可能需要重提之前的讨论上下文'
      case 'new':
        return '新对话场景'
    }
  }

  // ══════════════════════════════════════════
  //  结果构造
  // ══════════════════════════════════════════

  /** 构造空的失败结果 */
  private emptyResult(reason: string, startTime: number): PrewarmResult {
    return {
      memories: [],
      success: false,
      intervalAnalysis: {
        timestamps: [],
        intervals: [],
        averageIntervalMs: 0,
        timeSinceLastInteraction: 0,
        hasGap: false,
        isLongBreak: false,
        lastTopics: [],
      },
      topicDetails: [],
      inferredScene: 'new',
      sceneDescription: reason,
      fromCache: false,
      durationMs: Date.now() - startTime,
    }
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const behaviorPredictiveMemoryPrewarmer = new BehaviorPredictiveMemoryPrewarmer()
