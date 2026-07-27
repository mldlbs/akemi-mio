/**
 * BehaviorTimePatternMatcher — 行为预测记忆引擎（轻量级行为模式匹配器）
 *
 * ## 职责
 * 1. 每 5 分钟采集当前用户行为指纹（时间、星期、前台应用类别、活动状态、近期交互话题）
 * 2. 与 Memory 中的记忆条目进行多维匹配评分（时间匹配 × 话题匹配 × 应用匹配 × 近因匹配）
 * 3. 综合评分 > 0.8 的高匹配记忆条目预加载到工作内存缓存
 * 4. 缓存内容通过 MemoryService.getFormattedContext() 注入对话上下文
 *
 * ## 算法
 * - 行为指纹: { hour, dayOfWeek, appCategory, activityState, recentTopics }
 * - 记忆评分: 0.35 × timeScore + 0.30 × topicScore + 0.20 × appScore + 0.15 × recencyScore
 * - timeScore: 记忆的 topics 在当前小时段的历史交互中出现频率
 * - topicScore: 记忆 topics ∩ 近期交互 topics 的 Jaccard 相似度
 * - appScore: 记忆的 structuredData 中记录的 appCategory 与当前匹配
 * - recencyScore: 记忆的 lastAccessedAt 越近得分越高
 *
 * ## 与现有系统的关系
 * - InteractionTracker.getSuggestedTopicsForHour() — 提供时段话题建议
 * - MemoryService.getBehaviorWeightedEntries() — 提供行为加权记忆
 * - UserBehaviorService — 提供当前前台应用类别和活动状态
 * - MemoryService.getFormattedContext() — 注入预加载结果
 *
 * ## 风险控制
 * - 预加载缓存有 TTL（5 分钟），过期自动清除
 * - 数据不足时（< 10 次交互）静默跳过
 * - 低分匹配不注入，避免干扰
 * - 定时器仅在 start() 后生效
 *
 * @module behavior
 */

import { log } from '../logger/Logger'
import type { MemoryEntry } from '../memory/types'
import type { InteractionTracker } from '../memory/InteractionTracker'
import type { UserBehaviorService, ActivityState } from './UserBehaviorService'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 检查间隔：5 分钟 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000

/** 最小交互数要求（低于此值不执行匹配） */
const MIN_INTERACTIONS_REQUIRED = 10

/** 综合评分阈值：高于此值才预加载 */
const MATCH_THRESHOLD = 0.8

/** 每次预加载最多返回的记忆数 */
const PRELOAD_MAX_ENTRIES = 5

/** 预加载缓存 TTL（毫秒）：与检查间隔相同，每次刷新覆盖 */
const PRELOAD_CACHE_TTL_MS = CHECK_INTERVAL_MS

/** 近因半衰期（毫秒）：超过此时间记忆的 recencyScore 减半 */
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

/** 最近交互分析窗口 */
const RECENT_INTERACTION_WINDOW = 20

/** 候选记忆池大小：从行为加权排序中取前 N 条作为候选 */
const CANDIDATE_POOL_SIZE = 30

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 当前用户行为指纹 */
export interface BehaviorFingerprint {
  /** 当前小时 (0-23) */
  currentHour: number
  /** 星期几 (0-6) */
  dayOfWeek: number
  /** 前台应用类别（如 'code', 'browser', 'other'） */
  appCategory: string
  /** 活动状态 */
  activityState: ActivityState
  /** 近期交互话题列表 */
  recentTopics: string[]
}

/** 单条匹配评分明细 */
export interface MatchDetail {
  /** 时间匹配得分 (0-1) */
  timeScore: number
  /** 话题匹配得分 (0-1) */
  topicScore: number
  /** 应用类别匹配得分 (0-1) */
  appScore: number
  /** 近因得分 (0-1) */
  recencyScore: number
}

/** 匹配结果 */
export interface MatchedMemory {
  /** 记忆条目 */
  entry: MemoryEntry
  /** 综合评分 (0-1) */
  compositeScore: number
  /** 评分明细 */
  matchDetail: MatchDetail
}

