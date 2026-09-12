/**
 * MemoryUtilityTracker — 记忆效用跟踪器
 *
 * 跟踪每条记忆在 Agent 决策中的实际使用情况，动态评估效用分数。
 * 效用分数 = f(Agent 引用频率, 用户确认有用次数, 内容时效性)
 *
 * 集成点：
 * 1. MemoryService.getFormattedContext() 提供记忆列表时，将记忆 ID 注入上下文标记
 * 2. ChatExecutor 在 Agent 回复后调用 recordAgentReference() 检测用到的记忆
 * 3. 用户可通过 MemoryTools 明确标记某条记忆为"有用"
 * 4. 定期与 MemoryCleaner 联动，低效用记忆进入清理候选
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryEntry } from './types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 基础效用初始值 */
export const UTILITY_SCORE_INITIAL = 0.5

/** Agent 每次引用带来的效用增量 */
export const UTILITY_AGENT_REFERENCE_BOOST = 0.08

/** 用户明确确认有用的效用增量 */
export const UTILITY_USER_CONFIRM_BOOST = 0.15

/** 每日效用衰减率（未引用的记忆每天衰减） */
export const UTILITY_DAILY_DECAY = 0.02

/** 效用分数最小值（避免归零后无法恢复） */
export const UTILITY_SCORE_MIN = 0.05

/** 效用分数最大值 */
export const UTILITY_SCORE_MAX = 1.0

/** 低效用阈值：低于此值的记忆可能被清理 */
export const UTILITY_LOW_THRESHOLD = 0.15

/** 高效用阈值：高于此值的记忆优先放入上下文 */
export const UTILITY_HIGH_THRESHOLD = 0.7

/** 内容相似度检测阈值（Jaccard bigram，0-1），高于此值视为 Agent 引用了记忆 */
export const REFERENCE_SIMILARITY_THRESHOLD = 0.3

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface UtilityStats {
  /** 当前所有记忆的平均效用分 */
  averageUtility: number
  /** 低效用记忆数量 */
  lowUtilityCount: number
  /** 高效用记忆数量 */
  highUtilityCount: number
  /** 最近被 Agent 引用的记忆数量 */
  recentlyReferencedCount: number
  /** 上次评估时间 */
  lastEvaluationTime: number
}

// ══════════════════════════════════════════
//  MemoryUtilityTracker
// ══════════════════════════════════════════

export class MemoryUtilityTracker {
  /** 最近一次 Agent 回复中已经检查过的记忆 ID 集合（防止重复计数） */
  private lastCheckedMemoryIds = new Set<string>()

  /**
   * 计算两条文本的字符 bigram Jaccard 相似度。
   * 用于检测 Agent 回复是否引用了某条记忆的内容。
   */
  private computeTextSimilarity(a: string, b: string): number {
    if (!a || !b) return 0
    const na = a.toLowerCase().trim()
    const nb = b.toLowerCase().trim()
    if (na === nb) return 1.0

    const bigramsA = new Set<string>()
    const bigramsB = new Set<string>()

    for (let i = 0; i < na.length - 1; i++) {
      bigramsA.add(na.slice(i, i + 2))
    }
    for (let i = 0; i < nb.length - 1; i++) {
      bigramsB.add(nb.slice(i, i + 2))
    }

    if (bigramsA.size === 0 && bigramsB.size === 0) return 0

    let intersection = 0
    for (const bg of bigramsA) {
      if (bigramsB.has(bg)) intersection++
    }

    const union = bigramsA.size + bigramsB.size - intersection
    if (union === 0) return 0

    return intersection / union
  }

  /**
   * 检查记忆内容是否与 Agent 回复文本相似（Agent 可能引用了该记忆）。
   * @param agentReply Agent 的回复文本
   * @param memoryContent 记忆内容
   * @param threshold 相似度阈值
   */
  isMemoryReferenced(agentReply: string, memoryContent: string, threshold = REFERENCE_SIMILARITY_THRESHOLD): boolean {
    if (!agentReply || !memoryContent) return false

    // 1. 精确匹配：记忆内容直接出现在回复中
    if (agentReply.toLowerCase().includes(memoryContent.toLowerCase().slice(0, 40))) {
      return true
    }

    // 2. 关键词匹配：记忆的关键词出现在回复中
    const memoryKeywords = memoryContent.split(/[\s,，。；;：:！!？?、]+/).filter((w) => w.length >= 2)
    const replyLower = agentReply.toLowerCase()
    let keywordMatches = 0
    for (const kw of memoryKeywords) {
      if (replyLower.includes(kw.toLowerCase())) {
        keywordMatches++
      }
    }
    if (memoryKeywords.length > 0 && keywordMatches / memoryKeywords.length >= 0.4) {
      return true
    }

    // 3. Bigram 相似度匹配
    const similarity = this.computeTextSimilarity(agentReply.slice(0, 100), memoryContent.slice(0, 100))
    return similarity >= threshold
  }

