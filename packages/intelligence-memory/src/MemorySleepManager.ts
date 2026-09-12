/**
 * MemorySleepManager — 智能记忆休眠与预唤醒管理器
 *
 * 职责：
 * 1. 空闲检测：当用户连续 2 小时无交互时触发记忆整理
 * 2. 低频记忆压缩：将访问间隔超过 7 天的低频记忆进行 LLM 摘要压缩并存盘
 * 3. 活跃时段分析：通过滑动窗口分析用户每日活跃时段
 * 4. 预加载调度：在预测的活跃时段前 10 分钟，将高频记忆从磁盘加载到内存缓存
 *
 * 集成点：
 * - MemoryService.recordInteraction() 调用本类的 recordInteraction()
 * - MemoryService.getFormattedContext() 调用本类的 getPreloadCacheContext()
 * - MemoryService.setSummaryLLM() 传播 LLM 引用到本类
 * - MemoryService.shutdown() 调用本类的 stop()
 *
 * 风险控制：
 * - 预加载时机误判可能增加延迟 → 使用保守预测策略，缓存 TTL 窗口保护
 * - 摘要压缩可能丢失细节 → 原条目录入 memory_archive 可恢复
 * - 空闲检测在低交互量情况下可能误触发 → 要求至少 3 天数据才有预测
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { getRawDb, markDirty } from '@akemi-mio/core/db/connection'
import type { MemoryEntry } from './types'
import type { SummaryLLM } from './MetaController'

// ══════════════════════════════════════════
//  配置常量（与 config/index.ts 同步）
// ══════════════════════════════════════════

/** 空闲阈值：连续无交互超过此时间触发整理（2 小时） */
export const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000

/** 低频判定：超过此天数未访问视为低频记忆 */
export const LOW_FREQUENCY_DAYS = 7

/** 整理检查间隔（每 30 分钟检查一次空闲状态） */
export const CONSOLIDATION_CHECK_INTERVAL = 30 * 60 * 1000

/** 预加载提前量：在预测活跃时段前此时间开始加载 */
export const PRELOAD_AHEAD_MINUTES = 10

/** 预加载提前时间（毫秒） */
export const PRELOAD_AHEAD_MS = PRELOAD_AHEAD_MINUTES * 60 * 1000

/** 活跃时段滑动窗口天数 */
export const ACTIVITY_WINDOW_DAYS = 14

/** 最小数据天数：少于此时不进行预测 */
export const MIN_ACTIVITY_DAYS = 3

/** 高频记忆判定阈值：当日活跃时段中至少出现 N 天 */
export const HIGH_FREQUENCY_DAY_THRESHOLD = 3

/** 预加载缓存最大条目数 */
export const PRELOAD_CACHE_MAX = 15

/** 预加载缓存 TTL（毫秒）：超过此时间缓存失效 */
export const PRELOAD_CACHE_TTL_MS = 30 * 60 * 1000

/** 单次压缩最多处理的记忆数 */
export const MAX_COMPRESS_PER_RUN = 50

/** LLM 摘要最大字符长度 */
export const MAX_SUMMARY_LENGTH = 200

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface ConsolidationResult {
  /** 被压缩的原始记忆数 */
  compressedCount: number
  /** 被跳过的条目数 */
  skippedCount: number
  /** 新生成的摘要条目数 */
  summariesCreated: number
  /** 开始时间戳 */
  startedAt: number
  /** 完成时间戳 */
  completedAt: number
}

export interface PreloadCacheEntry {
  /** 记忆条目 ID */
  id: string
  /** 记忆内容 */
  content: string
  /** 记忆主题标签 */
  topics: string[]
  /** 行为得分 */
  behaviorScore: number
  /** 缓存创建时间 */
  cachedAt: number
}

export interface ActivityHourStat {
  /** 小时 (0-23) */
  hour: number
  /** 过去 N 天中该小时有交互的天数 */
  activeDays: number
  /** 该小时的总交互次数 */
  totalInteractions: number
}

// ══════════════════════════════════════════
//  MemorySleepManager
// ══════════════════════════════════════════

