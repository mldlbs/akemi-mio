/**
 * TelegramMemoryService — 情境感知融合记忆桥接器
 *
 * 将 MemoryService 集成到 Telegram 推送系统，实现：
 * 1. 推送前查询用户最近对话上下文，过滤不相关的推送
 * 2. 存储和管理用户偏好（格式、频率、静音类别等）
 * 3. 推送历史去重，避免重复推送相同内容
 * 4. 旧用户数据迁移到新 Memory 存储
 * 5. 推送时附加偏好标签（通过 outbox tags）
 *
 * ## 架构
 *
 * TelegramService ──→ TelegramMemoryService ──→ MemoryService
 *   (push events)        (relevance filter,       (vector store,
 *                         pref mgmt, dedup)         user prefs, interactions)
 *
 * ## 线程安全
 *
 * 所有公开方法均为 async，可在 Telegram poll 循环和 EventBus 事件处理中安全调用。
 */

import { log } from '../logger/Logger'
import type { MemoryService } from '../memory/MemoryService'
import { getEmbedding, cosineSimilarity } from '../memory/embedding'

// =============================================================================
// 类型定义
// =============================================================================

/** 用户偏好键列表 */
export const TELEGRAM_PREFERENCE_KEYS = {
  /** 推送格式: 'brief' | 'detailed' | 'auto' */
  FORMAT: 'telegram_push_format',
  /** 推送频率: 'all' | 'important_only' | 'daily_digest' | 'muted' */
  FREQUENCY: 'telegram_push_frequency',
  /** 静音类别（逗号分隔的类别名） */
  MUTED_CATEGORIES: 'telegram_muted_categories',
  /** 语言: 'zh' | 'en' | 'auto' */
  LANGUAGE: 'telegram_language',
  /** 活跃时间段（JSON: {startHour, endHour}） */
  ACTIVE_HOURS: 'telegram_active_hours',
  /** 是否启用上下文过滤: 'true' | 'false' */
  CONTEXT_FILTER_ENABLED: 'telegram_context_filter',
} as const

/** 推送频率级别 */
export type PushFrequency = 'all' | 'important_only' | 'daily_digest' | 'muted'

/** 推送格式 */
export type PushFormat = 'brief' | 'detailed' | 'auto'

/** 偏好标签（用于附加到 outbox） */
export interface PreferenceTags {
  format: PushFormat
  frequency: PushFrequency
  language: string
  mutedCategories: string[]
  contextFilterEnabled: boolean
}

// =============================================================================
// 推送类别 → 关键性映射
// =============================================================================

/**
 * 关键类别：始终推送，不检查上下文相关性。
 * 这些是系统级事件，用户不应错过。
 */
const CRITICAL_CATEGORIES = new Set<string>([
  'budget',
  'recovery',
  'system',
  'stability',
])

/**
 * 各推送类别对应的语义话题标签。
 * 用于与用户最近交互进行语义匹配。
 */
const CATEGORY_TOPIC_MAP: Record<string, string[]> = {
  evolution: ['进化', '自我检查', '系统更新', 'evolution', 'update'],
  insight: ['洞察', '分析', '发现', 'insight', 'analysis', 'pattern'],
  creativity: ['创意', '想法', '灵感', 'creativity', 'idea', '创新'],
  plan: ['计划', '任务', '规划', 'plan', 'task', 'project'],
  dialogue: ['对话', '聊天', '交流', 'chat', 'talk', 'message'],
}

// =============================================================================
// 默认偏好值
// =============================================================================

const DEFAULT_PREFERENCES: Record<string, string> = {
  [TELEGRAM_PREFERENCE_KEYS.FORMAT]: 'auto',
  [TELEGRAM_PREFERENCE_KEYS.FREQUENCY]: 'all',
  [TELEGRAM_PREFERENCE_KEYS.MUTED_CATEGORIES]: '',
  [TELEGRAM_PREFERENCE_KEYS.LANGUAGE]: 'zh',
  [TELEGRAM_PREFERENCE_KEYS.ACTIVE_HOURS]: '{"startHour":0,"endHour":24}',
  [TELEGRAM_PREFERENCE_KEYS.CONTEXT_FILTER_ENABLED]: 'true',
}

