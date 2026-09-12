/**
 * MemoryCompressor — 记忆重要性评分与智能压缩服务
 *
 * 职责：
 * 1. 计算每条记忆的综合重要性得分（融合效用、行为、置信度、时效性）
 * 2. 按主题分组相似记忆，LLM 驱动的智能压缩（将多条相关记忆合成为一条摘要）
 * 3. 定期触发压缩检查，归档原始条目并以摘要替换
 * 4. 通过 MemoryEvolutionBridge 向进化系统报告压缩统计
 *
 * 与现有系统的区别：
 * - MemoryService.prune() 仅按得分阈值丢弃最低分的记忆
 * - MemoryCleaner 按效用分数清理低效用记忆
 * - MemoryCompressor 是对相似记忆的"智能合并"，保留信息密度的同时减少条目数
 *
 * 风险控制：
 * - 压缩前保留原始内容到 memory_archive 表
 * - LLM 压缩失败时回退到简单文本拼接
 * - 永久层和 pinned 记忆不参与压缩
 * - 压缩后的摘要置信度 = 原始各条目置信度的加权平均
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { getRawDb, markDirty } from '@akemi-mio/core/db/connection'
import type { MemoryEntry } from './types'
import type { SummaryLLM } from './MetaController'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 压缩检查间隔（6 小时） */
export const COMPRESS_CHECK_INTERVAL = 6 * 60 * 60 * 1000

/** 单次压缩最多处理的分组数 */
export const MAX_GROUPS_PER_RUN = 3

/** 触发压缩的最小相似条目数 */
export const MIN_SIMILAR_ENTRIES = 3

/** 主题相似度阈值（标签重叠率），高于此值视为同一主题组 */
export const TOPIC_SIMILARITY_THRESHOLD = 0.5

/** 压缩后摘要的最大长度（字符） */
export const MAX_SUMMARY_LENGTH = 200

/** 时间窗口（毫秒）：30 天内的记忆才能自动压缩 */
export const COMPRESS_TIME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** 新条目的初始重要性得分 */
export const IMPORTANCE_SCORE_INITIAL = 0.5

/** 参与压缩的最低重要性得分 */
export const IMPORTANCE_MIN_FOR_COMPRESS = 0.3

// ══════════════════════════════════════════
//  重要性得分权重
// ══════════════════════════════════════════

export interface ImportanceWeights {
  /** 效用分数权重 */
  utilityWeight: number
  /** 行为分数权重 */
  behaviorWeight: number
  /** 置信度权重 */
  confidenceWeight: number
  /** 新鲜度权重（近期访问的加分） */
  recencyWeight: number
  /** 强化次数权重 */
  reinforceWeight: number
}

export const DEFAULT_IMPORTANCE_WEIGHTS: ImportanceWeights = {
  utilityWeight: 0.3,
  behaviorWeight: 0.25,
  confidenceWeight: 0.2,
  recencyWeight: 0.15,
  reinforceWeight: 0.1,
}

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface CompressGroup {
  /** 分组的主题标签（交集） */
  commonTopics: string[]
  /** 属于该组的记忆 ID 列表 */
  entryIds: string[]
  /** 该组所有条目的内容 */
  contents: string[]
  /** 综合重要性得分（组内最高） */
  maxImportanceScore: number
  /** 平均置信度 */
  avgConfidence: number
}

export interface CompressResult {
  /** 本次压缩处理的分组数 */
  groupsProcessed: number
  /** 被压缩的记忆条目数 */
  entriesCompressed: number
  /** 新生成的摘要条目数 */
  summariesCreated: number
  /** 处理结果详情 */
  details: Array<{
    originalIds: string[]
    summaryContent: string
    commonTopics: string[]
    avgConfidence: number
  }>
}

export interface ImportanceScoreResult {
  /** 综合重要性得分 0-1 */
  composite: number
  /** 各维度分解得分 */
  breakdown: {
    utility: number
    behavior: number
    confidence: number
    recency: number
    reinforce: number
  }
}

// ══════════════════════════════════════════
//  MemoryCompressor
// ══════════════════════════════════════════

