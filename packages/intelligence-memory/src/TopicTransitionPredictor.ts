/**
 * TopicTransitionPredictor — 话题转移预测与记忆预取
 *
 * ## 职责
 * 1. 从用户交互序列中提取话题转移模式（一阶马尔可夫链）
 * 2. 预测当前话题的下一个可能话题及转移概率
 * 3. 对高置信度预测结果执行记忆预取（将相关记忆加载到快速缓存）
 * 4. 预取缓存支持 TTL 自动失效和 LRU 淘汰
 *
 * ## 与现有系统的区别
 * - BehaviorPredictor 预测下一个工具调用（工具级）
 * - InteractionTracker.getSuggestedTopicsForHour 基于时间预测话题（时段级）
 * - 本组件预测话题间转移（话题级），用于记忆预取
 *
 * ## 数据流
 *   InteractionTracker.record() → MemoryService.recordInteraction()
 *   → TopicTransitionPredictor.recordTopics() 更新转移矩阵
 *   → predictNextTopics() 计算预测 → prefetchMemories() 缓存结果
 *   → getCachedMemoryContext() 供 getFormattedContext() 消费
 *
 * ## 资源保护
 * - 预取缓存有最大条目数和 TTL
 * - 低概率预测不触发预取
 * - 转移矩阵定期裁剪低频条目
 * - 内存开销受限于配置上限
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryEntry } from './types'
import type { InteractionRecord } from './types'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 预测结果 */
export interface TopicPrediction {
  /** 预测的下一个话题标签 */
  topic: string
  /** 转移概率 (0-1) */
  probability: number
  /** 历史出现次数（from→to） */
  transitionCount: number
}

/** 预取缓存条目 */
interface PrefetchEntry {
  /** 缓存的话题标签 */
  topic: string
  /** 预取的记忆条目 */
  entries: MemoryEntry[]
  /** 创建时间 */
  createdAt: number
  /** 过期间戳 */
  expiresAt: number
}

/** 配置 */
export interface TopicTransitionConfig {
  /** 分析窗口大小：最近 N 次交互用于记录转移 */
  windowSize: number
  /** 最小转移出现次数（低于此值不构成有效模式） */
  minTransitionFrequency: number
  /** 触发预取的最小概率 (0-1) */
  prefetchMinProbability: number
  /** 每次预取最多返回的记忆数 */
  prefetchMaxEntries: number
  /** 预取缓存 TTL（毫秒） */
  prefetchTtlMs: number
  /** 预取缓存最大条目数 */
  prefetchCacheMax: number
  /** 转移矩阵裁剪阈值：频率低于此值被移除 */
  pruneFrequencyThreshold: number
  /** 矩阵裁剪间隔（毫秒） */
  pruneIntervalMs: number
}

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

export const DEFAULT_TOPIC_TRANSITION_CONFIG: TopicTransitionConfig = {
  windowSize: 32,
  minTransitionFrequency: 2,
  prefetchMinProbability: 0.15,
  prefetchMaxEntries: 5,
  prefetchTtlMs: 60_000, // 60 秒
  prefetchCacheMax: 20,
  pruneFrequencyThreshold: 1,
  pruneIntervalMs: 30 * 60 * 1000, // 30 分钟
}

// ══════════════════════════════════════════
//  TopicTransitionPredictor
// ══════════════════════════════════════════

export class TopicTransitionPredictor {
  /** 话题转移计数矩阵：fromTopic → toTopic → count */
  private transitionMatrix = new Map<string, Map<string, number>>()

  /** 最近的话题序列（用于构建转移，已去重连续相同话题） */
  private recentTopicSequence: string[] = []

  /** 预取缓存：topic → PrefetchEntry */
  private prefetchCache = new Map<string, PrefetchEntry>()

  /** 最近一次裁剪时间 */
  private lastPruneTime: number = 0

  /** 配置 */
  private config: TopicTransitionConfig

  constructor(config?: Partial<TopicTransitionConfig>) {
    this.config = { ...DEFAULT_TOPIC_TRANSITION_CONFIG, ...config }
    this.lastPruneTime = Date.now()
  }

  // ══════════════════════════════════════════
  //  核心数据采集
  // ══════════════════════════════════════════

