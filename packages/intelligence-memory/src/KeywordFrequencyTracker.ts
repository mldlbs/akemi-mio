/**
 * KeywordFrequencyTracker — 关键字频率跟踪器
 *
 * 持久化追踪用户对话中的关键字出现频率，为行为导向记忆自动归档提供基础。
 * 每次对话后提取关键字并更新频率统计，支持时间衰减。
 *
 * 核心流程：
 * 1. 每次交互后 recordKeywords() 更新关键词频率
 * 2. 提供 getTopKeywords() 获取高频关键词
 * 3. 提供 getKeywordMatchScore() 计算内容与高频关键词的匹配度
 * 4. 定期衰减低频关键词
 *
 * 集成点：
 * - MemoryService.recordInteraction() 每次对话后调用 recordKeywords()
 * - MemoryService.addEntry() 保存记忆时调用 getKeywordMatchScore() 提升权重
 * - MemoryCleaner 清理周期中调用 getStaleKeywordScore() 辅助决策
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { getRawDb, markDirty } from '@akemi-mio/core/db/connection'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 默认最大跟踪关键字数 */
const DEFAULT_MAX_KEYWORDS = 100

/** 高频关键字阈值（频率 >= 此值视为高频） */
const DEFAULT_HIGH_FREQ_THRESHOLD = 5

/** 低频关键字阈值（频率 <= 此值视为低频） */
const DEFAULT_LOW_FREQ_THRESHOLD = 2

/** 衰减检查间隔（毫秒），默认 6 小时 */
const DEFAULT_DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 每次衰减的衰减因子 (0-1)，频率乘以该值 */
const DEFAULT_DECAY_FACTOR = 0.85

/** 衰减时最小保留频率（低于此值从表中移除） */
const DEFAULT_DECAY_MIN_FREQ = 1

/** 最大返回的关键字数 */
const DEFAULT_TOP_K = 20

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface KeywordFreqRecord {
  keyword: string
  freq: number
  lastSeen: number
  createdAt: number
}

export interface KeywordFrequencyConfig {
  maxKeywords: number
  highFreqThreshold: number
  lowFreqThreshold: number
  decayIntervalMs: number
  decayFactor: number
  decayMinFreq: number
  topK: number
}

export const DEFAULT_KEYWORD_CONFIG: KeywordFrequencyConfig = {
  maxKeywords: DEFAULT_MAX_KEYWORDS,
  highFreqThreshold: DEFAULT_HIGH_FREQ_THRESHOLD,
  lowFreqThreshold: DEFAULT_LOW_FREQ_THRESHOLD,
  decayIntervalMs: DEFAULT_DECAY_INTERVAL_MS,
  decayFactor: DEFAULT_DECAY_FACTOR,
  decayMinFreq: DEFAULT_DECAY_MIN_FREQ,
  topK: DEFAULT_TOP_K,
}

// ══════════════════════════════════════════
//  KeywordFrequencyTracker
// ══════════════════════════════════════════