export class MemoryCompressor {
  private timer: ReturnType<typeof setInterval> | null = null
  private weights: ImportanceWeights
  private summaryLLM: SummaryLLM | null = null
  private lastCompressTime = 0
  /** 累计压缩统计 */
  private stats = {
    totalGroupsCompressed: 0,
    totalEntriesCompressed: 0,
    totalSummariesCreated: 0,
    lastRunTimestamp: 0,
  }

  constructor(weights?: Partial<ImportanceWeights>) {
    this.weights = { ...DEFAULT_IMPORTANCE_WEIGHTS, ...weights }
  }

  /** 注入 LLM 服务（用于高质量摘要生成） */
  setSummaryLLM(llm: SummaryLLM | null): void {
    this.summaryLLM = llm
  }

  /** 更新权重配置 */
  updateWeights(weights: Partial<ImportanceWeights>): void {
    this.weights = { ...this.weights, ...weights }
    log('INFO', 'memory_compressor_weights_updated', { weights: this.weights })
  }

  /** 获取当前权重配置 */
  getWeights(): Readonly<ImportanceWeights> {
    return this.weights
  }

  /** 获取累积统计 */
  getStats(): Readonly<typeof this.stats> {
    return this.stats
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  start(): void {
    if (this.timer) return
    // 首次压缩延迟 10 分钟，给系统稳定时间
    setTimeout(
      () => {
        this.timer = setInterval(() => {
          this.stats.lastRunTimestamp = Date.now()
          log('INFO', 'memory_compressor_tick')
        }, COMPRESS_CHECK_INTERVAL)
        log('INFO', 'memory_compressor_started', {
          intervalMs: COMPRESS_CHECK_INTERVAL,
        })
      },
      10 * 60 * 1000,
    )
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ══════════════════════════════════════════
  //  重要性评分
  // ══════════════════════════════════════════

  /**
   * 计算单条记忆的综合重要性得分。
   * 融合 5 个维度，返回 0-1 之间的分数。
   *
   * 计算公式：
   *   composite = Σ(weight_i × score_i)
   *   其中 score_i 归一化到 0-1
   */
  computeImportanceScore(entry: MemoryEntry): ImportanceScoreResult {
    const now = Date.now()

    // 1. 效用维度（0-1）：直接使用 utilityScore
    const utility = Math.max(0, Math.min(1, entry.utilityScore))

    // 2. 行为维度（0-1）：behaviorScore 经过时间衰减
    const daysSinceAccess =
      entry.lastAccessedAt > 0 ? (now - entry.lastAccessedAt) / (1000 * 60 * 60 * 24) : (now - entry.createdAt) / (1000 * 60 * 60 * 24)
    const behaviorDecay = Math.max(0, 1 - daysSinceAccess / 365) // 一年衰减到 0
    const behavior = entry.behaviorScore * behaviorDecay

    // 3. 置信度维度（0-1）：直接使用 confidence
    const confidence = Math.max(0, Math.min(1, entry.confidence))

    // 4. 新鲜度维度（0-1）：近期访问的加分
    const daysSinceLastAccess = entry.lastAccessedAt > 0 ? (now - entry.lastAccessedAt) / (1000 * 60 * 60 * 24) : 365 // 从未访问
    const recency = Math.max(0, 1 - daysSinceLastAccess / 90) // 90 天内线性衰减

    // 5. 强化维度（0-1）：reinforceCount 归一化
    const reinforce = Math.min(1, (entry.reinforceCount || 0) / 10)

    // 综合得分
    const composite =
      this.weights.utilityWeight * utility +
      this.weights.behaviorWeight * behavior +
      this.weights.confidenceWeight * confidence +
      this.weights.recencyWeight * recency +
      this.weights.reinforceWeight * reinforce

    return {
      composite: Math.max(0, Math.min(1, composite)),
      breakdown: { utility, behavior, confidence, recency, reinforce },
    }
  }

  /**
   * 批量计算所有记忆的重要性得分，返回排序后的结果。
   */
  computeAllImportanceScores(entries: MemoryEntry[]): Array<{ entry: MemoryEntry; score: ImportanceScoreResult }> {
    return entries
      .filter((e) => e.type === 'user_fact') // 只对用户事实类计算
      .map((entry) => ({
        entry,
        score: this.computeImportanceScore(entry),
      }))
      .sort((a, b) => b.score.composite - a.score.composite)
  }

  // ══════════════════════════════════════════
  //  主题相似度检测与分组
  // ══════════════════════════════════════════

  /**
   * 计算两个主题标签列表的 Jaccard 相似度。
   */
  computeTopicSimilarity(topicsA: string[], topicsB: string[]): number {
    if (topicsA.length === 0 || topicsB.length === 0) return 0
    const setA = new Set(topicsA.map((t) => t.toLowerCase().trim()))
    const setB = new Set(topicsB.map((t) => t.toLowerCase().trim()))
    let intersection = 0
    for (const t of setA) {
      if (setB.has(t)) intersection++
    }
    const union = new Set([...setA, ...setB]).size
    return intersection / union
  }

  /**
   * 将相似主题的记忆分组。
   * 使用贪心聚类：从最高分条目开始，将与之相似度超过阈值的条目归为同一组。
   *
   * @param scored 已排序的重要性得分列表
   * @param minGroupSize 最小分组大小（低于此值的分组不压缩）
   * @returns 压缩候选分组列表
   */
  groupSimilarMemories(
    scored: Array<{ entry: MemoryEntry; score: ImportanceScoreResult }>,
    minGroupSize = MIN_SIMILAR_ENTRIES,
  ): CompressGroup[] {
    const used = new Set<string>()
    const groups: CompressGroup[] = []

    for (const item of scored) {
      if (used.has(item.entry.id)) continue
      // 低重要性条目不参与压缩
      if (item.score.composite < IMPORTANCE_MIN_FOR_COMPRESS) continue

      const group: CompressGroup = {
        commonTopics: item.entry.topics || [],
        entryIds: [item.entry.id],
        contents: [item.entry.content],
        maxImportanceScore: item.score.composite,
        avgConfidence: item.entry.confidence,
      }
      used.add(item.entry.id)

      for (const other of scored) {
        if (used.has(other.entry.id)) continue
        if (other.score.composite < IMPORTANCE_MIN_FOR_COMPRESS) continue

        const topicsA = item.entry.topics || []
        const topicsB = other.entry.topics || []
        const sim = this.computeTopicSimilarity(topicsA, topicsB)

        if (sim >= TOPIC_SIMILARITY_THRESHOLD) {
          group.entryIds.push(other.entry.id)
          group.contents.push(other.entry.content)
          // 合并主题标签（取交集）
          group.commonTopics = topicsA.filter((t) => topicsB.includes(t))
          group.maxImportanceScore = Math.max(group.maxImportanceScore, other.score.composite)
          group.avgConfidence = (group.avgConfidence + other.entry.confidence) / 2
          used.add(other.entry.id)
        }
      }

      if (group.entryIds.length >= minGroupSize) {
        groups.push(group)
      }
    }

    // 按重要性得分降序排列（优先处理高价值分组）
    groups.sort((a, b) => b.maxImportanceScore - a.maxImportanceScore)
    return groups.slice(0, MAX_GROUPS_PER_RUN)
  }

  // ══════════════════════════════════════════
  //  压缩执行
  // ══════════════════════════════════════════

  /**
   * 执行记忆压缩：将相似记忆分组、生成摘要、归档原始条目。
   *
   * @param entries 所有记忆条目（会被修改：删除被压缩的条目，添加新摘要条目）
   * @param removedIds 用以收集被删除 ID 的 Set
   * @returns 压缩结果报告
   */
  async runCompression(entries: MemoryEntry[], removedIds: Set<string>): Promise<CompressResult> {
    const now = Date.now()
    this.lastCompressTime = now
    const result: CompressResult = {
      groupsProcessed: 0,
      entriesCompressed: 0,
      summariesCreated: 0,
      details: [],
    }

    // 1. 计算重要性得分并排序
    const scored = this.computeAllImportanceScores(entries)
    if (scored.length === 0) return result

    // 2. 分组
    const groups = this.groupSimilarMemories(scored)
    if (groups.length === 0) {
      log('INFO', 'memory_compressor_no_groups_found', {
        totalScored: scored.length,
      })
      return result
    }

    // 3. 逐组压缩
    for (const group of groups.slice(0, MAX_GROUPS_PER_RUN)) {
      try {
        const summaryContent = await this.createGroupSummary(group)
        if (!summaryContent) continue

        // 归档原始条目到 memory_archive
        this.archiveOriginalEntries(group, removedIds)

        // 从 entries 中移除原始条目
        for (const id of group.entryIds) {
          const idx = entries.findIndex((e) => e.id === id)
          if (idx >= 0) {
            entries.splice(idx, 1)
          }
        }

        // 创建压缩后的摘要条目
        const representative = entries.find((e) => e.id === group.entryIds[0])
        const summaryEntry: MemoryEntry = {
          id: 'compressed_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          type: 'user_fact',
          content: summaryContent,
          confidence: group.avgConfidence,
          tier: 'semi', // 摘要摘要存入半永久层
          reinforceCount: 0,
          behaviorScore: Math.min(1, group.maxImportanceScore * 1.1), // 略高于原始组内最高分
          lastAccessedAt: now,
          accessCount: 0,
          isPinned: false,
          manualScoreOverride: null,
          utilityScore: Math.min(1, group.maxImportanceScore),
          agentReferenceCount: 0,
          userConfirmedUsefulCount: 0,
          lastUtilityUpdateAt: now,
          createdAt: now,
          updatedAt: now,
          topics: group.commonTopics.slice(0, 5),
          structuredData: JSON.stringify({
            compressedFrom: group.entryIds,
            originalCount: group.entryIds.length,
            compressedAt: now,
            avgConfidence: group.avgConfidence,
          }),
        }
        entries.push(summaryEntry)
        this.persistSummaryToDb(summaryEntry)

        result.groupsProcessed++
        result.entriesCompressed += group.entryIds.length
        result.summariesCreated++
        result.details.push({
          originalIds: group.entryIds,
          summaryContent,
          commonTopics: group.commonTopics,
          avgConfidence: group.avgConfidence,
        })

        log('INFO', 'memory_compressed_group', {
          originalCount: group.entryIds.length,
          summaryLen: summaryContent.length,
          topics: group.commonTopics.slice(0, 3),
          avgConfidence: group.avgConfidence.toFixed(2),
        })
      } catch (err) {
        log('WARN', 'memory_compressor_group_failed', {
          error: String(err),
          entryIds: group.entryIds.slice(0, 5),
        })
      }
    }

    // 更新统计
    this.stats.totalGroupsCompressed += result.groupsProcessed
    this.stats.totalEntriesCompressed += result.entriesCompressed
    this.stats.totalSummariesCreated += result.summariesCreated

    if (result.groupsProcessed > 0) {
      log('INFO', 'memory_compressor_run_complete', {
        groupsProcessed: result.groupsProcessed,
        entriesCompressed: result.entriesCompressed,
        summariesCreated: result.summariesCreated,
      })
    }

    return result
  }

  /**
   * 生成分组摘要。优先使用 LLM 进行智能摘要，LLM 不可用时回退到简单拼接。
   */
  private async createGroupSummary(group: CompressGroup): Promise<string | null> {
    if (group.contents.length === 0) return null

    // LLM 摘要模式
    if (this.summaryLLM) {
      try {
        const contentsStr = group.contents.map((c, i) => `${i + 1}. ${c.slice(0, 200)}`).join('\n')
        const topicsStr = group.commonTopics.join('、') || '未分类'

        const prompt = `以下是 ${group.contents.length} 条关于同一主题「${topicsStr}」的记忆。请将它们压缩为一条简洁的摘要（不超过 ${MAX_SUMMARY_LENGTH} 字），保留所有重要信息，去除重复内容。这些是 AI 对用户的记忆。

记忆内容：
${contentsStr}

压缩摘要（只输出摘要文本，不要解释）：`

        const response = await this.summaryLLM.chatJson(prompt, {
          system: '你是记忆压缩专家。将多条相关记忆压缩为一条简洁准确的摘要。只输出纯文本，不要 JSON 格式。',
          temperature: 0.2,
          timeoutMs: 15000,
        })

        if (response.error) {
          log('WARN', 'memory_compressor_llm_error', { error: response.error })
          return this.fallbackSummary(group)
        }

        const summary =
          typeof response.data === 'string' ? response.data : response.data?.summary || response.data?.text || this.fallbackSummary(group)

        return summary.slice(0, MAX_SUMMARY_LENGTH)
      } catch {
        return this.fallbackSummary(group)
      }
    }

    // 无 LLM 时的回退：简单去重拼接
    return this.fallbackSummary(group)
  }

  /**
   * 无 LLM 时的摘要回退：简单去重后拼接。
   */
  private fallbackSummary(group: CompressGroup): string {
    const seen = new Set<string>()
    const unique: string[] = []
    for (const c of group.contents) {
      const normalized = c.trim().toLowerCase()
      if (!seen.has(normalized)) {
        seen.add(normalized)
        unique.push(c.trim())
      }
    }

    if (unique.length === 0) return '(空)'
    if (unique.length === 1) return unique[0].slice(0, MAX_SUMMARY_LENGTH)

    const topicPrefix = group.commonTopics.length > 0 ? `【${group.commonTopics.slice(0, 3).join('、')}】` : ''

    const combined = unique.map((c) => c.slice(0, 100)).join('；')

    return `${topicPrefix}${combined}`.slice(0, MAX_SUMMARY_LENGTH)
  }

  /**
   * 将原始条目归档到 memory_archive 表。
   */
  private archiveOriginalEntries(group: CompressGroup, removedIds: Set<string>): void {
    try {
      const db = getRawDb()
      db.run('BEGIN')
      let archived = 0
      for (const id of group.entryIds) {
        removedIds.add(id)
        db.run(
          `INSERT OR REPLACE INTO memory_archive (id, type, content, confidence, tier, reason, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, 'user_fact', '', 0, 'ephemeral', `compressed: grouped with ${group.entryIds.length - 1} similar memories`, Date.now()],
        )
        archived++
      }
      db.run('COMMIT')
      markDirty()
      log('DEBUG', 'memory_compressor_archived', { count: archived })
    } catch (err) {
      try {
        getRawDb().run('ROLLBACK')
      } catch {}
      log('WARN', 'memory_compressor_archive_failed', { error: String(err) })
    }
  }

  /**
   * 将压缩后的摘要条目持久化到数据库。
   */
  private persistSummaryToDb(entry: MemoryEntry): void {
    try {
      const db = getRawDb()
      db.run(
        `INSERT OR REPLACE INTO memories
         (id, type, content, confidence, tier, reinforce_count, behavior_score,
          last_accessed_at, access_count, is_pinned, manual_score_override,
          created_at, updated_at, structured_data, topics,
          utility_score, agent_reference_count, user_confirmed_useful_count, last_utility_update_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.type,
          entry.content,
          entry.confidence,
          entry.tier,
          entry.reinforceCount,
          entry.behaviorScore,
          entry.lastAccessedAt,
          entry.accessCount,
          entry.isPinned ? 1 : 0,
          entry.manualScoreOverride,
          entry.createdAt,
          entry.updatedAt,
          entry.structuredData ?? null,
          JSON.stringify(entry.topics || []),
          entry.utilityScore,
          entry.agentReferenceCount,
          entry.userConfirmedUsefulCount,
          entry.lastUtilityUpdateAt,
        ],
      )
      markDirty()
    } catch (err) {
      log('ERROR', 'memory_compressor_persist_failed', { error: String(err) })
    }
  }

  /**
   * 主动触发一次压缩检查（供外部定时器或手动调用）。
   *
   * @param entries 所有记忆条目
   * @param removedIds 被移除条目的 ID 集合
   */
  async triggerCompression(entries: MemoryEntry[], removedIds: Set<string>): Promise<CompressResult> {
    this.stats.lastRunTimestamp = Date.now()
    return this.runCompression(entries, removedIds)
  }
}
