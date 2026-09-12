/**
 * BehaviorPreferenceStore — 行为偏好键值存储
 *
 * 基于 MemoryService 的用户画像机制（user_profile 类型存储），
 * 提供类型安全的偏好统计读写接口。
 *
 * 存储内容：
 * - 工具参数默认偏好（如翻译语言对、回复长度）
 * - 用户纠正统计（某种模式被纠正的次数）
 * - 命令模板使用频率
 * - 回复详略度趋势
 *
 * 所有数据以 user_profile 记忆条目持久化，
 * 通过 getFormattedContext() 在 system prompt 中注入。
 *
 * @module behavior
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import type { UserProfileData } from '@akemi-mio/intelligence-memory/MemoryService'

// ══════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════

/** 偏好条目值类型 */
export type PreferenceValue = string | number | boolean

/** 存储的偏好统计条目 */
export interface PreferenceStat {
  /** 唯一键（如 'translate:target_lang', 'correction:language_pair:zh-en'） */
  key: string
  /** 当前值 */
  value: PreferenceValue
  /** 分类 */
  category: 'tool_default' | 'correction' | 'command_template' | 'detail_trend' | 'style_pref' | 'task_flow'
  /** 置信度 (0-1)，由采样次数决定 */
  confidence: number
  /** 该统计的采样/观测次数 */
  sampleCount: number
  /** 最后更新时间 */
  updatedAt: number
  /** 额外上下文（JSON 字符串） */
  metadata?: string
}

/** 偏好存储的快照 */
export interface PreferenceSnapshot {
  /** 所有工具参数默认偏好 */
  toolDefaults: Record<string, PreferenceValue>
  /** 纠正模式统计 */
  correctionStats: Record<string, number>
  /** 命令模板频率 */
  commandTemplateFreq: Record<string, number>
  /** 倾向的回复长度分类 */
  detailTrend: 'concise' | 'balanced' | 'detailed' | 'unknown'
  /** 风格偏好 */
  stylePref: string | null
  /** 时间戳 */
  timestamp: number
}

// ══════════════════════════════════════════
// 内存缓存
// ══════════════════════════════════════════

/** 最大缓存条目数 */
const MAX_CACHED_ENTRIES = 100

// ══════════════════════════════════════════
// BehaviorPreferenceStore
// ══════════════════════════════════════════

export class BehaviorPreferenceStore {
  private memoryService: MemoryService | null = null
  private cache: Map<string, PreferenceStat> = new Map()
  private dirtyKeys = new Set<string>()
  private flushTimer: ReturnType<typeof setInterval> | null = null