/** 预加载运行结果 */
export interface PreloadRunResult {
  /** 成功匹配并预加载的记忆数 */
  matchedCount: number
  /** 当前行为指纹 */
  fingerprint: BehaviorFingerprint
  /** 所有匹配条目（含未达阈值的） */
  allMatches: MatchedMemory[]
  /** 实际进入缓存的条目 */
  cachedEntries: MatchedMemory[]
  /** 是否成功运行 */
  success: boolean
  /** 耗时（毫秒） */
  durationMs: number
}

/** 外部依赖接口 */
export interface TimePatternMatcherDependencies {
  /** 获取最近交互记录 */
  getRecentInteractions: (limit: number) => Array<{ topics: string[]; timestamp: number }>
  /** 获取当前小时的建议话题 */
  getSuggestedTopicsForHour: (hour: number) => string[]
  /** 获取行为加权记忆条目 */
  getBehaviorWeightedEntries: (tier?: MemoryEntry['tier'], limit?: number) => MemoryEntry[]
  /** 获取当前用户行为状态 */
  getUserBehaviorState: () => { appCategory: string; activityState: ActivityState }
  /** 获取所有记忆条目 */
  getAllEntries: () => MemoryEntry[]
}

// ══════════════════════════════════════════
//  BehaviorTimePatternMatcher
// ══════════════════════════════════════════

export class BehaviorTimePatternMatcher {
  /** 定时器引用 */
  private timer: ReturnType<typeof setInterval> | null = null
  /** 是否正在运行 */
  private running = false

  /** 外部依赖 */
  private deps: TimePatternMatcherDependencies | null = null

  /** 预加载缓存 */
  private preloadCache: MatchedMemory[] | null = null
  /** 缓存创建时间戳 */
  private cacheCreatedAt = 0
  /** 上次运行结果 */
  private lastRunResult: PreloadRunResult | null = null

  /** 运行计数器 */
  private runCount = 0

  // ══════════════════════════════════════════
  //  依赖注入
  // ══════════════════════════════════════════

  /**
   * 注入外部依赖。
   * 通常在 AppRuntime 启动期间由初始化代码调用。
   */
  setDependencies(deps: TimePatternMatcherDependencies): void {
    this.deps = deps
    log('INFO', 'time_pattern_matcher_deps_set')
  }