export class KeywordFrequencyTracker {
  private config: KeywordFrequencyConfig
  private lastDecayTime: number = 0
  private decayTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<KeywordFrequencyConfig>) {
    this.config = { ...DEFAULT_KEYWORD_CONFIG, ...config }
    this.loadDecayTime()
  }

  /** 获取当前配置的只读副本 */
  getConfig(): Readonly<KeywordFrequencyConfig> {
    return { ...this.config }
  }

  /** 更新配置 */
  updateConfig(partial: Partial<KeywordFrequencyConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  // ══════════════════════════════════════════
  //  关键字频率记录
  // ══════════════════════════════════════════

  /**
   * 记录一组关键字的出现（每次对话后调用）。
   * 每个关键字频率 +1，更新 last_seen 时间。
   *
   * @param keywords 本次对话中提取的关键字列表
   */
  recordKeywords(keywords: string[]): void {
    if (!keywords || keywords.length === 0) return

    const now = Date.now()
    try {
      const db = getRawDb()
      db.run('BEGIN')

      for (const keyword of keywords) {
        const existing = db.exec(`SELECT freq, created_at FROM keyword_freq WHERE keyword = ?`, [keyword])

        if (existing && existing.length > 0 && existing[0].values.length > 0) {
          // 已存在 → 递增频率
          const row = existing[0].values[0]
          const currentFreq = Number(row[0]) || 0
          const createdAt = Number(row[1]) || now

          db.run(`UPDATE keyword_freq SET freq = ?, last_seen = ?, created_at = ? WHERE keyword = ?`, [
            currentFreq + 1,
            now,
            createdAt,
            keyword,
          ])
        } else {
          // 新增关键字
          db.run(`INSERT OR REPLACE INTO keyword_freq (keyword, freq, last_seen, created_at) VALUES (?, 1, ?, ?)`, [keyword, now, now])
        }
      }

      db.run('COMMIT')
      markDirty()

      // 超过最大关键字数时清理最低频的
      this.pruneExcess()

      log('DEBUG', 'keyword_freq_recorded', {
        count: keywords.length,
        keywords: keywords.slice(0, 10),
      })
    } catch (err) {
      try {
        getRawDb().run('ROLLBACK')
      } catch {}
      log('WARN', 'keyword_freq_record_failed', { error: String(err), keywords: keywords.slice(0, 5) })
    }
  }

  /**
   * 批量记录多组交互的关键字（用于初始化加载时）。
   */
  recordKeywordsBatch(entries: Array<{ keywords: string[]; timestamp: number }>): void {
    if (!entries || entries.length === 0) return

    try {
      const db = getRawDb()
      db.run('BEGIN')

      for (const { keywords, timestamp } of entries) {
        if (!keywords || keywords.length === 0) continue

        for (const keyword of keywords) {
          const normalizedKeyword = keyword.trim().toLowerCase()
          if (!normalizedKeyword) continue

          const existing = db.exec(`SELECT freq, created_at FROM keyword_freq WHERE keyword = ?`, [normalizedKeyword])

          if (existing && existing.length > 0 && existing[0].values.length > 0) {
            const row = existing[0].values[0]
            const currentFreq = Number(row[0]) || 0
            const createdAt = Number(row[1]) || timestamp

            db.run(`UPDATE keyword_freq SET freq = ?, last_seen = ?, created_at = ? WHERE keyword = ?`, [
              currentFreq + 1,
              timestamp,
              createdAt,
              normalizedKeyword,
            ])
          } else {
            db.run(`INSERT OR REPLACE INTO keyword_freq (keyword, freq, last_seen, created_at) VALUES (?, 1, ?, ?)`, [
              normalizedKeyword,
              timestamp,
              timestamp,
            ])
          }
        }
      }

      db.run('COMMIT')
      markDirty()
      log('INFO', 'keyword_freq_batch_recorded', { batchSize: entries.length })
    } catch (err) {
      try {
        getRawDb().run('ROLLBACK')
      } catch {}
      log('WARN', 'keyword_freq_batch_failed', { error: String(err) })
    }
  }

  // ══════════════════════════════════════════
  //  关键字查询
  // ══════════════════════════════════════════

  /**
   * 获取频率最高的前 K 个关键字。
   */
  getTopKeywords(k?: number): KeywordFreqRecord[] {
    const limit = k ?? this.config.topK
    try {
      const db = getRawDb()
      const result = db.exec(`SELECT keyword, freq, last_seen, created_at FROM keyword_freq ORDER BY freq DESC LIMIT ?`, [limit])
      if (!result || result.length === 0) return []
      const columns = result[0].columns
      return result[0].values.map((v: any[]) => {
        const obj: any = {}
        for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
        return {
          keyword: obj.keyword,
          freq: Number(obj.freq),
          lastSeen: Number(obj.last_seen),
          createdAt: Number(obj.created_at),
        }
      })
    } catch (err) {
      log('WARN', 'keyword_freq_query_failed', { error: String(err) })
      return []
    }
  }

  /**
   * 获取所有关键字（用于批量处理）。
   */
  getAllKeywords(): KeywordFreqRecord[] {
    try {
      const db = getRawDb()
      const result = db.exec(`SELECT keyword, freq, last_seen, created_at FROM keyword_freq ORDER BY freq DESC`)
      if (!result || result.length === 0) return []
      const columns = result[0].columns
      return result[0].values.map((v: any[]) => {
        const obj: any = {}
        for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
        return {
          keyword: obj.keyword,
          freq: Number(obj.freq),
          lastSeen: Number(obj.last_seen),
          createdAt: Number(obj.created_at),
        }
      })
    } catch (err) {
      log('WARN', 'keyword_freq_get_all_failed', { error: String(err) })
      return []
    }
  }

  /**
   * 获取高频关键字列表（频率 >= highFreqThreshold）。
   */
  getHighFrequencyKeywords(k?: number): string[] {
    const limit = k ?? this.config.topK
    const threshold = this.config.highFreqThreshold
    return this.getTopKeywords(limit)
      .filter((r) => r.freq >= threshold)
      .map((r) => r.keyword)
  }

  /**
   * 获取低频关键字列表（频率 <= lowFreqThreshold 且不是刚刚出现的）。
   */
  getLowFrequencyKeywords(): string[] {
    const threshold = this.config.lowFreqThreshold
    return this.getAllKeywords()
      .filter((r) => r.freq <= threshold)
      .map((r) => r.keyword)
  }

  // ══════════════════════════════════════════
  //  匹配度计算
  // ══════════════════════════════════════════

  /**
   * 计算一组内容关键字与高频关键字的匹配度（0-1）。
   * 用于记忆保存时判断是否应该提高权重。
   *
   * 算法：
   * 1. 取内容关键字与高频关键字的交集
   * 2. 对交集中的关键字，累加其归一化频率权重
   * 3. 除以内容关键字总数得到匹配度
   *
   * @param contentKeywords 内容的关键字列表
   * @returns 0-1 的匹配度
   */
  getKeywordMatchScore(contentKeywords: string[]): number {
    if (!contentKeywords || contentKeywords.length === 0) return 0

    const highFreq = this.getHighFrequencyKeywords()
    if (highFreq.length === 0) return 0

    const highFreqSet = new Set(highFreq)
    const allKeywords = this.getAllKeywords()
    const freqMap = new Map(allKeywords.map((r) => [r.keyword, r.freq]))
    const maxFreq = allKeywords.length > 0 ? Math.max(...allKeywords.map((r) => r.freq)) : 1

    let matchScore = 0

    for (const keyword of contentKeywords) {
      if (highFreqSet.has(keyword)) {
        // 匹配到高频关键字，按其频率占比贡献分数
        const freq = freqMap.get(keyword) || 1
        matchScore += freq / maxFreq
      }
    }

    // 归一化到 0-1
    return Math.min(1.0, matchScore / contentKeywords.length)
  }

  /**
   * 计算记忆关键字集的"陈旧度"得分（用于清理决策）。
   * 匹配低频关键字的记忆得分较高（更可能被清理）。
   *
   * @param memoryTopics 记忆的主题/关键字列表
   * @returns 0-1 的陈旧度得分（越高越应清理）
   */
  getStaleKeywordScore(memoryTopics: string[]): number {
    if (!memoryTopics || memoryTopics.length === 0) return 0

    const lowFreq = this.getLowFrequencyKeywords()
    if (lowFreq.length === 0) return 0

    const lowFreqSet = new Set(lowFreq)
    let staleMatch = 0

    for (const topic of memoryTopics) {
      if (lowFreqSet.has(topic)) {
        staleMatch++
      }
    }

    return staleMatch / memoryTopics.length
  }

  // ══════════════════════════════════════════
  //  频率维护
  // ══════════════════════════════════════════

  /**
   * 执行频率衰减：将所有关键字频率乘以衰减因子，
   * 低于 minFreq 的关键字将被移除。
   */
  decayFrequencies(): number {
    const now = Date.now()

    // 检查是否达到衰减间隔
    if (now - this.lastDecayTime < this.config.decayIntervalMs) {
      return 0
    }

    const decayFactor = this.config.decayFactor
    const minFreq = this.config.decayMinFreq
    let decayed = 0
    let removed = 0

    try {
      const db = getRawDb()

      // 1. 衰减所有频率
      db.run(`UPDATE keyword_freq SET freq = MAX(0, CAST(ROUND(freq * ?) AS INTEGER))`, [decayFactor])
      decayed = Number(db.exec('SELECT changes() AS c')[0]?.values[0]?.[0] || 0)

      // 2. 移除低于阈值的
      const toRemove = db.exec(`SELECT keyword FROM keyword_freq WHERE freq < ?`, [minFreq])
      if (toRemove && toRemove.length > 0 && toRemove[0].values.length > 0) {
        const removeCount = toRemove[0].values.length
        db.run(`DELETE FROM keyword_freq WHERE freq < ?`, [minFreq])
        removed = removeCount
      }

      this.lastDecayTime = now
      this.saveDecayTime(now)
      markDirty()

      if (decayed > 0 || removed > 0) {
        log('INFO', 'keyword_freq_decayed', {
          decayed,
          removed,
          remaining: this.getAllKeywords().length,
        })
      }
    } catch (err) {
      log('WARN', 'keyword_freq_decay_failed', { error: String(err) })
    }

    return decayed + removed
  }

  /**
   * 如果关键字数量超过 maxKeywords，移除最低频的过时关键字。
   */
  private pruneExcess(): void {
    try {
      const db = getRawDb()
      const count = Number(db.exec('SELECT COUNT(*) AS c FROM keyword_freq')[0]?.values[0]?.[0] || 0)
      if (count > this.config.maxKeywords) {
        const excess = count - this.config.maxKeywords
        db.run(
          `DELETE FROM keyword_freq WHERE keyword IN (
            SELECT keyword FROM keyword_freq ORDER BY freq ASC, last_seen ASC LIMIT ?
          )`,
          [excess + 10], // 多删几个留余量
        )
        log('INFO', 'keyword_freq_pruned', { removed: excess + 10 })
        markDirty()
      }
    } catch {
      /* ignore */
    }
  }

  // ══════════════════════════════════════════
  //  统计信息
  // ══════════════════════════════════════════

  /**
   * 获取关键字频率统计信息。
   */
  getStats(): {
    totalKeywords: number
    highFreqCount: number
    lowFreqCount: number
    totalFrequency: number
    lastDecayTime: number
    topKeywords: string[]
  } {
    const all = this.getAllKeywords()
    const totalFrequency = all.reduce((sum, r) => sum + r.freq, 0)
    const highFreqCount = all.filter((r) => r.freq >= this.config.highFreqThreshold).length
    const lowFreqCount = all.filter((r) => r.freq <= this.config.lowFreqThreshold).length

    return {
      totalKeywords: all.length,
      highFreqCount,
      lowFreqCount,
      totalFrequency,
      lastDecayTime: this.lastDecayTime,
      topKeywords: this.getTopKeywords(10).map((r) => r.keyword),
    }
  }

  /** 手动强制触发衰减（供外部定期任务调用） */
  forceDecay(): number {
    // 重置上次衰减时间，确保衰减执行
    this.lastDecayTime = 0
    return this.decayFrequencies()
  }

  // ══════════════════════════════════════════
  //  生命期管理
  // ══════════════════════════════════════════

  /** 启动定期衰减定时器 */
  startDecayTimer(): void {
    if (this.decayTimer) return
    this.decayTimer = setInterval(
      () => {
        this.decayFrequencies()
      },
      Math.min(this.config.decayIntervalMs, 3600_000),
    ) // 最多每小时检查一次
    log('INFO', 'keyword_freq_decay_timer_started', {
      intervalMs: this.config.decayIntervalMs,
    })
  }

  /** 停止定期衰减定时器 */
  stopDecayTimer(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer)
      this.decayTimer = null
    }
  }

  /** 从数据库加载上次衰减时间 */
  private loadDecayTime(): void {
    try {
      const db = getRawDb()
      const result = db.exec(`SELECT last_seen FROM keyword_freq ORDER BY last_seen DESC LIMIT 1`)
      if (result && result.length > 0 && result[0].values.length > 0) {
        this.lastDecayTime = Number(result[0].values[0][0])
      }
    } catch {
      this.lastDecayTime = 0
    }
  }

  /** 保存衰减时间到数据库标记 */
  private saveDecayTime(now: number): void {
    // 使用一个特殊的标记行保存衰减时间
    try {
      const db = getRawDb()
      const key = '__decay_timestamp__'
      const existing = db.exec(`SELECT 1 FROM keyword_freq WHERE keyword = ?`, [key])
      if (existing && existing.length > 0 && existing[0].values.length > 0) {
        db.run(`UPDATE keyword_freq SET freq = ?, last_seen = ? WHERE keyword = ?`, [0, now, key])
      } else {
        db.run(`INSERT INTO keyword_freq (keyword, freq, last_seen, created_at) VALUES (?, 0, ?, ?)`, [key, now, now])
      }
    } catch {
      // 装饰性标记，失败不影响主流程
    }
  }

  /** 清除所有关键字数据（用于测试） */
  clearAll(): void {
    try {
      getRawDb().run('DELETE FROM keyword_freq')
      markDirty()
      this.lastDecayTime = 0
    } catch {
      /* ignore */
    }
  }
}