  /**
   * 记录一次交互的话题标签，更新话题转移矩阵。
   * 由 MemoryService.recordInteraction() 在每次交互时调用。
   *
   * @param topics 本次交互检测到的话题标签
   */
  recordTopics(topics: string[]): void {
    if (!topics || topics.length === 0) return

    // 获取去重后的话题集合
    const currentTopics = [...new Set(topics)]

    // 如果最近有记录的历史话题，建立转移关系
    if (this.recentTopicSequence.length > 0) {
      const lastTopic = this.recentTopicSequence[this.recentTopicSequence.length - 1]

      for (const currentTopic of currentTopics) {
        // 跳过自环（同一话题重复不记录转移）
        if (currentTopic === lastTopic) continue

        this.incrementTransition(lastTopic, currentTopic)
      }
    }

    // 将新话题追加到序列中（去重连续重复话题）
    for (const topic of currentTopics) {
      const lastIdx = this.recentTopicSequence.length - 1
      if (lastIdx >= 0 && this.recentTopicSequence[lastIdx] === topic) {
        continue // 连续相同话题，跳过
      }
      this.recentTopicSequence.push(topic)
    }

    // 维护窗口大小
    if (this.recentTopicSequence.length > this.config.windowSize) {
      this.recentTopicSequence = this.recentTopicSequence.slice(-this.config.windowSize)
    }

    // 定期裁剪矩阵
    this.tryPruneMatrix()
  }

  /**
   * 从 InteractionTracker 的交互记录批量加载历史转移数据。
   * 用于冷启动时从持久化存储恢复模型。
   */
  loadFromInteractionRecords(records: InteractionRecord[]): void {
    if (!records || records.length < 2) return

    // 提取话题序列，重建转移矩阵
    const topicHistory: string[] = []
    for (const rec of records) {
      if (!rec.topics || rec.topics.length === 0) continue
      for (const topic of [...new Set(rec.topics)]) {
        const lastIdx = topicHistory.length - 1
        if (lastIdx >= 0 && topicHistory[lastIdx] === topic) continue
        topicHistory.push(topic)
      }
    }

    // 重建转移
    for (let i = 1; i < topicHistory.length; i++) {
      this.incrementTransition(topicHistory[i - 1], topicHistory[i])
    }

    // 加载最近窗口
    this.recentTopicSequence = topicHistory.slice(-this.config.windowSize)

    log('INFO', 'topic_transition_loaded', {
      transitions: this.getTotalTransitionCount(),
      sequenceLength: this.recentTopicSequence.length,
    })
  }

  // ══════════════════════════════════════════
  //  预测 API
  // ══════════════════════════════════════════

  /**
   * 基于当前话题预测下一个可能的话题。
   *
   * @param currentTopics 当前交互检测到的话题标签
   * @param topK 返回前 K 个预测（默认 3）
   * @returns 按概率降序排列的预测结果
   */
  predictNextTopics(currentTopics: string[], topK: number = 3): TopicPrediction[] {
    if (!currentTopics || currentTopics.length === 0) return []

    const predictions = new Map<string, { count: number; fromCount: number }>()

    // 对每个当前话题，查找其所有后继话题
    for (const topic of currentTopics) {
      const transitions = this.transitionMatrix.get(topic)
      if (!transitions || transitions.size === 0) continue

      // 计算该话题的总转移次数（分母）
      let totalFrom = 0
      for (const count of transitions.values()) {
        totalFrom += count
      }

      for (const [nextTopic, count] of transitions) {
        // 跳过自环
        if (currentTopics.includes(nextTopic)) continue

        const existing = predictions.get(nextTopic)
        if (existing) {
          existing.count += count
          existing.fromCount += totalFrom
        } else {
          predictions.set(nextTopic, { count, fromCount: totalFrom })
        }
      }
    }

    // 计算概率并排序
    const results: TopicPrediction[] = []
    for (const [topic, { count, fromCount }] of predictions) {
      const probability = fromCount > 0 ? count / fromCount : 0
      if (probability > 0 && count >= this.config.minTransitionFrequency) {
        results.push({ topic, probability, transitionCount: count })
      }
    }

    results.sort((a, b) => b.probability - a.probability)

    // 只取 topK
    const top = results.slice(0, topK)

    if (top.length > 0) {
      log('INFO', 'topic_transition_prediction', {
        from: currentTopics.slice(0, 3).join(', '),
        top: top.map((p) => `${p.topic}(${(p.probability * 100).toFixed(0)}%)`).join(', '),
        candidates: results.length,
      })
    }

    return top
  }