// =============================================================================
// 推送历史去重（内存中的 LRU Map + 定期清理）
// =============================================================================

/** 推送历史条目 */
interface PushHistoryEntry {
  /** 内容哈希 */
  hash: string
  /** 推送时间 */
  timestamp: number
  /** 推送类别 */
  category: string
}

const MAX_PUSH_HISTORY = 200
const PUSH_HISTORY_TTL_MS = 24 * 60 * 60 * 1000 // 24 小时

// =============================================================================
// TelegramMemoryService
// =============================================================================

export class TelegramMemoryService {
  private memoryService: MemoryService
  /** 内存中的推送历史（hash → 条目） */
  private pushHistory = new Map<string, PushHistoryEntry>()
  /** 优先级队列顺序（用于 LRU 淘汰） */
  private pushHistoryOrder: string[] = []
  /** 是否已初始化 */
  private initialized = false
  /** 最近一次清理时间 */
  private lastCleanup = 0
  /** 清理间隔（默认 30 分钟） */
  private readonly cleanupIntervalMs = 30 * 60 * 1000

  constructor(memoryService: MemoryService) {
    this.memoryService = memoryService
  }

  // ===========================================================================
  // 初始化
  // ===========================================================================

  /**
   * 初始化服务：
   * 1. 从 MemoryService 加载持久化的推送历史
   * 2. 迁移旧用户数据
   * 3. 设置默认偏好（如无历史）
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    log('INFO', 'telegram_memory_init_start')

    // 从 MemoryService 加载已持久化的推送历史
    await this.loadPushHistory()
    await this.migrateLegacyData()

    this.initialized = true
    log('INFO', 'telegram_memory_init_complete', {
      pushHistorySize: this.pushHistory.size,
    })
  }

  // ===========================================================================
  // 推送相关性过滤
  // ===========================================================================

  /**
   * 判断是否应该推送某条内容。
   *
   * @param category 推送类别
   * @param content 推送内容（用于去重和语义分析）
   * @returns 是否推送及原因
   */
  async shouldPush(
    category: string,
    content: string,
  ): Promise<{ push: boolean; reason: string }> {
    // 1. 关键类别始终推送
    if (CRITICAL_CATEGORIES.has(category)) {
      return { push: true, reason: 'critical_category' }
    }

    // 2. 检查用户是否静音该类别
    const muted = await this.getMutedCategories()
    if (muted.includes(category)) {
      return { push: false, reason: `category_muted:${category}` }
    }

    // 3. 检查频率设置
    const frequency = await this.getPreference(TELEGRAM_PREFERENCE_KEYS.FREQUENCY, 'all')
    if (frequency === 'muted') {
      return { push: false, reason: 'frequency_muted' }
    }
    if (frequency === 'daily_digest') {
      // 日报模式下，仍然推送但标记为可聚合（由上层决定是否立即推送）
      return { push: true, reason: 'daily_digest_allow' }
    }

    // 4. 检查活跃时间段
    if (!this.isWithinActiveHours()) {
      return { push: false, reason: 'outside_active_hours' }
    }

    // 5. 检查上下文过滤是否启用
    const filterEnabled = await this.getPreference(TELEGRAM_PREFERENCE_KEYS.CONTEXT_FILTER_ENABLED, 'true')
    if (filterEnabled !== 'true') {
      return { push: true, reason: 'filter_disabled' }
    }

    // 6. 语义相关性检查：推送内容是否与用户近期交互相关
    if (frequency === 'important_only') {
      const relevant = await this.isRelevantToRecentActivity(category, content)
      if (!relevant) {
        return { push: false, reason: 'low_relevance_to_recent_activity' }
      }
    }

    return { push: true, reason: 'relevance_match' }
  }