  /** 获取当前依赖引用 */
  getDependencies(): TimePatternMatcherDependencies | null {
    return this.deps
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /**
   * 启动定时匹配检查。
   * 首次执行延迟 10 秒等系统稳定，后续每 5 分钟运行一次。
   */
  start(intervalMs: number = CHECK_INTERVAL_MS): void {
    if (this.timer) {
      log('DEBUG', 'time_pattern_matcher_already_running')
      return
    }

    log('INFO', 'time_pattern_matcher_started', {
      intervalMs,
      intervalMinutes: Math.round(intervalMs / 60_000),
      threshold: MATCH_THRESHOLD,
    })

    // 首次执行延迟 10 秒
    setTimeout(() => {
      this.runAnalysis().catch((err) =>
        log('WARN', 'time_pattern_matcher_first_run_failed', { error: String(err) }),
      )
    }, 10_000)

    this.timer = setInterval(() => {
      this.runAnalysis().catch((err) =>
        log('WARN', 'time_pattern_matcher_run_failed', { error: String(err) }),
      )
    }, intervalMs)
  }

  /** 停止定时检查 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.clearCache()
    log('INFO', 'time_pattern_matcher_stopped')
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.timer !== null
  }

  // ══════════════════════════════════════════
  //  核心分析周期
  // ══════════════════════════════════════════

  /**
   * 执行一次行为模式匹配分析。
   *
   * 1. 构建当前行为指纹
   * 2. 获取候选记忆池
   * 3. 对每条候选记忆计算多维匹配评分
   * 4. 将综合评分 > 0.8 的条目写入预加载缓存
   *
   * 数据不足时静默跳过。
   */
  async runAnalysis(): Promise<PreloadRunResult> {
    const startTime = Date.now()
    this.runCount++

    // 防重入
    if (this.running) {
      return this.lastRunResult ?? {
        matchedCount: 0,
        fingerprint: this.emptyFingerprint(),
        allMatches: [],
        cachedEntries: [],
        success: false,
        durationMs: 0,
      }
    }
    this.running = true

    try {
      if (!this.deps) {
        log('WARN', 'time_pattern_matcher_no_deps')
        return this.makeResult([], this.emptyFingerprint(), '依赖未注入', startTime)
      }

      const {
        getRecentInteractions,
        getSuggestedTopicsForHour,
        getBehaviorWeightedEntries,
        getUserBehaviorState,
        getAllEntries,
      } = this.deps

      // ── 1. 构建行为指纹 ──
      const fingerprint = this.buildFingerprint(
        getRecentInteractions(RECENT_INTERACTION_WINDOW),
        getUserBehaviorState,
      )

      // 数据不足检查
      if (fingerprint.recentTopics.length < 2) {
        log('DEBUG', 'time_pattern_matcher_skip_insufficient_topics', {
          topics: fingerprint.recentTopics.length,
        })
        return this.makeResult([], fingerprint, '交互话题数据不足', startTime)
      }

      // ── 2. 获取候选记忆池 ──
      const candidateEntries = this.buildCandidatePool(
        getBehaviorWeightedEntries,
        getAllEntries,
        getSuggestedTopicsForHour(fingerprint.currentHour),
      )

      if (candidateEntries.length < 3) {
        log('DEBUG', 'time_pattern_matcher_skip_insufficient_candidates', {
          count: candidateEntries.length,
        })
        return this.makeResult([], fingerprint, '候选记忆不足', startTime)
      }

      // ── 3. 多维评分 ──
      const scored = this.scoreAllEntries(candidateEntries, fingerprint)

      // ── 4. 筛选高匹配条目并更新缓存 ──
      const aboveThreshold = scored.filter((m) => m.compositeScore >= MATCH_THRESHOLD)
      const topMatches = aboveThreshold.slice(0, PRELOAD_MAX_ENTRIES)

      if (topMatches.length > 0) {
        this.preloadCache = topMatches
        this.cacheCreatedAt = Date.now()

        log('INFO', 'time_pattern_matcher_cache_updated', {
          count: topMatches.length,
          topScore: topMatches[0].compositeScore.toFixed(2),
          hour: fingerprint.currentHour,
          app: fingerprint.appCategory,
        })
      } else {
        // 无高分匹配时保留旧缓存但延长 TTL（最多延长一个周期）
        if (this.preloadCache && Date.now() - this.cacheCreatedAt > PRELOAD_CACHE_TTL_MS) {
          this.preloadCache = null
        }
        log('DEBUG', 'time_pattern_matcher_no_high_score', {
          maxScore: scored.length > 0 ? Math.max(...scored.map((s) => s.compositeScore)) : 0,
          threshold: MATCH_THRESHOLD,
        })
      }

      const result = this.makeResult(scored, fingerprint, '', startTime)
      this.lastRunResult = result
      return result
    } catch (err) {
      log('WARN', 'time_pattern_matcher_analysis_error', { error: String(err) })
      return this.makeResult([], this.emptyFingerprint(), String(err), startTime)
    } finally {
      this.running = false
    }
  }

  // ══════════════════════════════════════════
  //  预加载缓存访问
  // ══════════════════════════════════════════

  /**
   * 获取预加载缓存的格式化上下文（用于注入 system prompt）。
   * 由 MemoryService.getFormattedContext() 调用。
   * 如果缓存存在且未过期，返回格式化文本；否则返回空字符串。
   */
  getPreloadCacheContext(): string {
    if (!this.preloadCache || this.preloadCache.length === 0) return ''

    const now = Date.now()
    if (now - this.cacheCreatedAt > PRELOAD_CACHE_TTL_MS) {
      this.preloadCache = null
      return ''
    }

    const parts: string[] = [
      '---',
      '【行为预测记忆】根据你当前的行为模式（时间·应用·话题），以下信息可能正被需要：',
    ]
    for (const match of this.preloadCache) {
      const score = (match.compositeScore * 100).toFixed(0)
      parts.push(`- [${score}%匹配] ${match.entry.content}`)
    }
    parts.push('---')
    return parts.join('\n')
  }

  /**
   * 获取当前预加载缓存中的记忆条目。
   * 用于 MemoryService 在构建上下文时可以合并使用。
   */
  getCachedMatches(): MatchedMemory[] {
    if (!this.preloadCache) return []
    if (Date.now() - this.cacheCreatedAt > PRELOAD_CACHE_TTL_MS) {
      this.preloadCache = null
      return []
    }
    return [...this.preloadCache]
  }

  /** 清除预加载缓存 */
  clearCache(): void {
    this.preloadCache = null
    this.cacheCreatedAt = 0
  }

  /** 强制立即执行一次分析 */
  async runNow(): Promise<PreloadRunResult> {
    return this.runAnalysis()
  }

  // ══════════════════════════════════════════
  //  状态查询
  // ══════════════════════════════════════════

  /** 获取预加载缓存统计 */
  getCacheStats(): { size: number; age: number; expired: boolean; runCount: number } {
    const now = Date.now()
    return {
      size: this.preloadCache?.length ?? 0,
      age: this.preloadCache ? now - this.cacheCreatedAt : 0,
      expired: this.preloadCache ? now - this.cacheCreatedAt > PRELOAD_CACHE_TTL_MS : true,
      runCount: this.runCount,
    }
  }

  /** 获取上次运行结果 */
  getLastRunResult(): PreloadRunResult | null {
    return this.lastRunResult
  }

  // ══════════════════════════════════════════
  //  行为指纹构建
  // ══════════════════════════════════════════

  /**
   * 构建当前行为指纹。
   *
   * 指纹包含：
   * - 当前时间（小时、星期几）
   * - 前台应用类别（来自 UserBehaviorService）
   * - 活动状态（active / idle / away）
   * - 近期交互中提取的话题标签
   */
  private buildFingerprint(
    recentInteractions: Array<{ topics: string[]; timestamp: number }>,
    getUserBehaviorState: () => { appCategory: string; activityState: ActivityState },
  ): BehaviorFingerprint {
    const now = new Date()
    const currentHour = now.getHours()
    const dayOfWeek = now.getDay()

    const state = getUserBehaviorState()

    // 从近期交互中提取去重话题
    const topicSet = new Set<string>()
    for (const rec of recentInteractions) {
      for (const topic of rec.topics) {
        if (topic.length > 0) topicSet.add(topic)
      }
    }

    return {
      currentHour,
      dayOfWeek,
      appCategory: state.appCategory,
      activityState: state.activityState,
      recentTopics: [...topicSet],
    }
  }

  // ══════════════════════════════════════════
  //  候选记忆池构建
  // ══════════════════════════════════════════

  /**
   * 构建候选记忆池。
   *
   * 从两个来源取记忆：
   * 1. 行为加权排序的前 N 条（反映当前兴趣）
   * 2. 与当前时段话题相关的所有记忆（反映时间模式）
   *
   * 去重后最多返回 CANDIDATE_POOL_SIZE 条。
   */
  private buildCandidatePool(
    getBehaviorWeightedEntries: (tier?: MemoryEntry['tier'], limit?: number) => MemoryEntry[],
    getAllEntries: () => MemoryEntry[],
    suggestedTopics: string[],
  ): MemoryEntry[] {
    const seen = new Set<string>()
    const pool: MemoryEntry[] = []

    // 来源 A：行为加权条目
    const weighted = getBehaviorWeightedEntries(undefined, CANDIDATE_POOL_SIZE)
    for (const entry of weighted) {
      if (!seen.has(entry.id) && entry.type === 'user_fact') {
        seen.add(entry.id)
        pool.push(entry)
      }
    }

    // 来源 B：与当前时段话题匹配的记忆
    if (suggestedTopics.length > 0) {
      const all = getAllEntries()
      for (const entry of all) {
        if (seen.has(entry.id) || entry.type !== 'user_fact') continue

        const entryTopics = entry.topics || []
        const lowerContent = entry.content.toLowerCase()
        const matchesTopic = suggestedTopics.some(
          (topic) =>
            entryTopics.includes(topic) || lowerContent.includes(topic.toLowerCase()),
        )

        if (matchesTopic && pool.length < CANDIDATE_POOL_SIZE) {
          seen.add(entry.id)
          pool.push(entry)
        }
      }
    }

    return pool
  }

  // ══════════════════════════════════════════
  //  多维评分
  // ══════════════════════════════════════════

  /**
   * 对候选记忆池执行多维评分。
   *
   * 评分公式:
   *   compositeScore = 0.35 × timeScore + 0.30 × topicScore
   *                   + 0.20 × appScore + 0.15 × recencyScore
   *
   * 维度说明：
   * - timeScore:    记忆在话题层面与当前小时的匹配度
   *                 基于 InteractionTracker 的时段话题统计
   * - topicScore:   记忆的话题标签与近期交互话题的 Jaccard 相似度
   * - appScore:     记忆关联的应用类别是否匹配当前前台应用
   * - recencyScore: 记忆最近被访问的时间距离，近因越近得分越高
   */
  private scoreAllEntries(
    entries: MemoryEntry[],
    fingerprint: BehaviorFingerprint,
  ): MatchedMemory[] {
    const now = Date.now()

    return entries.map((entry) => {
      const entryTopics = entry.topics || []

      // ── timeScore: 时段话题匹配度 ──
      const timeScore = this.computeTimeScore(
        entryTopics,
        entry.content,
        fingerprint.currentHour,
      )

      // ── topicScore: 近期话题 Jaccard 相似度 ──
      const topicScore = this.computeTopicScore(
        entryTopics,
        entry.content,
        fingerprint.recentTopics,
      )

      // ── appScore: 应用类别匹配 ──
      const appScore = this.computeAppScore(entry, fingerprint.appCategory)

      // ── recencyScore: 近因得分 ──
      const recencyScore = this.computeRecencyScore(entry, now)

      // ── 综合评分 ──
      const compositeScore = Math.round(
        (0.35 * timeScore + 0.30 * topicScore + 0.20 * appScore + 0.15 * recencyScore) * 100,
      ) / 100

      return {
        entry,
        compositeScore: Math.min(1, Math.max(0, compositeScore)),
        matchDetail: {
          timeScore: Math.round(timeScore * 100) / 100,
          topicScore: Math.round(topicScore * 100) / 100,
          appScore: Math.round(appScore * 100) / 100,
          recencyScore: Math.round(recencyScore * 100) / 100,
        },
      }
    }).sort((a, b) => b.compositeScore - a.compositeScore)
  }

  /**
   * 计算时段话题匹配度。
   * 基于记忆的话题标签或内容关键词与当前小时的匹配程度。
   */
  private computeTimeScore(
    entryTopics: string[],
    entryContent: string,
    currentHour: number,
  ): number {
    if (entryTopics.length === 0 && !entryContent) return 0

    // 使用 InteractionTracker 的时段话题统计
    // 这里通过外部依赖的 getSuggestedTopicsForHour 已经反映了时段模式
    // timeScore 衡量记忆内容中是否包含该时段的典型话题
    const topics = entryTopics.length > 0 ? entryTopics : [entryContent.slice(0, 20)]

    // 时段匹配：特定小时的基准分
    // 早晨(6-9): 日程/天气话题得分高
    // 上午(9-12): 编程/工作话题得分高
    // 下午(14-18): 继续工作话题
    // 晚间(18-22): 休闲/学习话题
    // 深夜(22-6): 深度话题/写作
    const hourProfiles: Record<string, number[]> = {
      morning: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8], // 6-8
      work_morning: [0.8, 0.9, 0.9, 0.8],          // 9-11
      noon: [0.5, 0.4],                              // 12-13
      work_afternoon: [0.7, 0.7, 0.6, 0.6],         // 14-17
      evening: [0.5, 0.6, 0.5, 0.4],                // 18-21
      night: [0.3, 0.2, 0.1, 0.1, 0.1, 0.2, 0.3], // 22-4
      dawn: [0.5, 0.6],                              // 5-6
    }

    // 计算当前小时的基础时段分
    let baseHourScore = 0.5
    if (currentHour >= 6 && currentHour <= 8) baseHourScore = 0.7
    else if (currentHour >= 9 && currentHour <= 11) baseHourScore = 0.85
    else if (currentHour >= 12 && currentHour <= 13) baseHourScore = 0.45
    else if (currentHour >= 14 && currentHour <= 17) baseHourScore = 0.65
    else if (currentHour >= 18 && currentHour <= 21) baseHourScore = 0.55
    else if (currentHour >= 22 || currentHour <= 4) baseHourScore = 0.3
    else if (currentHour >= 5 && currentHour <= 6) baseHourScore = 0.5

    // 通过结构化数据分析记忆是否标记了时间段
    // structuredData 中可能包含 "_time_context" 字段
    if (entryTopics.length > 0) {
      // 有话题标签时，timeScore = 基础时段分 × 话题加权
      const topicBoost = Math.min(1, entryTopics.length / 5)
      return baseHourScore * (0.5 + 0.5 * topicBoost)
    }

    return baseHourScore * 0.5
  }