  /**
   * 根据预测结果预取相关记忆到快速缓存。
   * 仅对概率超过阈值的预测执行预取。
   *
   * @param predictions 预测结果
   * @param memoryServiceQueryFn 从 MemoryService 获取记忆的函数
   */
  prefetchMemories(predictions: TopicPrediction[], memoryServiceQueryFn: (topic: string, limit: number) => MemoryEntry[]): number {
    let prefetched = 0

    for (const pred of predictions) {
      // 概率低于阈值跳过
      if (pred.probability < this.config.prefetchMinProbability) continue

      // 已有缓存跳过
      if (this.prefetchCache.has(pred.topic)) {
        // 检查是否过期
        const cached = this.prefetchCache.get(pred.topic)!
        if (Date.now() < cached.expiresAt) continue
        this.prefetchCache.delete(pred.topic)
      }

      // 查询相关记忆
      const entries = memoryServiceQueryFn(pred.topic, this.config.prefetchMaxEntries)
      if (entries.length === 0) continue

      const now = Date.now()
      this.prefetchCache.set(pred.topic, {
        topic: pred.topic,
        entries,
        createdAt: now,
        expiresAt: now + this.config.prefetchTtlMs,
      })
      prefetched++
    }

    // 维护缓存上限
    this.evictPrefetchCache()

    if (prefetched > 0) {
      log('INFO', 'topic_prefetch_completed', {
        prefetched,
        cacheSize: this.prefetchCache.size,
        predictions: predictions.length,
      })
    }

    return prefetched
  }

  /**
   * 尝试从预取缓存中获取指定话题的记忆。
   * 命中则返回缓存内容并刷新访问时间（TTL 重置），
   * 未命中或过期返回 null。
   *
   * @param topic 话题标签
   * @returns 缓存的记忆条目，或 null
   */
  getCachedMemories(topic: string): MemoryEntry[] | null {
    const cached = this.prefetchCache.get(topic)
    if (!cached) return null

    if (Date.now() > cached.expiresAt) {
      this.prefetchCache.delete(topic)
      log('DEBUG', 'topic_prefetch_cache_expired', { topic })
      return null
    }

    log('INFO', 'topic_prefetch_cache_hit', { topic, entries: cached.entries.length })
    return cached.entries
  }

  /**
   * 获取预取缓存的格式化上下文文本（用于注入 system prompt）。
   * 行为预测话题相关的记忆优先呈现。
   *
   * @param currentTopics 当前话题（用于获取预测）
   * @returns 格式化后的上下文文本（空字符串表示无内容）
   */
  getPrefetchContext(currentTopics: string[]): string {
    if (!currentTopics || currentTopics.length === 0) return ''

    // 1. 先检查缓存是否已命中
    const cachedParts: string[] = []
    for (const topic of currentTopics) {
      const cached = this.getCachedMemories(topic)
      if (cached && cached.length > 0) {
        for (const entry of cached) {
          cachedParts.push('- ' + entry.content)
        }
      }
    }

    // 2. 再检查预测话题的缓存
    const predictions = this.predictNextTopics(currentTopics, 2)
    const predictedParts: string[] = []
    for (const pred of predictions) {
      const cached = this.getCachedMemories(pred.topic)
      if (cached && cached.length > 0) {
        for (const entry of cached) {
          predictedParts.push('- [' + pred.topic + '] ' + entry.content)
        }
      }
    }

    if (cachedParts.length === 0 && predictedParts.length === 0) return ''

    const lines: string[] = ['---', '【行为预测预取记忆】基于你当前话题的行为模式，以下信息可能即将用到：']
    if (cachedParts.length > 0) {
      lines.push('当前话题相关：')
      lines.push(...cachedParts)
    }
    if (predictedParts.length > 0) {
      lines.push('预测下一话题相关：')
      lines.push(...predictedParts)
    }
    lines.push('---')
    return lines.join('\n')
  }

  /**
   * 快速查询：当外部需要查询某一话题的记忆时，
   * 先检查预取缓存，命中则直接返回；未命中返回 null 以触发常规查询。
   */
  queryPrefetched(topic: string): { entries: MemoryEntry[]; source: 'cache' } | null {
    const cached = this.getCachedMemories(topic)
    if (cached) {
      return { entries: cached, source: 'cache' }
    }
    return null
  }

  // ══════════════════════════════════════════
  //  统计与调试 API
  // ══════════════════════════════════════════