  /**
   * 在 Agent 回复后检测哪些记忆被引用，并更新它们的效用分数。
   * 返回被引用的记忆 ID 列表（用于日志）。
   *
   * @param entries 所有记忆条目
   * @param agentReply Agent 的回复文本
   * @returns 被引用的记忆 ID 列表
   */
  recordAgentReference(entries: MemoryEntry[], agentReply: string): string[] {
    if (!agentReply || entries.length === 0) return []

    const referencedIds: string[] = []
    this.lastCheckedMemoryIds.clear()

    for (const entry of entries) {
      if (entry.type !== 'user_fact') continue // 只检查用户事实类记忆
      if (this.isMemoryReferenced(agentReply, entry.content)) {
        // 提升效用分数
        entry.utilityScore = Math.min(UTILITY_SCORE_MAX, entry.utilityScore + UTILITY_AGENT_REFERENCE_BOOST)
        entry.agentReferenceCount++
        entry.lastUtilityUpdateAt = Date.now()
        entry.lastAccessedAt = Date.now()
        entry.accessCount++
        referencedIds.push(entry.id)
        this.lastCheckedMemoryIds.add(entry.id)
      }
    }

    if (referencedIds.length > 0) {
      log('INFO', 'memory_utility_reference_detected', {
        count: referencedIds.length,
        ids: referencedIds.slice(0, 10),
      })
    }

    return referencedIds
  }

  /**
   * 用户明确确认某条记忆有用。
   * 由 MemoryTools.remember_fact 或用户反馈工具触发。
   */
  recordUserConfirmedUseful(entry: MemoryEntry): void {
    entry.utilityScore = Math.min(UTILITY_SCORE_MAX, entry.utilityScore + UTILITY_USER_CONFIRM_BOOST)
    entry.userConfirmedUsefulCount++
    entry.lastUtilityUpdateAt = Date.now()
    log('INFO', 'memory_utility_user_confirmed', {
      id: entry.id,
      content: entry.content.slice(0, 50),
      newUtility: entry.utilityScore.toFixed(3),
    })
  }

  /**
   * 对单条记忆应用时间衰减。
   * 每天未使用将衰减 UTILITY_DAILY_DECAY。
   */
  applyDecay(entry: MemoryEntry, now = Date.now()): boolean {
    if (entry.tier === 'permanent' || entry.isPinned) return false

    const daysSinceUpdate = entry.lastUtilityUpdateAt > 0 ? (now - entry.lastUtilityUpdateAt) / (1000 * 60 * 60 * 24) : 0

    if (daysSinceUpdate < 1) return false // 不足一天不减

    // 每过一天衰减一次
    const decayAmount = UTILITY_DAILY_DECAY * Math.floor(daysSinceUpdate)
    if (decayAmount <= 0) return false

    const oldScore = entry.utilityScore
    entry.utilityScore = Math.max(UTILITY_SCORE_MIN, entry.utilityScore - decayAmount)
    entry.lastUtilityUpdateAt = now

    log('DEBUG', 'memory_utility_decayed', {
      id: entry.id,
      oldScore: oldScore.toFixed(3),
      newScore: entry.utilityScore.toFixed(3),
      daysSinceUpdate: Math.floor(daysSinceUpdate),
    })

    return oldScore !== entry.utilityScore
  }

  /**
   * 对所有记忆批量应用效用衰减。
   * @returns 被衰减的记忆数
   */
  applyDecayToAll(entries: MemoryEntry[]): number {
    const now = Date.now()
    let decayed = 0
    for (const entry of entries) {
      if (this.applyDecay(entry, now)) decayed++
    }
    if (decayed > 0) {
      log('INFO', 'memory_utility_batch_decay', { decayed })
    }
    return decayed
  }

  /**
   * 计算记忆的综合效用分数。
   * 效用 = 基础值 + Agent 引用贡献 + 用户确认贡献 - 时间衰减
   * 返回 0~1 之间的分数。
   */
  computeUtilityScore(entry: MemoryEntry): number {
    if (entry.tier === 'permanent' || entry.isPinned) return UTILITY_SCORE_MAX
    if (entry.manualScoreOverride !== null) return entry.manualScoreOverride

    return entry.utilityScore
  }

  /**
   * 判断记忆是否为低效用（可被清理候选）。
   */
  isLowUtility(entry: MemoryEntry): boolean {
    if (entry.tier === 'permanent' || entry.isPinned) return false
    return this.computeUtilityScore(entry) < UTILITY_LOW_THRESHOLD
  }

  /**
   * 判断记忆是否为高效用（优先放入上下文窗口）。
   */
  isHighUtility(entry: MemoryEntry): boolean {
    if (entry.tier === 'permanent' || entry.isPinned) return true
    return this.computeUtilityScore(entry) >= UTILITY_HIGH_THRESHOLD
  }

  /**
   * 获取效用统计信息。
   */
  getStats(entries: MemoryEntry[]): UtilityStats {
    const userFacts = entries.filter((e) => e.type === 'user_fact')
    if (userFacts.length === 0) {
      return {
        averageUtility: 0,
        lowUtilityCount: 0,
        highUtilityCount: 0,
        recentlyReferencedCount: 0,
        lastEvaluationTime: Date.now(),
      }
    }

    const scores = userFacts.map((e) => this.computeUtilityScore(e))
    const averageUtility = scores.reduce((a, b) => a + b, 0) / scores.length
    const lowUtilityCount = userFacts.filter((e) => this.isLowUtility(e)).length
    const highUtilityCount = userFacts.filter((e) => this.isHighUtility(e)).length
    const recentlyReferencedCount = userFacts.filter(
      (e) => e.agentReferenceCount > 0 && e.lastUtilityUpdateAt > Date.now() - 7 * 24 * 3600_000,
    ).length

    return {
      averageUtility,
      lowUtilityCount,
      highUtilityCount,
      recentlyReferencedCount,
      lastEvaluationTime: Date.now(),
    }
  }
}