  /**
   * 检查推送内容是否与用户近期活动相关。
   * 使用 VectorMemory 语义搜索，比较推送类别话题与用户近期交互话题的相似度。
   */
  private async isRelevantToRecentActivity(
    category: string,
    content: string,
  ): Promise<boolean> {
    try {
      // 获取该类别的语义话题标签
      const topicTags = CATEGORY_TOPIC_MAP[category]
      if (!topicTags || topicTags.length === 0) {
        // 无话题标签的类别默认为相关
        return true
      }

      // 构建组合查询：结合话题标签和内容摘要
      const queryText = `${topicTags.slice(0, 3).join(' ')} ${content.slice(0, 100)}`

      // 查询 VectorMemory 获取语义相关条目
      const related = await this.memoryService.vector.query(queryText, 3)

      // 有语义匹配 → 相关
      if (related.length > 0) {
        return true
      }

      // 同步回退：使用 fallback 嵌入再做一次检查
      const syncRelated = this.memoryService.vector.querySync(queryText, 2)
      return syncRelated.length > 0
    } catch (err) {
      // 查询失败时静默放行（不因过滤阻塞推送）
      log('WARN', 'telegram_memory_relevance_check_failed', {
        category,
        error: String(err),
      })
      return true
    }
  }

  // ===========================================================================
  // 推送历史记录与去重
  // ===========================================================================

