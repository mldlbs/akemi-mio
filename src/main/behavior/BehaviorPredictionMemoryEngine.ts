/**
 * BehaviorPredictionMemoryEngine — 行为预测记忆引擎
 *
 * ## 职责
 * 1. 每 5 分钟分析 UserBehavior 的最近交互记录和行为状态
 * 2. 将当前行为上下文（应用类别、时段、活跃话题）与 Memory 中的时间戳标签匹配
 * 3. 将匹配度 >80% 的记忆片段提前加载到工作内存缓冲区
 * 4. AgentService 在下一次构建 context 时消费缓冲区内容
 *
 * ## 匹配算法
 * - 时段匹配：按当前 hour + dayOfWeek 与记忆条目的活跃时段分布对比
 * - 应用匹配：当前前台应用类别与记忆相关话题的匹配度
 * - 话题匹配：最近交互的话题标签与记忆条目的 topics 数组的 Jaccard 相似度
 * - 综合评分 = 时段匹配 × 0.35 + 应用匹配 × 0.30 + 话题匹配 × 0.35
 * - 综合评分 > 阈值（默认 0.80）时，记忆片段被加载到工作内存
 *
 * ## 与现有系统的关系
 * - BehaviorPredictiveMemoryPrewarmer → 会话启动预热（互补，此引擎持续运行）
 * - BehaviorPeriodicPredictor → 时段级查询意图预测（互补，此引擎聚焦记忆条目）
 * - UserBehaviorService → 提供实时行为状态
 * - MemoryService → 提供记忆条目和交互记录
 *
 * ## 资源保护
 * - 5 分钟固定检查间隔，避免过度扫描
 * - 内存不足时静默跳过（少于 10 条记忆或少于 5 次交互）
 * - 预加载缓冲区上限 10 条，LRU 淘汰
 * - 低置信度匹配不进入缓冲区
 *
 * @module behavior
 */

import { log } from '../logger/Logger'
import type { MemoryEntry, InteractionRecord } from '../memory/types'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 检查间隔（毫秒）：每 5 分钟 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000

/** 综合评分阈值：高于此值才进入预加载缓冲区 */
const MATCH_THRESHOLD = 0.80

/** 预加载缓冲区最大条目数 */
const PRELOAD_BUFFER_MAX = 10

/** 最小记忆条目数（低于此值不执行匹配） */
const MIN_MEMORIES_REQUIRED = 10

/** 最小交互记录数（低于此值不执行匹配） */
const MIN_INTERACTIONS_REQUIRED = 5

/** 最近交互话题分析窗口 */
const TOPIC_ANALYSIS_WINDOW = 20

/** 时段匹配：小时桶数 */
const HOUR_BUCKETS = 24

/** 时段匹配：一周天数 */
const DAYS_OF_WEEK = 7

/** 时段匹配：活跃时段判定最小出现次数 */
const MIN_HIT_COUNT_FOR_PEAK = 2

/** 话题匹配：Jaccard 相似度计算中的话题来源 — 最近交互的话题标签 */
const MAX_RECENT_TOPICS = 10

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 行为上下文快照 — 当前用户状态 */
export interface BehaviorContext {
  /** 当前小时 (0-23) */
  hour: number
  /** 星期几 (0=周日, 6=周六) */
  dayOfWeek: number
  /** 当前前台应用类别 */
  appCategory: string
  /** 当前活动状态 */
  activityState: 'active' | 'idle' | 'away'
  /** 距上次活动的空闲时间（毫秒） */
  idleTimeMs: number
}

/** 单条记忆的匹配评分详情 */
export interface MatchScoreDetail {
  /** 时段匹配得分 (0-0.35) */
  timeScore: number
  /** 应用匹配得分 (0-0.30) */
  appScore: number
  /** 话题匹配得分 (0-0.35) */
  topicScore: number
  /** 综合评分 (0-1) */
  combined: number
}

