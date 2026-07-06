/**
 * InteractionTracker — 行为驱动的交互记录器
 *
 * 维护最近 32 次交互的环形缓冲区，记录每次交互的：
 * - 用户消息文本
 * - 响应耗时
 * - 主题标签
 * - 是否明确要求"记住"
 * - 重新提及的记忆 ID
 *
 * 支持时间模式分析：按小时统计主题频率，为预加载提供建议。
 */

import { log } from '../logger/Logger'
import { getRawDb, markDirty } from '../db/connection'
import type { InteractionRecord } from './types'

const RING_SIZE = 32
const TOPIC_WINDOW_DAYS = 14

let idCounter = 0

export interface HourlyTopicStat {
  /** 小时 (0-23) */
  hour: number
  /** 该时段出现的话题及其频率 */
  topics: Array<{ topic: string; count: number }>
}

export class InteractionTracker {
  private ring: InteractionRecord[] = []

  /** 记录一次交互 */
  record(input: {
    userText: string
    responseTimeMs?: number
    topics?: string[]
    isExplicitRemember?: boolean
    rementionedMemoryIds?: string[]
  }): InteractionRecord {
    const id = `ilog_${Date.now()}_${++idCounter}`
    const now = Date.now()
    const record: InteractionRecord = {
      id,
      userText: input.userText.slice(0, 200),
      responseTimeMs: input.responseTimeMs ?? null,
      topics: input.topics || [],
      isExplicitRemember: input.isExplicitRemember || false,
      rementionedMemoryIds: input.rementionedMemoryIds || [],
      timestamp: now,
      createdAt: now,
    }

    // 环形缓冲区
    if (this.ring.length >= RING_SIZE) {
      this.ring.shift()
    }
    this.ring.push(record)

    // 持久化
    this.saveToDb(record)

    return record
  }

  /** 获取最近 N 条交互记录（默认全部 32） */
  getRecent(limit?: number): InteractionRecord[] {
    const n = limit ?? RING_SIZE
    return this.ring.slice(-n)
  }

  /** 获取所有内存中的记录 */
  getAll(): InteractionRecord[] {
    return [...this.ring]
  }

  /** 从数据库加载最近 32 条记录到环形缓冲区 */
  load(): void {
    try {
      const db = getRawDb()
      const result = db.exec(
        `SELECT * FROM interaction_log ORDER BY timestamp DESC LIMIT ${RING_SIZE}`,
      )
      if (result && result.length > 0) {
        const columns = result[0].columns
        const records = result[0].values.map((v: any[]) => {
          const obj: any = {}
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
          return this.mapRow(obj)
        })
        this.ring = records.reverse() // 按时间升序
      }
      log('INFO', 'interaction_tracker_loaded', { count: this.ring.length })
    } catch (err) {
      log('WARN', 'interaction_tracker_load_failed', { error: String(err) })
    }
  }

  /** 检测用户是否在当前上下文中重新提及了某个已知记忆 */
  detectRementions(userText: string, knownContents: string[]): string[] {
    if (!userText || knownContents.length === 0) return []
    const rementioned: string[] = []
    const lower = userText.toLowerCase()
    for (const content of knownContents) {
      // 如果用户消息包含已知记忆的关键词（取前20字符匹配）
      const snippet = content.slice(0, 20).toLowerCase()
      if (snippet.length >= 3 && lower.includes(snippet)) {
        rementioned.push(content)
      }
    }
    return rementioned
  }

  /** 检测用户是否明确要求记住某些信息 */
  detectExplicitRemember(userText: string): boolean {
    const patterns = [
      /记住[：:，,\s]*/,
      /记下[：:，,\s]*/,
      /别忘了/,
      /提醒我/,
      /下次.*记[得住]/,
      /remember\b/i,
      /don'?t\s+forget\b/i,
      /note\s+this/i,
    ]
    return patterns.some((p) => p.test(userText))
  }