export class MemorySleepManager {
  /** 上次交互时间戳 */
  private lastInteractionTime: number = Date.now()
  /** 空闲检测定时器 */
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** 预加载调度定时器 */
  private preloadTimer: ReturnType<typeof setTimeout> | null = null
  /** 定期检查定时器 */
  private checkInterval: ReturnType<typeof setInterval> | null = null
  /** 是否正在执行整理 */
  private isConsolidating: boolean = false
  /** 当前是否为空闲状态 */
  private isIdle: boolean = false
  /** 懒加载的预加载缓存 */
  private preloadCache: PreloadCacheEntry[] | null = null
  /** 缓存创建时间 */
  private cacheCreatedAt: number = 0
  /** LLM 摘要服务引用 */
  private summaryLLM: SummaryLLM | null = null

  constructor(
    /** 获取当前记忆条目列表的函数引用 */
    private getEntries: () => MemoryEntry[],
    /** 用于收集被删除 ID 的 Set */
    private removedIds: Set<string>,
    /** 持久化单条记忆到 DB 的回调 */
    private persistEntry: (entry: MemoryEntry) => void,
    /** 整理完成回调（可选） */
    private onConsolidated?: (result: ConsolidationResult) => void,
  ) {}

  /** 注入 LLM 服务（用于高质量摘要生成） */
  setSummaryLLM(llm: SummaryLLM | null): void {
    this.summaryLLM = llm
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /** 启动管理器 */
  start(): void {
    if (this.checkInterval) return

    // 定期检查空闲状态和预加载调度
    this.checkInterval = setInterval(() => {
      this.tick()
    }, CONSOLIDATION_CHECK_INTERVAL)

    // 初始预加载调度（系统刚启动时，基于历史数据进行预测）
    this.updatePreloadSchedule()

    log('INFO', 'memory_sleep_manager_started', {
      idleThresholdMs: IDLE_THRESHOLD_MS,
      lowFrequencyDays: LOW_FREQUENCY_DAYS,
      checkIntervalMs: CONSOLIDATION_CHECK_INTERVAL,
      preloadAheadMs: PRELOAD_AHEAD_MS,
    })
  }

  /** 停止管理器（清理所有定时器） */
  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.preloadTimer) {
      clearTimeout(this.preloadTimer)
      this.preloadTimer = null
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
    this.preloadCache = null
    this.isConsolidating = false
    log('INFO', 'memory_sleep_manager_stopped')
  }

  /** 是否当前处于空闲状态 */
  getIsIdle(): boolean {
    return this.isIdle
  }

  /** 获取已空闲时长（毫秒） */
  getIdleDuration(): number {
    return Date.now() - this.lastInteractionTime
  }

  // ══════════════════════════════════════════
  //  交互记录入口（由 MemoryService 调用）
  // ══════════════════════════════════════════

  /**
   * 记录一次用户交互。
   * 重置空闲计时器、更新活跃时段信息、重新计算预加载调度。
   * 由 MemoryService.recordInteraction() 在每次对话交互时调用。
   */
  recordInteraction(): void {
    this.lastInteractionTime = Date.now()
    this.isIdle = false

    // 重置空闲检测定时器：如果 2 小时内无新交互则触发整理
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
    }
    this.idleTimer = setTimeout(() => {
      this.checkAndConsolidate()
    }, IDLE_THRESHOLD_MS)

    // 记录当前小时为活跃时段
    this.recordActiveHour()