  /** 注入 MemoryService 引用（启动时由 ChatExecutor 或 AppRuntime 调用） */
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
    this.loadFromMemory()
    this.startFlushTimer()
  }

  /** 获取当前 MemoryService 引用 */
  getMemoryService(): MemoryService | null {
    return this.memoryService
  }

  // ══════════════════════════════════════════
  //  核心读写
  // ══════════════════════════════════════════

  /**
   * 读取一个偏好统计值。
   * @param key 偏好键
   * @param defaultValue 未找到时的默认值
   */
  get<T extends PreferenceValue>(key: string, defaultValue?: T): T | undefined {
    const cached = this.cache.get(key)
    if (cached) return cached.value as T
    return defaultValue
  }

  /**
   * 递增一个计数型偏好统计。
   * 适用于纠正计数、工具使用频次等场景。
   */
  increment(key: string, category: PreferenceStat['category'], metadata?: string): void {
    const existing = this.cache.get(key)
    const now = Date.now()
    if (existing) {
      existing.value = (existing.value as number) + 1
      existing.sampleCount++
      existing.updatedAt = now
      existing.confidence = Math.min(0.95, existing.confidence + 0.05)
      if (metadata) existing.metadata = metadata
    } else {
      this.cache.set(key, {
        key,
        value: 1,
        category,
        confidence: 0.2, // 初始低置信度
        sampleCount: 1,
        updatedAt: now,
        metadata,
      })
    }
    this.dirtyKeys.add(key)
  }

  /**
   * 设置一个偏好值（覆盖式）。
   * 适用于工具参数默认值、风格偏好等。
   */
  set(key: string, value: PreferenceValue, category: PreferenceStat['category'], metadata?: string): void {
    const existing = this.cache.get(key)
    const now = Date.now()
    if (existing) {
      // 值变化时重置 confidence 增长从当前值开始
      const changed = existing.value !== value
      existing.value = value
      existing.sampleCount++
      existing.updatedAt = now
      existing.category = category
      existing.confidence = changed
        ? Math.max(0.3, existing.confidence) // 显式设置维持一定置信度
        : Math.min(0.95, existing.confidence + 0.05)
      if (metadata) existing.metadata = metadata
    } else {
      this.cache.set(key, {
        key,
        value,
        category,
        confidence: 0.4,
        sampleCount: 1,
        updatedAt: now,
        metadata,
      })
    }
    this.dirtyKeys.add(key)
  }

  /**
   * 批量设置偏好（合并写入，仅覆盖已有键，新增保留）。
   */
  setBatch(
    entries: Array<{ key: string; value: PreferenceValue; category: PreferenceStat['category']; confidence?: number; metadata?: string }>,
  ): void {
    for (const e of entries) {
      const existing = this.cache.get(e.key)
      const now = Date.now()
      if (existing) {
        existing.value = e.value
        existing.sampleCount++
        existing.updatedAt = now
        existing.confidence = e.confidence ?? Math.min(0.95, existing.confidence + 0.05)
        if (e.metadata) existing.metadata = e.metadata
      } else {
        this.cache.set(e.key, {
          key: e.key,
          value: e.value,
          category: e.category,
          confidence: e.confidence ?? 0.4,
          sampleCount: 1,
          updatedAt: now,
          metadata: e.metadata,
        })
      }
      this.dirtyKeys.add(e.key)
    }
  }

  /**
   * 获取所有偏好统计的只读快照。
   */
  getSnapshot(): PreferenceSnapshot {
    const toolDefaults: Record<string, PreferenceValue> = {}
    const correctionStats: Record<string, number> = {}
    const commandTemplateFreq: Record<string, number> = {}

    for (const [, stat] of this.cache) {
      switch (stat.category) {
        case 'tool_default':
          toolDefaults[stat.key] = stat.value
          break
        case 'correction':
          correctionStats[stat.key] = stat.value as number
          break
        case 'command_template':
          commandTemplateFreq[stat.key] = stat.value as number
          break
      }
    }

    // 推断回复详略度趋势
    const detailTrend = this.inferDetailTrend()
    const stylePref = this.inferStylePref()

    return {
      toolDefaults,
      correctionStats,
      commandTemplateFreq,
      detailTrend,
      stylePref,
      timestamp: Date.now(),
    }
  }

  /**
   * 将偏好统计格式化为 system prompt 可注入的上下文片段。
   */
  getFormattedContext(): string {
    const snapshot = this.getSnapshot()
    const parts: string[] = []
    let hasData = false

    // 工具参数默认偏好
    if (Object.keys(snapshot.toolDefaults).length > 0) {
      hasData = true
      parts.push('【用户习惯偏好】根据历史交互学习到的用户偏好：')
      for (const [key, value] of Object.entries(snapshot.toolDefaults)) {
        parts.push(`- ${key}: ${value}`)
      }
    }

    // 纠正模式统计（仅注入有意义的模式）
    const meaningfulCorrections = Object.entries(snapshot.correctionStats).filter(([, count]) => count >= 2)
    if (meaningfulCorrections.length > 0) {
      hasData = true
      if (parts.length === 0) parts.push('【用户习惯偏好】')
      for (const [key, count] of meaningfulCorrections) {
        parts.push(`- ${key} (用户已纠正 ${count} 次，注意该偏好)`)
      }
    }

    // 详略度趋势
    if (snapshot.detailTrend !== 'unknown') {
      hasData = true
      const trendMap = {
        concise: '用户倾向于简洁回复',
        balanced: '用户偏好适中详略',
        detailed: '用户倾向于详细回复',
      }
      parts.push(`- 回复风格: ${trendMap[snapshot.detailTrend]}`)
    }

    // 风格偏好
    if (snapshot.stylePref) {
      hasData = true
      parts.push(`- ${snapshot.stylePref}`)
    }

    if (!hasData) return ''

    parts.unshift('---')
    parts.push('（以上偏好基于交互习惯自动学习，如有误请在对话中纠正）')
    parts.push('---')
    return parts.join('\n')
  }

  /** 获取所有缓存条目的调试快照 */
  getDebugSnapshot(): { entries: PreferenceStat[]; dirtyCount: number } {
    return {
      entries: Array.from(this.cache.values()).sort((a, b) => b.sampleCount - a.sampleCount),
      dirtyCount: this.dirtyKeys.size,
    }
  }

  /** 清理所有偏好数据（遗忘模式） */
  clearAll(): void {
    this.cache.clear()
    this.dirtyKeys.clear()
    if (this.memoryService) {
      const prefs = this.memoryService.getUserPreferences()
      for (const p of prefs) {
        if (p.category === 'preference') {
          // 通过 MemoryService 移除（目前没有提供删除用户画像的方法，跳过）
        }
      }
    }
    log('INFO', 'behavior_preference_store_cleared')
  }

  // ══════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════

  /**
   * 从 MemoryService 加载已有偏好到缓存。
   */
  private loadFromMemory(): void {
    if (!this.memoryService) return
    try {
      const profileEntries = this.memoryService.getUserPreferences()
      let loaded = 0
      for (const entry of profileEntries) {
        if (entry.category !== 'preference') continue
        // 尝试从 structuredData 解析偏好统计
        const parsed = this.parseStructuredData(entry)
        if (parsed) {
          this.cache.set(parsed.key, parsed)
          loaded++
        }
      }
      if (loaded > 0) {
        log('INFO', 'behavior_preference_store_loaded', { entries: loaded })
      }
    } catch (err) {
      log('WARN', 'behavior_preference_store_load_failed', { error: String(err) })
    }
  }

  /**
   * 将单条 user_profile 条目解析为 PreferenceStat。
   * 元数据编码在 source 字段中（格式: behavior_ps:{category}:{sampleCount}）。
   */
  private parseStructuredData(entry: UserProfileData): PreferenceStat | null {
    try {
      const key = entry.key
      if (!key) return null

      // 从 source 解码 category 和 sampleCount
      let category: PreferenceStat['category'] = 'style_pref'
      let sampleCount = 1
      if (entry.source && entry.source.startsWith('behavior_ps:')) {
        const parts = entry.source.split(':')
        if (parts.length >= 3) {
          const catPart = parts[1] as PreferenceStat['category']
          if (['tool_default', 'correction', 'command_template', 'detail_trend', 'style_pref', 'task_flow'].includes(catPart)) {
            category = catPart
          }
          sampleCount = parseInt(parts[2], 10) || 1
        }
      }

      return {
        key,
        value: entry.value,
        category,
        confidence: entry.confidence,
        sampleCount,
        updatedAt: entry.updatedAt,
        metadata: undefined,
      }
    } catch {
      return null
    }
  }

  /**
   * 从纠正统计中推断详略度趋势。
   */
  private inferDetailTrend(): 'concise' | 'balanced' | 'detailed' | 'unknown' {
    const conciseCount = (this.cache.get('detail:prefer_concise')?.value as number | undefined) ?? 0
    const detailedCount = (this.cache.get('detail:prefer_detailed')?.value as number | undefined) ?? 0
    if (conciseCount > detailedCount && conciseCount >= 2) return 'concise'
    if (detailedCount > conciseCount && detailedCount >= 2) return 'detailed'
    if (conciseCount > 0 || detailedCount > 0) return 'balanced'
    return 'unknown'
  }

  /**
   * 从偏好中推断风格偏好文本。
   */
  private inferStylePref(): string | null {
    const lang = this.cache.get('style:language_pair')
    if (lang && lang.confidence > 0.5) {
      return `常用语言对: ${lang.value}`
    }
    const answerStyle = this.cache.get('style:answer_mode')
    if (answerStyle) {
      return `回答方式: ${answerStyle.value}`
    }
    return null
  }

  // ══════════════════════════════════════════
  //  持久化
  // ══════════════════════════════════════════

  /**
   * 启动定期刷新定时器（每 30 秒 flush 一次脏键）。
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush()
    }, 30_000)
  }

  /** 停止刷新定时器 */
  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  /**
   * 将所有脏键写入 MemoryService。
   */
  flush(): void {
    if (!this.memoryService || this.dirtyKeys.size === 0) return
    const keysToFlush = Array.from(this.dirtyKeys)
    this.dirtyKeys.clear()

    for (const key of keysToFlush) {
      const stat = this.cache.get(key)
      if (!stat) continue
      try {
        // 核心偏好值存储在 UserProfileData 中；
        // sampleCount 等元数据存于 source 字段（在内存中保留完整 PreferenceStat）
        this.memoryService.saveUserPreference({
          key: stat.key,
          value: String(stat.value),
          confidence: stat.confidence,
          category: 'preference',
          source: `behavior_ps:${stat.category}:${stat.sampleCount}`,
          updatedAt: stat.updatedAt,
        })
      } catch (err) {
        log('WARN', 'behavior_preference_store_flush_failed', {
          key: stat.key,
          error: String(err).slice(0, 120),
        })
      }
    }
  }
}

// ══════════════════════════════════════════
// 全局单例
// ══════════════════════════════════════════

/** 全局 BehaviorPreferenceStore 单例 */
export const behaviorPreferenceStore = new BehaviorPreferenceStore()