/** 预加载缓冲区条目 */
export interface PreloadBufferEntry {
  /** 记忆条目 */
  entry: MemoryEntry
  /** 匹配评分详情 */
  scoreDetail: MatchScoreDetail
  /** 进入缓冲区的时间戳 */
  loadedAt: number
}

/** 内存引擎状态快照 */
export interface EngineStats {
  /** 缓冲区大小 */
  bufferSize: number
  /** 自启动以来已执行的检查次数 */
  checkCount: number
  /** 自启动以来发现的匹配记忆数 */
  totalMatchesFound: number
  /** 定时器是否在运行 */
  isRunning: boolean
  /** 上次检查的时间戳 */
  lastCheckTime: number
}

/** 外部依赖接口 */
export interface EngineDependencies {
  /** 获取当前行为上下文 */
  getBehaviorContext: () => BehaviorContext
  /** 获取最近交互记录（行为状态机的交互记录） */
  getRecentInteractions: (limit: number) => InteractionRecord[]
  /** 获取最近 N 次交互的话题标签 */
  getRecentInteractionTopics: (limit: number) => string[]
  /** 获取所有记忆条目 */
  getMemoryEntries: () => MemoryEntry[]
  /** 获取行为加权后的记忆条目（候选池） */
  getBehaviorWeightedEntries: (tier?: string, limit?: number) => MemoryEntry[]
}

// ══════════════════════════════════════════
//  应用类别 → 相关话题映射表
// ══════════════════════════════════════════

const APP_TOPIC_MAP: Record<string, string[]> = {
  code: ['编程', '代码', '开发', '调试', '重构', '部署', '算法', '编译'],
  browser: ['搜索', '浏览', '新闻', '阅读', '研究', '文档'],
  media: ['音乐', '视频', '媒体', '娱乐'],
  communication: ['通讯', '聊天', '消息', '邮件'],
  terminal: ['终端', '命令行', '运维', '部署', '配置'],
  writing: ['写作', '文档', '编辑', '创作'],
  design: ['设计', '图片', 'UI', '视觉'],
  game: ['游戏'],
  productivity: ['日程', '待办', '笔记', '效率'],
  other: [],
}

// ══════════════════════════════════════════
//  BehaviorPredictionMemoryEngine
// ══════════════════════════════════════════

export class BehaviorPredictionMemoryEngine {
  private deps: EngineDependencies | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  /** 预加载缓冲区（LRU，按 loadedAt 降序） */
  private preloadBuffer: PreloadBufferEntry[] = []

  /** 引擎统计 */
  private checkCount = 0
  private totalMatchesFound = 0
  private lastCheckTime = 0
  private running = false

  // ══════════════════════════════════════════
  //  依赖注入
  // ══════════════════════════════════════════

  setDependencies(deps: EngineDependencies): void {
    this.deps = deps
    log('INFO', 'prediction_memory_engine_deps_set')
  }