    // 重新评估预加载调度
    this.updatePreloadSchedule()
  }

  // ══════════════════════════════════════════
  //  空闲检测与整理触发
  // ══════════════════════════════════════════

  /** 周期性 tick：检查空闲状态和预加载调度 */
  private tick(): void {
    // 检查空闲状态
    if (!this.isConsolidating && this.getIdleDuration() >= IDLE_THRESHOLD_MS) {
      this.checkAndConsolidate()
    }

    // 定期检查是否需要重新调度预加载
    this.updatePreloadSchedule()
  }

  /**
   * 检查空闲状态并触发整理。
   * 当用户连续 IDLE_THRESHOLD_MS 无交互时执行低频记忆压缩。
   */
  private async checkAndConsolidate(): Promise<void> {
    if (this.isConsolidating) return

    this.isIdle = true
    const idleDuration = this.getIdleDuration()

    log('INFO', 'memory_sleep_detected', {
      idleDurationMs: idleDuration,
      idleHours: (idleDuration / 3600000).toFixed(1),
    })

    await this.runLowFrequencyConsolidation()
  }

  // ══════════════════════════════════════════
  //  低频记忆压缩
  // ══════════════════════════════════════════

  /**
   * 执行低频记忆压缩。
   * 查找超过 LOW_FREQUENCY_DAYS 天未被访问的记忆，
   * 按主题分组，使用 LLM 摘要压缩，归档原始条目。
   */
  async runLowFrequencyConsolidation(): Promise<ConsolidationResult> {
    this.isConsolidating = true
    const now = Date.now()
    const sevenDaysMs = LOW_FREQUENCY_DAYS * 24 * 60 * 60 * 1000

    const result: ConsolidationResult = {
      compressedCount: 0,
      skippedCount: 0,
      summariesCreated: 0,
      startedAt: now,
      completedAt: 0,
    }

    try {
      const entries = this.getEntries()

      // 找出低频记忆：超过 7 天未访问、非永久、非固定
      const lowFreqEntries = entries.filter(
        (e) =>
          e.type === 'user_fact' && e.tier !== 'permanent' && !e.isPinned && e.lastAccessedAt > 0 && now - e.lastAccessedAt > sevenDaysMs,
      )

      if (lowFreqEntries.length === 0) {
        result.completedAt = Date.now()
        log('INFO', 'memory_sleep_no_low_freq_entries')
        this.isConsolidating = false
        return result
      }

      // 限制单次处理数量
      const targetEntries = lowFreqEntries.slice(0, MAX_COMPRESS_PER_RUN)

      // 按主题相似度分组
      const groups = this.groupEntriesByTopic(targetEntries)

      for (const group of groups) {
        try {
          let summary: string

          if (this.summaryLLM && group.contents.length >= 2) {
            summary = await this.createLLMSummary(group)
          } else {
            summary = this.createFallbackSummary(group)
          }

          // 归档原始条目
          for (const entry of group.entries) {
            this.archiveEntry(entry)
            const idx = entries.indexOf(entry)
            if (idx >= 0) {
              entries.splice(idx, 1)
            }
          }

          // 创建压缩后的摘要条目
          const summaryEntry: MemoryEntry = {
            id: 'sleep_compress_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            type: 'user_fact',
            content: summary,
            confidence: group.avgConfidence,
            tier: 'semi',
            reinforceCount: 0,
            behaviorScore: group.maxBehaviorScore,
            lastAccessedAt: now,
            accessCount: 0,
            isPinned: false,
            manualScoreOverride: null,
            utilityScore: group.maxUtilityScore,
            agentReferenceCount: 0,
            userConfirmedUsefulCount: 0,
            lastUtilityUpdateAt: now,
            createdAt: now,
            updatedAt: now,
            topics: group.commonTopics.slice(0, 5),
            structuredData: JSON.stringify({
              compressedFrom: group.entries.map((e) => e.id),
              originalCount: group.entries.length,
              compressedAt: now,
              reason: 'sleep_consolidation',
              avgConfidence: group.avgConfidence,
            }),
          }

          entries.push(summaryEntry)
          this.persistEntry(summaryEntry)

          result.compressedCount += group.entries.length
          result.summariesCreated++
        } catch (err) {
          log('WARN', 'memory_sleep_consolidation_group_failed', {
            error: String(err),
            count: group.entries.length,
          })
        }
      }

      result.completedAt = Date.now()

      if (result.compressedCount > 0 || result.summariesCreated > 0) {
        log('INFO', 'memory_sleep_consolidation_complete', {
          compressedCount: result.compressedCount,
          summariesCreated: result.summariesCreated,
          skippedCount: result.skippedCount,
          elapsedMs: result.completedAt - result.startedAt,
        })
      }

      this.onConsolidated?.(result)
    } catch (err) {
      log('ERROR', 'memory_sleep_consolidation_failed', {
        error: String(err),
      })
    }

    this.isConsolidating = false
    return result
  }

  /** 按主题标签对低频记忆进行分组 */
  private groupEntriesByTopic(
    entries: MemoryEntry[],
    minGroupSize = 2,
  ): Array<{
    entries: MemoryEntry[]
    contents: string[]
    commonTopics: string[]
    maxBehaviorScore: number
    maxUtilityScore: number
    avgConfidence: number
  }> {
    const used = new Set<string>()
    const groups: Array<{
      entries: MemoryEntry[]
      contents: string[]
      commonTopics: string[]
      maxBehaviorScore: number
      maxUtilityScore: number
      avgConfidence: number
    }> = []

    for (const entry of entries) {
      if (used.has(entry.id)) continue

      const group = {
        entries: [entry],
        contents: [entry.content],
        commonTopics: [...(entry.topics || [])],
        maxBehaviorScore: entry.behaviorScore,
        maxUtilityScore: entry.utilityScore,
        avgConfidence: entry.confidence,
      }
      used.add(entry.id)

      for (const other of entries) {
        if (used.has(other.id)) continue

        const topicsA = entry.topics || []
        const topicsB = other.topics || []
        const overlap = topicsA.filter((t) => topicsB.includes(t))

        if (overlap.length > 0 || this.contentsSimilar(entry.content, other.content)) {
          group.entries.push(other)
          group.contents.push(other.content)
          group.commonTopics = overlap.length > 0 ? overlap : group.commonTopics
          group.maxBehaviorScore = Math.max(group.maxBehaviorScore, other.behaviorScore)
          group.maxUtilityScore = Math.max(group.maxUtilityScore, other.utilityScore)
          group.avgConfidence = (group.avgConfidence + other.confidence) / 2
          used.add(other.id)
        }
      }

      if (group.entries.length >= minGroupSize) {
        groups.push(group)
      }
    }

    // 按行为得分降序排列
    groups.sort((a, b) => b.maxBehaviorScore - a.maxBehaviorScore)
    return groups
  }

  /** 检查两条内容是否相似（关键词重叠） */
  private contentsSimilar(a: string, b: string): boolean {
    const wordsA = new Set(
      a
        .toLowerCase()
        .split(/[\s,，。；;：:！!？?、()（）[\]【】]+/)
        .filter((w) => w.length >= 2),
    )
    const wordsB = new Set(
      b
        .toLowerCase()
        .split(/[\s,，。；;：:！!？?、()（）[\]【】]+/)
        .filter((w) => w.length >= 2),
    )

    if (wordsA.size === 0 || wordsB.size === 0) return false

    let intersection = 0
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++
    }

    const union = wordsA.size + wordsB.size - intersection
    return union > 0 && intersection / union >= 0.3
  }

  /** 使用 LLM 生成分组摘要 */
  private async createLLMSummary(group: { contents: string[]; commonTopics: string[] }): Promise<string> {
    if (!this.summaryLLM || group.contents.length === 0) {
      return this.createFallbackSummary(group)
    }

    const contentsStr = group.contents.map((c, i) => `${i + 1}. ${c.slice(0, 200)}`).join('\n')
    const topicsStr = group.commonTopics.join('、') || '未分类'

    const prompt = `以下是 ${group.contents.length} 条关于同一主题「${topicsStr}」的长期记忆。请将它们压缩为一条简洁的摘要（不超过 ${MAX_SUMMARY_LENGTH} 字），保留所有重要信息，去除重复内容。这些是 AI 对用户的记忆。

记忆内容：
${contentsStr}

压缩摘要（只输出摘要文本，不要解释）：`

    try {
      const response = await this.summaryLLM.chatJson(prompt, {
        system: '你是记忆压缩专家。将多条相关记忆压缩为一条简洁准确的摘要。只输出纯文本，不要 JSON 格式。',
        temperature: 0.2,
        timeoutMs: 15000,
      })

      if (response.error) {
        log('WARN', 'memory_sleep_llm_error', { error: response.error })
        return this.createFallbackSummary(group)
      }

      const summary =
        typeof response.data === 'string'
          ? response.data
          : response.data?.summary || response.data?.text || this.createFallbackSummary(group)

      return summary.slice(0, MAX_SUMMARY_LENGTH)
    } catch {
      return this.createFallbackSummary(group)
    }
  }

  /** 无 LLM 时的摘要回退：去重后拼接 */
  private createFallbackSummary(group: { contents: string[]; commonTopics: string[] }): string {
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

  /** 将原始条目归档到 memory_archive */
  private archiveEntry(entry: MemoryEntry): void {
    this.removedIds.add(entry.id)
    try {
      const db = getRawDb()
      db.run(
        `INSERT OR REPLACE INTO memory_archive (id, type, content, confidence, tier, reason, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.type,
          entry.content,
          entry.confidence,
          entry.tier,
          `sleep_consolidation: low-frequency (>${LOW_FREQUENCY_DAYS}d no access)`,
          Date.now(),
        ],
      )
      markDirty()
    } catch (err) {
      log('WARN', 'memory_sleep_archive_failed', {
        error: String(err),
        entryId: entry.id,
      })
    }
  }

  // ══════════════════════════════════════════
  //  活跃时段分析与预加载调度
  // ══════════════════════════════════════════

  /**
   * 记录当前小时为活跃时段。
   * 在 interaction_log 表中记录活跃时间点，供滑动窗口分析使用。
   */
  private recordActiveHour(): void {
    try {
      const db = getRawDb()
      const now = Date.now()
      const hour = new Date(now).getHours()
      const dateStr = new Date(now).toISOString().slice(0, 10) // YYYY-MM-DD

      // 使用 INSERT OR IGNORE：同一天同一小时只记录一次
      db.run(
        `INSERT OR IGNORE INTO activity_hourly (date, hour, updated_at)
         VALUES (?, ?, ?)`,
        [dateStr, hour, now],
      )
      markDirty()
    } catch {
      // 表可能不存在（首次运行），静默忽略
    }
  }

  /**
   * 获取活跃时段统计。
   * 基于最近 ACTIVITY_WINDOW_DAYS 天的数据，按小时统计活跃天数。
   */
  getActivityStats(): ActivityHourStat[] {
    try {
      const db = getRawDb()
      const cutoff = Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000

      const result = db.exec(
        `SELECT hour, COUNT(DISTINCT date) AS active_days, COUNT(*) AS total_interactions
         FROM activity_hourly
         WHERE updated_at >= ?
         GROUP BY hour
         ORDER BY active_days DESC, total_interactions DESC`,
        [cutoff],
      )

      if (!result || result.length === 0) return []

      const columns = result[0].columns
      return result[0].values.map((v: any[]) => {
        const obj: any = {}
        for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
        return {
          hour: obj.hour,
          activeDays: obj.active_days,
          totalInteractions: obj.total_interactions,
        } as ActivityHourStat
      })
    } catch {
      return []
    }
  }

  /**
   * 获取当前小时在活跃窗口中的统计信息（用于调试/监控）。
   */
  getCurrentHourActivity(): { activeDays: number; isActivePeriod: boolean } {
    const currentHour = new Date().getHours()
    const stats = this.getActivityStats()
    const stat = stats.find((s) => s.hour === currentHour)
    return {
      activeDays: stat?.activeDays ?? 0,
      isActivePeriod: (stat?.activeDays ?? 0) >= HIGH_FREQUENCY_DAY_THRESHOLD,
    }
  }

  /**
   * 预测下一个最可能活跃的时段。
   * 策略：
   * 1. 统计过去 ACTIVITY_WINDOW_DAYS 天中每小时活跃的天数
   * 2. 过滤出活跃天数 >= HIGH_FREQUENCY_DAY_THRESHOLD 的小时
   * 3. 从当前时间往后找最近的一个预测活跃小时
   * 4. 如果没有找到，返回 null（不进行预加载）
   */
  predictNextActivePeriod(): { hour: number; daysActive: number } | null {
    const stats = this.getActivityStats()

    // 数据量不足时不预测
    const totalDays = this.getTotalDaysWithData()
    if (totalDays < MIN_ACTIVITY_DAYS) {
      return null
    }

    // 过滤出高频活跃时段
    const activePeriods = stats.filter((s) => s.activeDays >= HIGH_FREQUENCY_DAY_THRESHOLD).sort((a, b) => b.activeDays - a.activeDays)

    if (activePeriods.length === 0) return null

    // 从当前小时往后找最近的高频活跃小时
    const currentHour = new Date().getHours()

    // 先找今天还没到的活跃小时
    const upcoming = activePeriods.filter((p) => p.hour > currentHour).sort((a, b) => a.hour - b.hour)

    if (upcoming.length > 0) {
      return { hour: upcoming[0].hour, daysActive: upcoming[0].activeDays }
    }

    // 如果今天没有即将到来的活跃小时，取明天最早的高频活跃小时
    if (activePeriods.length > 0) {
      const earliest = activePeriods.reduce((a, b) => (a.hour < b.hour ? a : b))
      return { hour: earliest.hour, daysActive: earliest.activeDays }
    }

    return null
  }

  /** 获取有数据的天数 */
  private getTotalDaysWithData(): number {
    try {
      const db = getRawDb()
      const result = db.exec(
        `SELECT COUNT(DISTINCT date) AS cnt FROM activity_hourly
         WHERE updated_at >= ?`,
        [Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000],
      )
      if (result && result.length > 0) {
        return Number(result[0].values[0]?.[0] || 0)
      }
    } catch {
      // ignore
    }
    return 0
  }

  /**
   * 更新预加载调度。
   * 重新预测下一个活跃时段，并安排预加载定时器。
   * 如果已有定时器且目标时段不变，不做重复调度。
   */
  updatePreloadSchedule(): void {
    const predicted = this.predictNextActivePeriod()
    if (!predicted) {
      // 没有预测，取消现有调度
      if (this.preloadTimer) {
        clearTimeout(this.preloadTimer)
        this.preloadTimer = null
      }
      return
    }

    // 计算到预测时段开始的时间
    const now = new Date()
    const currentHour = now.getHours()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()

    // 时间段开始的分钟数
    let targetMinutes: number

    if (predicted.hour > currentHour) {
      // 今天晚些时候
      targetMinutes = predicted.hour * 60
    } else {
      // 明天
      targetMinutes = predicted.hour * 60 + 24 * 60
    }

    // 预加载提前量（分钟）
    const targetTimeMinutes = targetMinutes - PRELOAD_AHEAD_MINUTES
    const delayMs = (targetTimeMinutes - currentMinutes) * 60 * 1000

    // 如果延迟时间小于 1 分钟，跳过（已经在这个时段了）
    if (delayMs < 60 * 1000) {
      // 已经即将进入预测时段，立即填充缓存
      this.populatePreloadCache()
      return
    }

    // 如果延迟时间超过 24 小时，说明预测的是明天的时段且今天已过
    // 这种情况由 tick() 定期检查更新
    if (delayMs > 24 * 60 * 60 * 1000) {
      return
    }

    // 取消现有定时器并设置新定时器
    if (this.preloadTimer) {
      clearTimeout(this.preloadTimer)
    }

    this.preloadTimer = setTimeout(() => {
      this.populatePreloadCache()
      // 缓存填充后清除定时器引用
      this.preloadTimer = null
    }, delayMs)

    log('DEBUG', 'memory_sleep_preload_scheduled', {
      predictedHour: predicted.hour,
      daysActive: predicted.daysActive,
      delayMs: Math.round(delayMs / 1000) + 's',
      triggerTime: new Date(Date.now() + delayMs).toISOString(),
    })
  }

  /**
   * 填充预加载缓存。
   * 从当前活跃记忆中选择高频条目加载到缓存中。
   */
  private populatePreloadCache(): void {
    const now = Date.now()
    const currentHour = new Date().getHours()
    const entries = this.getEntries()

    // 获取当前时段的高频记忆（永久层和高行为分条目）
    const highFreqEntries = entries
      .filter((e) => e.type === 'user_fact' && (e.tier === 'permanent' || e.behaviorScore >= 0.5))
      .sort((a, b) => b.behaviorScore - a.behaviorScore)
      .slice(0, PRELOAD_CACHE_MAX)

    this.preloadCache = highFreqEntries.map((e) => ({
      id: e.id,
      content: e.content,
      topics: e.topics || [],
      behaviorScore: e.behaviorScore,
      cachedAt: now,
    }))
    this.cacheCreatedAt = now

    log('INFO', 'memory_sleep_preload_cache_populated', {
      count: this.preloadCache.length,
      hour: currentHour,
    })
  }

  /**
   * 获取预加载缓存上下文（用于注入 system prompt 或 context）。
   * 如果缓存存在且未过期，返回格式化后的缓存内容；
   * 否则返回空字符串。
   */
  getPreloadCacheContext(): string {
    // 缓存不存在或已过期
    if (!this.preloadCache || this.preloadCache.length === 0) return ''
    if (Date.now() - this.cacheCreatedAt > PRELOAD_CACHE_TTL_MS) {
      this.preloadCache = null
      return ''
    }

    const parts = ['---', '【预加载记忆】根据你的活跃时段预测，以下记忆已预先加载到缓存：']
    for (const entry of this.preloadCache) {
      parts.push('- ' + entry.content)
    }
    parts.push('---')
    return parts.join('\n')
  }

  /**
   * 清除预加载缓存（在缓存过期或用户会话结束时调用）。
   */
  clearPreloadCache(): void {
    this.preloadCache = null
    this.cacheCreatedAt = 0
  }

  /**
   * 获取当前预加载缓存的统计信息（用于调试）。
   */
  getPreloadCacheStats(): {
    size: number
    age: number
    expired: boolean
    predictedNextActivePeriod: { hour: number; daysActive: number } | null
  } {
    const now = Date.now()
    return {
      size: this.preloadCache?.length ?? 0,
      age: this.preloadCache ? now - this.cacheCreatedAt : 0,
      expired: this.preloadCache ? now - this.cacheCreatedAt > PRELOAD_CACHE_TTL_MS : true,
      predictedNextActivePeriod: this.predictNextActivePeriod(),
    }
  }
}