  /** 分析行为模式：按小时统计主题频率（用于预加载） */
  getHourlyTopicStats(): HourlyTopicStat[] {
    const cutoff = Date.now() - TOPIC_WINDOW_DAYS * 24 * 3600_000
    const recent = this.ring.filter((r) => r.timestamp >= cutoff)
    if (recent.length === 0) return []

    const hourMap = new Map<number, Map<string, number>>()
    for (const r of recent) {
      const hour = new Date(r.timestamp).getHours()
      if (!hourMap.has(hour)) hourMap.set(hour, new Map())
      const topicMap = hourMap.get(hour)!
      for (const topic of r.topics) {
        topicMap.set(topic, (topicMap.get(topic) || 0) + 1)
      }
    }

    const stats: HourlyTopicStat[] = []
    for (const [hour, topicMap] of hourMap) {
      const topics = [...topicMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([topic, count]) => ({ topic, count }))
      stats.push({ hour, topics })
    }
    stats.sort((a, b) => a.hour - b.hour)
    return stats
  }

  /** 获取当前时段的推荐主题（用于预加载相关记忆） */
  getSuggestedTopicsForHour(hour: number): string[] {
    const stats = this.getHourlyTopicStats()
    const match = stats.find((s) => s.hour === hour)
    if (!match) return []
    return match.topics.filter((t) => t.count >= 2).map((t) => t.topic)
  }

  /** 获取用户明确要求记住的交互数量 */
  getExplicitRememberCount(since?: number): number {
    const filtered = since ? this.ring.filter((r) => r.timestamp >= since) : this.ring
    return filtered.filter((r) => r.isExplicitRemember).length
  }

  /** 获取重新提及率（最近 N 次交互中有多少次重新提及了旧记忆） */
  getRementionRate(): number {
    if (this.ring.length === 0) return 0
    const withRemention = this.ring.filter((r) => r.rementionedMemoryIds.length > 0).length
    return withRemention / this.ring.length
  }

  // ── 持久化 ──

  private saveToDb(record: InteractionRecord): void {
    try {
      const db = getRawDb()
      db.run(
        `INSERT INTO interaction_log (id, user_text, response_time_ms, topics, is_explicit_remember, rementioned_memory_ids, timestamp, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.userText,
          record.responseTimeMs,
          JSON.stringify(record.topics),
          record.isExplicitRemember ? 1 : 0,
          JSON.stringify(record.rementionedMemoryIds),
          record.timestamp,
          record.createdAt,
        ],
      )
      markDirty()
    } catch (err) {
      log('WARN', 'interaction_save_failed', { error: String(err) })
    }
  }

  /** 清理超出保留期限的旧记录（保留最近 100 条） */
  prune(maxRecords = 100): void {
    try {
      const db = getRawDb()
      const count = Number(
        db.exec('SELECT COUNT(*) AS c FROM interaction_log')[0]?.values[0]?.[0] || 0,
      )
      if (count > maxRecords) {
        db.run(
          `DELETE FROM interaction_log WHERE id IN (SELECT id FROM interaction_log ORDER BY timestamp ASC LIMIT ?)`,
          [count - maxRecords],
        )
        markDirty()
      }
    } catch {
      /* ignore */
    }
  }

  private mapRow(obj: any): InteractionRecord {
    const parseJson = (val: any, fallback: any): any => {
      if (val === null || val === undefined) return fallback
      if (Array.isArray(val)) return val
      try {
        return JSON.parse(val)
      } catch {
        return fallback
      }
    }
    return {
      id: obj.id,
      userText: obj.user_text || '',
      responseTimeMs: obj.response_time_ms ?? null,
      topics: parseJson(obj.topics, []),
      isExplicitRemember: obj.is_explicit_remember === 1 || obj.is_explicit_remember === true,
      rementionedMemoryIds: parseJson(obj.rementioned_memory_ids, []),
      timestamp: obj.timestamp,
      createdAt: obj.created_at || obj.timestamp,
    }
  }
}