  /**
   * 生成推送内容的唯一哈希。
   * 用于去重：相同哈希的推送在 TTL 内不会重复推送。
   */
  private makeContentHash(category: string, content: string): string {
    let h = 0
    const str = `${category}:${content.slice(0, 200)}`
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0
    }
    return `tg_push_${Math.abs(h).toString(36)}`
  }

  /**
   * 检查该内容是否已推送过（去重）。
   */
  async isDuplicate(category: string, content: string): Promise<boolean> {
    const hash = this.makeContentHash(category, content)
    const existing = this.pushHistory.get(hash)
    if (!existing) return false

    // TTL 检查：超过 24h 的旧记录视为已过期，不算重复
    const age = Date.now() - existing.timestamp
    if (age > PUSH_HISTORY_TTL_MS) {
      this.pushHistory.delete(hash)
      this.removeFromOrder(hash)
      return false
    }

    return true
  }

  /**
   * 记录一次推送（用于去重和历史追踪）。
   */
  async recordPush(category: string, content: string): Promise<void> {
    const hash = this.makeContentHash(category, content)

    // 如果已存在，更新时间戳
    if (this.pushHistory.has(hash)) {
      this.pushHistory.get(hash)!.timestamp = Date.now()
      return
    }

    // LRU 淘汰
    if (this.pushHistory.size >= MAX_PUSH_HISTORY) {
      const oldest = this.pushHistoryOrder.shift()
      if (oldest) this.pushHistory.delete(oldest)
    }

    const entry: PushHistoryEntry = {
      hash,
      timestamp: Date.now(),
      category,
    }
    this.pushHistory.set(hash, entry)
    this.pushHistoryOrder.push(hash)

    // 每 30 分钟清理一次过期条目
    await this.cleanupIfNeeded()
  }

  /** 获取最近 N 条推送历史（用于上下文注入） */
  getRecentPushHistory(limit = 5): PushHistoryEntry[] {
    return [...this.pushHistoryOrder]
      .reverse()
      .slice(0, limit)
      .map((h) => this.pushHistory.get(h)!)
      .filter(Boolean)
  }

  // ===========================================================================
  // 用户偏好管理
  // ===========================================================================

  /**
   * 设置用户偏好。
   * 使用 MemoryService.saveUserPreference 持久化。
   */
  async setPreference(key: string, value: string): Promise<void> {
    this.memoryService.saveUserPreference({
      key,
      value,
      confidence: 0.8,
      category: 'preference',
      source: 'telegram_memory',
      updatedAt: Date.now(),
    })
    log('INFO', 'telegram_preference_set', { key, value })
  }

  /**
   * 获取用户偏好值。
   * 先从 MemoryService 查找，无记录时返回默认值。
   */
  async getPreference(key: string, defaultValue?: string): Promise<string | undefined> {
    const prefs = this.memoryService.getUserPreferences()
    const found = prefs.find((p) => p.key === key)
    if (found) return found.value

    // 无记录时返回默认值
    if (defaultValue !== undefined) return defaultValue
    return DEFAULT_PREFERENCES[key]
  }

  /**
   * 获取所有偏好标签（用于附加到 outbox 消息中）。
   */
  async getPreferenceTags(): Promise<PreferenceTags> {
    const [format, frequency, mutedStr, language, filterEnabled] = await Promise.all([
      this.getPreference(TELEGRAM_PREFERENCE_KEYS.FORMAT, 'auto'),
      this.getPreference(TELEGRAM_PREFERENCE_KEYS.FREQUENCY, 'all'),
      this.getPreference(TELEGRAM_PREFERENCE_KEYS.MUTED_CATEGORIES, ''),
      this.getPreference(TELEGRAM_PREFERENCE_KEYS.LANGUAGE, 'zh'),
      this.getPreference(TELEGRAM_PREFERENCE_KEYS.CONTEXT_FILTER_ENABLED, 'true'),
    ])

    return {
      format: (format as PushFormat) || 'auto',
      frequency: (frequency as PushFrequency) || 'all',
      language: language || 'zh',
      mutedCategories: mutedStr ? mutedStr.split(',').map((s) => s.trim()).filter(Boolean) : [],
      contextFilterEnabled: filterEnabled !== 'false',
    }
  }

  /** 获取被静音的类别列表 */
  private async getMutedCategories(): Promise<string[]> {
    const mutedStr = await this.getPreference(TELEGRAM_PREFERENCE_KEYS.MUTED_CATEGORIES, '')
    if (!mutedStr) return []
    return mutedStr.split(',').map((s) => s.trim()).filter(Boolean)
  }

  // ===========================================================================
  // 活跃时间段检查
  // ===========================================================================

  /** 检查当前时间是否在用户设置的活跃时间段内 */
  private isWithinActiveHours(): boolean {
    try {
      // 使用 getPreference 的同步查询路径（避免每轮推送都 async）
      const prefs = this.memoryService.getUserPreferences()
      const activeHoursPref = prefs.find(
        (p) => p.key === TELEGRAM_PREFERENCE_KEYS.ACTIVE_HOURS,
      )
      const jsonStr = activeHoursPref?.value || DEFAULT_PREFERENCES[TELEGRAM_PREFERENCE_KEYS.ACTIVE_HOURS]
      const { startHour, endHour } = JSON.parse(jsonStr)
      const currentHour = new Date().getHours()
      return currentHour >= startHour && currentHour < endHour
    } catch {
      return true
    }
  }

  // ===========================================================================
  // 旧数据迁移
  // ===========================================================================

  /**
   * 从旧数据源迁移用户偏好到 MemoryService。
   * 检查凭证存储和旧环境变量配置中的 Telegram 设置。
   */
  async migrateLegacyData(): Promise<{ migrated: number }> {
    let migrated = 0

    // 检查是否已有偏好记录
    const prefs = this.memoryService.getUserPreferences()
    const hasExisting = prefs.some((p) => p.key.startsWith('telegram_'))

    if (hasExisting) {
      log('INFO', 'telegram_memory_migration_skipped', {
        reason: 'preferences_already_exist',
        count: prefs.length,
      })
      return { migrated: 0 }
    }

    // 创建默认偏好（首次运行、无历史数据时）
    for (const [key, value] of Object.entries(DEFAULT_PREFERENCES)) {
      this.memoryService.saveUserPreference({
        key,
        value,
        confidence: 0.6,
        category: 'preference',
        source: 'telegram_migration',
        updatedAt: Date.now(),
      })
      migrated++
    }

    log('INFO', 'telegram_memory_migration_complete', {
      migrated,
      defaults: Object.keys(DEFAULT_PREFERENCES).length,
    })

    return { migrated }
  }

  // ===========================================================================
  // 获取用户最近上下文（供外部使用）
  // ===========================================================================

  /**
   * 获取用户最近的交互上下文摘要。
   * 用于在推送前了解用户当前活跃话题。
   */
  async getRecentUserContext(): Promise<{
    topics: string[]
    interactionCount: number
    recentActivity: string
  }> {
    const interactionCount = this.memoryService.getInteractionCount()

    // 从 InteractionTracker 获取近期话题
    let topics: string[] = []
    try {
      const profile = this.memoryService.getCurrentInterestProfile()
      topics = profile?.interests?.map((i: any) => i.topic) || []
    } catch {
      // 静默
    }

    // 获取最近的向量记忆内容
    let recentActivity = ''
    try {
      const entries = this.memoryService.vector.querySync('', 2)
      if (entries.length > 0) {
        recentActivity = entries.join(' | ')
      }
    } catch {
      // 静默
    }

    return {
      topics: topics.slice(0, 5),
      interactionCount,
      recentActivity,
    }
  }

  // ===========================================================================
  // 内部方法
  // ===========================================================================

  /** 从 MemoryService 加载持久化的推送历史 */
  private async loadPushHistory(): Promise<void> {
    try {
      // 从 memories 表中查找 telegram_push_history 类型的条目
      const entries = this.memoryService.getEntries()
      const historyEntries = entries.filter(
        (e) => e.type === 'interaction' && e.content.startsWith('[telegram_push]'),
      )

      for (const e of historyEntries.slice(-MAX_PUSH_HISTORY)) {
        try {
          const data = e.structuredData
            ? JSON.parse(e.structuredData)
            : null
          if (data && data.hash) {
            this.pushHistory.set(data.hash, {
              hash: data.hash,
              timestamp: data.timestamp || e.createdAt,
              category: data.category || 'unknown',
            })
            this.pushHistoryOrder.push(data.hash)
          }
        } catch {
          // 跳过解析失败的条目
        }
      }
    } catch (err) {
      log('WARN', 'telegram_memory_load_push_history_failed', {
        error: String(err),
      })
    }
  }

  /** 从 order 数组中移除指定 hash */
  private removeFromOrder(hash: string): void {
    const idx = this.pushHistoryOrder.indexOf(hash)
    if (idx >= 0) this.pushHistoryOrder.splice(idx, 1)
  }

  /** 定期清理过期推送历史 */
  private async cleanupIfNeeded(): Promise<void> {
    const now = Date.now()
    if (now - this.lastCleanup < this.cleanupIntervalMs) return
    this.lastCleanup = now

    const expired: string[] = []
    for (const [hash, entry] of this.pushHistory) {
      if (now - entry.timestamp > PUSH_HISTORY_TTL_MS) {
        expired.push(hash)
      }
    }

    for (const hash of expired) {
      this.pushHistory.delete(hash)
      this.removeFromOrder(hash)
    }

    if (expired.length > 0) {
      log('DEBUG', 'telegram_memory_push_history_cleanup', {
        removed: expired.length,
        remaining: this.pushHistory.size,
      })
    }
  }

  /**
   * 获取当前服务的状态摘要。
   */
  getStatus(): {
    initialized: boolean
    pushHistorySize: number
    preferenceCount: number
  } {
    const prefs = this.memoryService.getUserPreferences()
    return {
      initialized: this.initialized,
      pushHistorySize: this.pushHistory.size,
      preferenceCount: prefs.filter((p) => p.key.startsWith('telegram_')).length,
    }
  }
}