  getDependencies(): EngineDependencies | null {
    return this.deps
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /**
   * 启动定时检查。
   * 首次执行延迟 30 秒等待系统稳定，之后每 5 分钟执行一次。
   */
  start(): void {
    if (this.timer) return

    log('INFO', 'prediction_memory_engine_started', {
      intervalMs: CHECK_INTERVAL_MS,
      intervalMin: CHECK_INTERVAL_MS / 60_000,
      threshold: MATCH_THRESHOLD,
    })

    // 首次执行延迟 30 秒
    setTimeout(() => {
      this.checkAndPreload().catch((err) =>
        log('WARN', 'prediction_memory_engine_first_check_failed', { error: String(err) }),
      )
    }, 30_000)

    this.timer = setInterval(() => {
      this.checkAndPreload().catch((err) =>
        log('WARN', 'prediction_memory_engine_check_failed', { error: String(err) }),
      )
    }, CHECK_INTERVAL_MS)
  }

  /** 停止定时检查 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    log('INFO', 'prediction_memory_engine_stopped')
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.timer !== null
  }

  // ══════════════════════════════════════════
  //  核心检查周期
  // ══════════════════════════════════════════

  /**
   * 执行一次检查 + 预加载周期：
   * 1. 获取当前行为上下文
   * 2. 获取最近交互话题
   * 3. 获取记忆条目候选池
   * 4. 对每条记忆计算综合匹配评分
   * 5. 评分 > 阈值的记忆进入预加载缓冲区
   */
  async checkAndPreload(): Promise<void> {
    if (this.running) return
    this.running = true
    this.lastCheckTime = Date.now()

    try {
      // 1. 依赖检查
      if (!this.deps) {
        log('DEBUG', 'prediction_memory_engine_no_deps')
        return
      }

      const {
        getBehaviorContext,
        getRecentInteractionTopics,
        getMemoryEntries,
        getBehaviorWeightedEntries,
      } = this.deps

      // 2. 获取当前行为上下文
      const behaviorCtx = getBehaviorContext()
      this.checkCount++

      // 3. 获取候选记忆和最近话题
      const allEntries = getMemoryEntries()
      if (allEntries.length < MIN_MEMORIES_REQUIRED) {
        log('DEBUG', 'prediction_memory_engine_insufficient_memories', {
          count: allEntries.length,
          minRequired: MIN_MEMORIES_REQUIRED,
        })
        return
      }

      const recentTopics = getRecentInteractionTopics(TOPIC_ANALYSIS_WINDOW)
      if (recentTopics.length < 1) {
        log('DEBUG', 'prediction_memory_engine_no_recent_topics')
        // 没有话题也可以继续，时段和应用匹配仍可工作
      }

      // 使用行为加权条目作为候选池，回退到所有条目
      const candidates = getBehaviorWeightedEntries(undefined, 30)
      const candidateSet = candidates.length > 0 ? candidates : allEntries

      // 4. 对每条候选记忆计算评分
      const scoredEntries: Array<{
        entry: MemoryEntry
        scoreDetail: MatchScoreDetail
      }> = []

      for (const entry of candidateSet) {
        const scoreDetail = this.computeMatchScore(entry, behaviorCtx, recentTopics)
        if (scoreDetail.combined >= MATCH_THRESHOLD) {
          scoredEntries.push({ entry, scoreDetail })
        }
      }

      // 5. 按综合评分降序排列，更新缓冲区
      scoredEntries.sort((a, b) => b.scoreDetail.combined - a.scoreDetail.combined)

      // 更新缓冲区（LRU 替换）
      this.updatePreloadBuffer(scoredEntries)

      if (scoredEntries.length > 0) {
        this.totalMatchesFound += scoredEntries.length
        log('INFO', 'prediction_memory_engine_matches_found', {
          matches: scoredEntries.length,
          bufferSize: this.preloadBuffer.length,
          topScore: scoredEntries[0].scoreDetail.combined.toFixed(3),
          appCategory: behaviorCtx.appCategory,
          hour: behaviorCtx.hour,
        })
      } else {
        log('DEBUG', 'prediction_memory_engine_no_matches')
      }
    } catch (err) {
      log('WARN', 'prediction_memory_engine_check_error', { error: String(err) })
    } finally {
      this.running = false
    }
  }

  // ══════════════════════════════════════════
  //  匹配评分引擎
  // ══════════════════════════════════════════

  /**
   * 计算一条记忆条目与当前行为上下文的综合匹配评分。
   *
   * 评分公式：
   *   combined = timeScore × 0.35 + appScore × 0.30 + topicScore × 0.35
   *
   * 其中各子评分归一化到 [0, 1]。
   */
  private computeMatchScore(
    entry: MemoryEntry,
    ctx: BehaviorContext,
    recentTopics: string[],
  ): MatchScoreDetail {
    const timeScore = this.computeTimeMatch(entry, ctx)
    const appScore = this.computeAppMatch(entry, ctx)
    const topicScore = this.computeTopicMatch(entry, recentTopics)

    const combined = Math.min(1, Math.round(
      (timeScore * 0.35 + appScore * 0.30 + topicScore * 0.35) * 1000,
    ) / 1000)

    return { timeScore, appScore, topicScore, combined }
  }

  /**
   * 时段匹配：记忆条目的活跃时段模式是否与当前时间一致。
   *
   * 通过分析记忆的 createdAt、updatedAt、lastAccessedAt 时间戳，
   * 构建 (hour, dayOfWeek) 活跃频次分布。当前时段命中频次越高得分越高。
   */
  private computeTimeMatch(entry: MemoryEntry, ctx: BehaviorContext): number {
    const timestamps = [
      entry.createdAt,
      entry.updatedAt,
      entry.lastAccessedAt,
    ].filter((t) => t > 0)

    if (timestamps.length === 0) return 0

    // 统计每个 (hour, dayOfWeek) 桶的出现次数
    const bucketMap = new Map<string, number>()
    for (const ts of timestamps) {
      const d = new Date(ts)
      const h = d.getHours()
      const dow = d.getDay()
      const key = `${h}:${dow}`
      bucketMap.set(key, (bucketMap.get(key) ?? 0) + 1)
    }

    const currentKey = `${ctx.hour}:${ctx.dayOfWeek}`
    const currentHits = bucketMap.get(currentKey) ?? 0

    // 相邻时段也给予部分得分（当前小时前后1小时 + 同一天）
    let adjacentHits = 0
    for (const [key, count] of bucketMap) {
      if (key === currentKey) continue
      const [hStr, dowStr] = key.split(':')
      const h = parseInt(hStr, 10)
      const dow = parseInt(dowStr, 10)
      // 同一天，时差 <= 2 小时
      if (dow === ctx.dayOfWeek && Math.abs(h - ctx.hour) <= 2) {
        adjacentHits += count * 0.5 // 相邻时段权重减半
      }
    }

    const totalHits = currentHits + adjacentHits
    if (totalHits === 0) return 0

    // 如果当前时段有直接命中，给予高基础分
    // maxHits 用于归一化（最多 3 个时间戳，每个算当前或相邻最多 1+2*0.5=2）
    const maxPossibleHits = timestamps.length
    const raw = Math.min(totalHits / Math.max(maxPossibleHits * 0.6, 1), 1)
    // 如果有直接命中（currentHits > 0），额外奖励 0.1
    const bonus = currentHits > 0 ? 0.1 : 0
    return Math.min(raw + bonus, 1)
  }

  /**
   * 应用匹配：当前前台应用类别与记忆条目的 topics 是否相关。
   *
   * 使用 APP_TOPIC_MAP 将 appCategory 映射到相关话题集合，
   * 检查记忆条目的 topics 是否包含这些话题。
   */
  private computeAppMatch(entry: MemoryEntry, ctx: BehaviorContext): number {
    const entryTopics = entry.topics ?? []
    if (entryTopics.length === 0) return 0

    const appTopics = APP_TOPIC_MAP[ctx.appCategory] ?? []
    if (appTopics.length === 0) return 0

    // 计算 Jaccard 相似度
    const entryTopicSet = new Set(entryTopics.map((t) => t.toLowerCase()))
    const appTopicSet = new Set(appTopics.map((t) => t.toLowerCase()))

    let intersection = 0
    for (const topic of entryTopicSet) {
      if (appTopicSet.has(topic)) {
        intersection++
      }
    }

    if (intersection === 0) return 0

    const union = new Set([...entryTopicSet, ...appTopicSet]).size
    return intersection / union
  }

  /**
   * 话题匹配：最近交互的话题标签与记忆条目的 topics 的 Jaccard 相似度。
   */
  private computeTopicMatch(entry: MemoryEntry, recentTopics: string[]): number {
    const entryTopics = entry.topics ?? []
    if (entryTopics.length === 0 || recentTopics.length === 0) return 0

    const entrySet = new Set(entryTopics.map((t) => t.toLowerCase()))
    const recentSet = new Set(recentTopics.map((t) => t.toLowerCase()))

    let intersection = 0
    for (const topic of entrySet) {
      if (recentSet.has(topic)) {
        intersection++
      }
    }

    if (intersection === 0) return 0

    const union = new Set([...entrySet, ...recentSet]).size
    return intersection / union
  }

  // ══════════════════════════════════════════
  //  预加载缓冲区管理
  // ══════════════════════════════════════════

  /**
   * 更新预加载缓冲区。
   * 新匹配按评分插入，超出上限时淘汰最旧条目（LRU）。
   */
  private updatePreloadBuffer(
    newMatches: Array<{ entry: MemoryEntry; scoreDetail: MatchScoreDetail }>,
  ): void {
    const now = Date.now()

    // 合并现有的和新匹配的
    const merged = new Map<string, PreloadBufferEntry>()

    // 先加入现有的（保留已有条目的 loadedAt）
    for (const existing of this.preloadBuffer) {
      merged.set(existing.entry.id, existing)
    }

    // 新匹配加入或更新
    for (const match of newMatches) {
      const existing = merged.get(match.entry.id)
      if (existing) {
        // 更新评分和时间
        existing.scoreDetail = match.scoreDetail
        existing.loadedAt = now
      } else {
        merged.set(match.entry.id, {
          entry: match.entry,
          scoreDetail: match.scoreDetail,
          loadedAt: now,
        })
      }
    }

    // 按评分降序排列，取 Top-N
    const sorted = [...merged.values()]
      .sort((a, b) => b.scoreDetail.combined - a.scoreDetail.combined)
      .slice(0, PRELOAD_BUFFER_MAX)

    this.preloadBuffer = sorted
  }

  // ══════════════════════════════════════════
  //  对外接口
  // ══════════════════════════════════════════

  /**
   * 获取预加载上下文文本（用于注入 Agent system prompt）。
   *
   * 返回格式化文本，包含当前行为上下文描述和高匹配度的记忆片段。
   * 如果缓冲区为空，返回空字符串。
   */
  getPreloadedContext(): string {
    if (this.preloadBuffer.length === 0) return ''

    const lines: string[] = []
    lines.push('---')
    lines.push('【行为预测记忆引擎 - 预加载上下文】')
    lines.push('根据用户当前行为模式（时间、应用、话题），以下记忆可能相关：')

    for (let i = 0; i < this.preloadBuffer.length; i++) {
      const pbe = this.preloadBuffer[i]
      const score = (pbe.scoreDetail.combined * 100).toFixed(0)
      lines.push(`${i + 1}. [${score}%] ${pbe.entry.content}`)
    }

    lines.push('---')
    return lines.join('\n')
  }

  /**
   * 获取当前缓冲区中的条目列表。
   * 用于调试或外部检查。
   */
  getBufferedEntries(): PreloadBufferEntry[] {
    return [...this.preloadBuffer]
  }

  /**
   * 手动触发一次检查并更新缓冲区。
   * 用于测试或强制刷新。
   */
  async checkNow(): Promise<void> {
    return this.checkAndPreload()
  }

  /**
   * 清除预加载缓冲区。
   */
  clearBuffer(): void {
    this.preloadBuffer = []
    log('DEBUG', 'prediction_memory_engine_buffer_cleared')
  }

  /**
   * 获取引擎统计信息。
   */
  getStats(): EngineStats {
    return {
      bufferSize: this.preloadBuffer.length,
      checkCount: this.checkCount,
      totalMatchesFound: this.totalMatchesFound,
      isRunning: this.isRunning(),
      lastCheckTime: this.lastCheckTime,
    }
  }

  /**
   * 重置引擎状态（缓冲区 + 统计）。
   * 用于测试或会话切换。
   */
  reset(): void {
    this.clearBuffer()
    this.checkCount = 0
    this.totalMatchesFound = 0
    this.lastCheckTime = 0
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const behaviorPredictionMemoryEngine = new BehaviorPredictionMemoryEngine()