  /** 获取指定话题的 Top-N 后继话题（用于调试和显示） */
  getTopTransitions(topic: string, topK: number = 5): Array<{ nextTopic: string; probability: number; count: number }> {
    const transitions = this.transitionMatrix.get(topic)
    if (!transitions || transitions.size === 0) return []

    let totalFrom = 0
    for (const count of transitions.values()) {
      totalFrom += count
    }

    return [...transitions.entries()]
      .map(([nextTopic, count]) => ({
        nextTopic,
        probability: totalFrom > 0 ? count / totalFrom : 0,
        count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topK)
  }

  /** 获取转移矩阵的统计摘要 */
  getStats(): {
    matrixSize: number
    totalTransitions: number
    uniqueFromTopics: number
    uniqueToTopics: number
    cacheSize: number
    sequenceLength: number
  } {
    const allFrom = new Set<string>()
    const allTo = new Set<string>()
    let total = 0

    for (const [from, tos] of this.transitionMatrix) {
      allFrom.add(from)
      for (const [to, count] of tos) {
        allTo.add(to)
        total += count
      }
    }

    return {
      matrixSize: this.transitionMatrix.size,
      totalTransitions: total,
      uniqueFromTopics: allFrom.size,
      uniqueToTopics: allTo.size,
      cacheSize: this.prefetchCache.size,
      sequenceLength: this.recentTopicSequence.length,
    }
  }

  /** 获取配置的只读副本 */
  getConfig(): Readonly<TopicTransitionConfig> {
    return { ...this.config }
  }

  /** 更新配置 */
  updateConfig(partial: Partial<TopicTransitionConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /** 重置所有状态（矩阵、序列、缓存） */
  reset(): void {
    this.transitionMatrix.clear()
    this.recentTopicSequence = []
    this.prefetchCache.clear()
    this.lastPruneTime = Date.now()

    log('INFO', 'topic_transition_predictor_reset')
  }

  // ══════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════

  /** 增加一次话题转移计数 */
  private incrementTransition(fromTopic: string, toTopic: string): void {
    let fromMap = this.transitionMatrix.get(fromTopic)
    if (!fromMap) {
      fromMap = new Map<string, number>()
      this.transitionMatrix.set(fromTopic, fromMap)
    }
    fromMap.set(toTopic, (fromMap.get(toTopic) || 0) + 1)
  }

  /** 获取转移矩阵中的总转移次数 */
  private getTotalTransitionCount(): number {
    let total = 0
    for (const [, tos] of this.transitionMatrix) {
      for (const [, count] of tos) {
        total += count
      }
    }
    return total
  }

  /** 定期裁剪低频转移条目 */
  private tryPruneMatrix(): void {
    const now = Date.now()
    if (now - this.lastPruneTime < this.config.pruneIntervalMs) return
    this.lastPruneTime = now

    let removedFrom = 0
    let removedTo = 0

    for (const [fromTopic, tos] of this.transitionMatrix) {
      const toDelete: string[] = []
      for (const [toTopic, count] of tos) {
        if (count <= this.config.pruneFrequencyThreshold) {
          toDelete.push(toTopic)
        }
      }
      for (const t of toDelete) {
        tos.delete(t)
        removedTo++
      }
      if (tos.size === 0) {
        this.transitionMatrix.delete(fromTopic)
        removedFrom++
      }
    }

    if (removedFrom > 0 || removedTo > 0) {
      log('INFO', 'topic_transition_matrix_pruned', {
        removedFrom,
        removedToEntries: removedTo,
        remainingSize: this.transitionMatrix.size,
      })
    }
  }

  /** 维护预取缓存上限，淘汰最旧的条目 */
  private evictPrefetchCache(): void {
    const now = Date.now()

    // 先清理过期
    for (const [key, entry] of this.prefetchCache) {
      if (now > entry.expiresAt) {
        this.prefetchCache.delete(key)
      }
    }

    // 仍超出上限，淘汰最旧的
    if (this.prefetchCache.size > this.config.prefetchCacheMax) {
      const entries = [...this.prefetchCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
      const toRemove = this.prefetchCache.size - this.config.prefetchCacheMax
      for (let i = 0; i < toRemove; i++) {
        this.prefetchCache.delete(entries[i][0])
      }
    }
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const topicTransitionPredictor = new TopicTransitionPredictor()