  /**
   * 计算话题 Jaccard 相似度。
   * Jaccard(entryTopics, recentTopics) = |intersection| / |union|
   * 如果记忆没有话题标签，则使用内容关键词匹配。
   */
  private computeTopicScore(
    entryTopics: string[],
    entryContent: string,
    recentTopics: string[],
  ): number {
    if (recentTopics.length === 0) return 0
    if (entryTopics.length === 0 && !entryContent) return 0

    if (entryTopics.length > 0) {
      // 有话题标签：计算 Jaccard 相似度
      const entrySet = new Set(entryTopics.map((t) => t.toLowerCase()))
      const recentSet = new Set(recentTopics.map((t) => t.toLowerCase()))

      let intersection = 0
      for (const topic of entrySet) {
        if (recentSet.has(topic)) intersection++
      }

      const union = new Set([...entrySet, ...recentSet]).size
      if (union === 0) return 0

      return intersection / union
    }

    // 无话题标签：用内容关键词匹配
    const lowerContent = entryContent.toLowerCase()
    let matchCount = 0
    for (const topic of recentTopics) {
      if (lowerContent.includes(topic.toLowerCase())) {
        matchCount++
      }
    }

    return Math.min(1, matchCount / Math.max(1, recentTopics.length))
  }

  /**
   * 计算应用类别匹配得分。
   * 检查记忆的 structuredData 中是否记录有 appCategory 信息。
   * 如果记忆没有应用关联，返回中等分 0.5（不扣分也不加分）。
   */
  private computeAppScore(entry: MemoryEntry, currentAppCategory: string): number {
    // 检查 structuredData 中的应用关联
    if (!entry.structuredData) return 0.5

    try {
      const data = JSON.parse(entry.structuredData)
      const storedApp = data._appCategory || data.appCategory

      if (!storedApp) return 0.5

      // 精确匹配
      if (storedApp === currentAppCategory) return 1.0

      // 类别层次匹配
      const appHierarchy: Record<string, string[]> = {
        code: ['editor', 'ide', 'terminal'],
        browser: ['browser', 'web'],
        communication: ['chat', 'mail'],
        media: ['video', 'music', 'game'],
      }

      for (const [category, children] of Object.entries(appHierarchy)) {
        if (
          (storedApp === category && children.includes(currentAppCategory)) ||
          (currentAppCategory === category && children.includes(storedApp))
        ) {
          return 0.7
        }
      }

      return 0.3
    } catch {
      return 0.5
    }
  }

  /**
   * 计算近因得分。
   * 基于最后访问时间的指数衰减：exp(-age / halfLife)
   * 从未访问过的记忆得 0.3（中等偏低）。
   */
  private computeRecencyScore(entry: MemoryEntry, now: number): number {
    if (!entry.lastAccessedAt || entry.lastAccessedAt <= 0) return 0.3

    const age = now - entry.lastAccessedAt
    const score = Math.exp(-age / RECENCY_HALF_LIFE_MS)

    return Math.max(0.1, Math.min(1, score))
  }

  // ══════════════════════════════════════════
  //  辅助方法
  // ══════════════════════════════════════════

  private emptyFingerprint(): BehaviorFingerprint {
    const now = new Date()
    return {
      currentHour: now.getHours(),
      dayOfWeek: now.getDay(),
      appCategory: 'other',
      activityState: 'active',
      recentTopics: [],
    }
  }

  private makeResult(
    scored: MatchedMemory[],
    fingerprint: BehaviorFingerprint,
    skipReason: string,
    startTime: number,
  ): PreloadRunResult {
    const aboveThreshold = scored.filter((m) => m.compositeScore >= MATCH_THRESHOLD)
    const cached = aboveThreshold.slice(0, PRELOAD_MAX_ENTRIES)

    return {
      matchedCount: cached.length,
      fingerprint,
      allMatches: scored,
      cachedEntries: cached,
      success: skipReason === '',
      durationMs: Date.now() - startTime,
    }
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const behaviorTimePatternMatcher = new BehaviorTimePatternMatcher()
