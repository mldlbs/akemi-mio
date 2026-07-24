/**
 * BehaviorPeriodicPredictor — 用户查询内容 × 时间周期预测模型
 *
 * ## 职责
 * 1. 从 interaction_log 读取历史交互记录
 * 2. 按时间段（小时 + 15分桶 + 星期几）分桶统计用户查询内容模式
 * 3. 计算每个时段的高频查询意图及其置信度
 * 4. 输出预测：当前时段用户最可能的需求是什么
 *
 * ## 与现有系统的关系
 * - PeriodicPatternAnalyzer（mcp/）预测的是"工具名"级别
 * - BehaviorPeriodicPredictor 预测的是"查询内容/意图"级别
 * - BehaviorPeriodicPreloadService 使用预测结果执行内容预加载 + 哑提醒
 *
 * ## 轻打扰设计
 * - 低置信度预测不触发任何操作
 * - 非周期性行为不干预（periodicityStrength < 阈值）
 * - 展示方式为"哑提醒"：图标提示，不抢占焦点
 * - 用户可一键忽略
 */

import { log } from '../logger/Logger'
import { getRawDb } from '../db/connection'
import type { InteractionRecord } from '../memory/types'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 分析窗口：最近 14 天的交互记录 */
const ANALYSIS_WINDOW_DAYS = 14

/** 最小交互数要求 */
const MIN_INTERACTIONS_SLOT = 3

/** 小时桶数（15分钟一个桶） */
const BUCKETS_PER_HOUR = 4

/** 每桶分钟数 */
const MINUTES_PER_BUCKET = 60 / BUCKETS_PER_HOUR

/** 一周的天数 */
const DAYS_OF_WEEK = 7

/** 置信度阈值：高于此值才触发预加载 */
const PREDICTION_CONFIDENCE_THRESHOLD = 0.35

/** 周期性强度阈值 */
const PERIODICITY_STRENGTH_THRESHOLD = 0.3

/** 每个时段保留的预测数量 */
const MAX_PREDICTIONS_PER_SLOT = 5

/** 中文话题关键词映射（复用 BehaviorPatternMiner 的策略） */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  '天气': ['天气', '温度', '下雨', '下雪', '刮风', '晴', '阴', '台风', '气温', '预报', '气候'],
  '时间': ['时间', '几点', '现在', '日期', '今天', '明天', '昨天', '星期', '月份', '钟'],
  '新闻': ['新闻', '时事', '报道', '最新', '热点', '头条', '消息'],
  '编程': ['代码', '编程', '写代码', 'bug', '调试', '重构', '算法', '编译', '部署', '程序'],
  '写作': ['写', '文章', '内容', '创作', '文案', '文本', '文档', '编辑', '小说'],
  '学习': ['学习', '教程', '教学', '课程', '练习', '理解', '概念'],
  '翻译': ['翻译', '英文', '中文', '语言', '外语', '意思'],
  '图片': ['图片', '图像', '照片', '画画', '生成图', '画图', '设计图'],
  '音乐': ['音乐', '歌', '播放', '曲', '旋律', '歌词'],
  '视频': ['视频', '播放', '看', '电影', '剧', '短视频'],
  '搜索': ['搜索', '查找', '找', '查询', '搜一下'],
  '设置': ['设置', '配置', '修改', '调整', '更改', '选项'],
  '帮助': ['帮助', '怎么', '如何', '能不能', '可以吗', '怎样'],
  '推荐': ['推荐', '建议', '什么好', '选择', '推'],
  '日程': ['日程', '计划', '安排', '待办', '会议', '预约', '提醒'],
  '交通': ['交通', '路况', '公交', '地铁', '打车', '导航', '路线', '堵车'],
}

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 查询意图预测 */
export interface PeriodicQueryPrediction {
  /** 预测的查询话题标签 */
  topic: string
  /** 置信度 (0-1) */
  confidence: number
  /** 周期性强度 (0-1) */
  periodicityStrength: number
  /** 该话题在此时段的出现次数 */
  occurrenceCount: number
  /** 最近一次出现的时间戳 */
  lastOccurrence: number
  /** 是否建议主动预加载 */
  suggestPreload: boolean
  /** 预测的占位描述（如"查看天气"） */
  description: string
  /** 关联的工具名（如果有） */
  associatedTool?: string
}

/** 时段预测完整结果 */
export interface TimeSlotPrediction {
  /** 小时桶键 "h:b" */
  slotKey: string
  /** 小时 */
  hour: number
  /** 15 分桶 */
  bucket: number
  /** 星期几 (0-6) */
  dayOfWeek: number
  /** 时段标签（如"早晨""上午"） */
  periodLabel: string
  /** 预测列表（按置信度降序） */
  predictions: PeriodicQueryPrediction[]
  /** 是否足够置信以触发预加载 */
  actionable: boolean
}

/** 周期性预测模型快照 */
export interface PeriodicPredictionModel {
  /** 按时段键 → 预测列表 */
  slots: Map<string, TimeSlotPrediction>
  /** 模型生成时间 */
  generatedAt: number
  /** 覆盖的交互数 */
  totalInteractions: number
  /** 数据是否充足 */
  hasSufficientData: boolean
}

/** 推送到渲染进程的预测事件 */
export interface PeriodicPredictionEvent {
  /** 预测的话题 */
  topic: string
  /** 描述文本 */
  description: string
  /** 置信度 (0-1) */
  confidence: number
  /** 关联工具名 */
  associatedTool?: string
  /** 是否已预加载内容 */
  preloaded: boolean
  /** 唯一事件 ID */
  eventId: string
  /** 过期时间戳（超过此时间不再展示） */
  expiresAt: number
}

// ══════════════════════════════════════════
//  BehaviorPeriodicPredictor
// ══════════════════════════════════════════

/**
 * 周期性行为预测模型。
 *
 * 从历史交互记录中提取"星期几 + 小时 + 15分桶"→ 高频查询话题 的映射，
 * 用于预测用户在特定时间段最可能的行为。
 */
export class BehaviorPeriodicPredictor {
  /** 缓存的预测模型 */
  private model: PeriodicPredictionModel | null = null
  /** 缓存生成时间 */
  private cachedAt = 0
  /** 缓存 TTL：10 分钟 */
  private static readonly CACHE_TTL_MS = 10 * 60 * 1000

  /**
   * 构建或刷新周期性预测模型。
   * 从 DB 加载最近 N 天的交互记录，按"星期几 + 小时桶"分组，
   * 提取每个时段的高频查询话题。
   */
  buildModel(): PeriodicPredictionModel {
    const now = Date.now()

    // 缓存命中
    if (this.model && now - this.cachedAt < BehaviorPeriodicPredictor.CACHE_TTL_MS) {
      return this.model
    }

    const since = now - ANALYSIS_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const interactions = this.loadInteractions(since)

    if (interactions.length < MIN_INTERACTIONS_SLOT) {
      const empty: PeriodicPredictionModel = {
        slots: new Map(),
        generatedAt: now,
        totalInteractions: 0,
        hasSufficientData: false,
      }
      this.model = empty
      this.cachedAt = now
      return empty
    }

    // 按 (dayOfWeek, hourKey) 分组统计话题出现频率
    const slotTopicMap = new Map<string, Map<string, { count: number; lastSeen: number }>>()

    for (const rec of interactions) {
      const date = new Date(rec.timestamp)
      const dayOfWeek = date.getDay()
      const hour = date.getHours()
      const minute = date.getMinutes()
      const bucket = Math.floor(minute / MINUTES_PER_BUCKET)
      const slotKey = `${dayOfWeek}:${hour}:${bucket}`

      // 从用户文本中提取话题
      const keywords = this.extractKeywords(rec.userText)
      if (keywords.length === 0) continue

      if (!slotTopicMap.has(slotKey)) {
        slotTopicMap.set(slotKey, new Map())
      }
      const topicMap = slotTopicMap.get(slotKey)!

      for (const topic of keywords) {
        if (!topicMap.has(topic)) {
          topicMap.set(topic, { count: 0, lastSeen: 0 })
        }
        const entry = topicMap.get(topic)!
        entry.count++
        entry.lastSeen = Math.max(entry.lastSeen, rec.timestamp)
      }
    }

    // 构建每个时段的预测
    const slots = new Map<string, TimeSlotPrediction>()

    for (const [slotKey, topicMap] of slotTopicMap) {
      const [dowStr, hourStr, bucketStr] = slotKey.split(':')
      const dayOfWeek = parseInt(dowStr, 10)
      const hour = parseInt(hourStr, 10)
      const bucket = parseInt(bucketStr, 10)

      // 计算该时段总交互数（用于算比例）
      const totalInSlot = interactions.filter((r) => {
        const d = new Date(r.timestamp)
        return d.getDay() === dayOfWeek && d.getHours() === hour &&
          Math.floor(d.getMinutes() / MINUTES_PER_BUCKET) === bucket
      }).length

      if (totalInSlot < MIN_INTERACTIONS_SLOT) continue

      const predictions: PeriodicQueryPrediction[] = []

      for (const [topic, data] of topicMap) {
        if (data.count < MIN_INTERACTIONS_SLOT) continue

        // 频率占比
        const frequencyRatio = data.count / totalInSlot
        // 近因加权：近期出现的模式置信度更高
        const recencyDays = (now - data.lastSeen) / (24 * 60 * 60 * 1000)
        const recencyWeight = Math.max(0.3, 1 - recencyDays / ANALYSIS_WINDOW_DAYS)
        // 周期性强度
        const periodicityStrength = Math.min(frequencyRatio * 2, 1)
        // 综合置信度
        const confidence = Math.round(Math.min(frequencyRatio * recencyWeight * 1.5, 1) * 100) / 100

        predictions.push({
          topic,
          confidence,
          periodicityStrength,
          occurrenceCount: data.count,
          lastOccurrence: data.lastSeen,
          suggestPreload: confidence >= PREDICTION_CONFIDENCE_THRESHOLD && periodicityStrength >= PERIODICITY_STRENGTH_THRESHOLD,
          description: this.getPredictionDescription(topic),
          associatedTool: this.getAssociatedTool(topic),
        })
      }

      if (predictions.length === 0) continue

      // 按置信度降序，取 Top-N
      predictions.sort((a, b) => b.confidence - a.confidence)
      const topPredictions = predictions.slice(0, MAX_PREDICTIONS_PER_SLOT)
      const hasActionable = topPredictions.some((p) => p.suggestPreload)

      slots.set(slotKey, {
        slotKey,
        hour,
        bucket,
        dayOfWeek,
        periodLabel: this.getPeriodLabel(hour),
        predictions: topPredictions,
        actionable: hasActionable,
      })
    }

    const model: PeriodicPredictionModel = {
      slots,
      generatedAt: now,
      totalInteractions: interactions.length,
      hasSufficientData: slots.size > 0,
    }

    this.model = model
    this.cachedAt = now

    log('INFO', 'periodic_predictor_model_built', {
      slots: slots.size,
      interactions: interactions.length,
      hasData: model.hasSufficientData,
    })

    return model
  }

  /**
   * 获取当前时段的预测。
   * 基于当前时间和星期几，查找最匹配的时段预测。
   */
  predictCurrentSlot(): TimeSlotPrediction | null {
    const now = new Date()
    const dayOfWeek = now.getDay()
    const hour = now.getHours()
    const minute = now.getMinutes()
    const bucket = Math.floor(minute / MINUTES_PER_BUCKET)
    const slotKey = `${dayOfWeek}:${hour}:${bucket}`

    const model = this.buildModel()
    return model.slots.get(slotKey) ?? null
  }

  /**
   * 获取即将到来时段的预测（用于提前预加载）。
   * 支持查找 next N 个桶（最多 1 小时）的预测。
   */
  predictUpcomingSlots(lookaheadBuckets = 4): TimeSlotPrediction[] {
    const now = new Date()
    const dayOfWeek = now.getDay()
    const currentHour = now.getHours()
    const currentMinute = now.getMinutes()
    const currentBucket = Math.floor(currentMinute / MINUTES_PER_BUCKET)

    const model = this.buildModel()
    const results: TimeSlotPrediction[] = []

    // 从当前桶之后开始，检查后续桶
    const currentSlotIndex = currentHour * BUCKETS_PER_HOUR + currentBucket
    const maxBuckets = 24 * BUCKETS_PER_HOUR

    for (let i = 1; i <= lookaheadBuckets; i++) {
      const nextSlotIndex = (currentSlotIndex + i) % maxBuckets
      const h = Math.floor(nextSlotIndex / BUCKETS_PER_HOUR)
      const b = nextSlotIndex % BUCKETS_PER_HOUR
      // 如果跨天，调整 dayOfWeek
      let dow = dayOfWeek
      if (nextSlotIndex < currentSlotIndex) {
        dow = (dow + 1) % DAYS_OF_WEEK
      }
      const slotKey = `${dow}:${h}:${b}`
      const slot = model.slots.get(slotKey)
      if (slot && slot.actionable) {
        results.push(slot)
      }
    }

    return results
  }

  /** 清空缓存，强制下次构建重新分析 */
  clearCache(): void {
    this.model = null
    this.cachedAt = 0
  }

  /** 获取模型统计 */
  getStats(): { hasModel: boolean; slotsCount: number; totalInteractions: number; cacheAgeMs: number } {
    return {
      hasModel: this.model !== null,
      slotsCount: this.model?.slots.size ?? 0,
      totalInteractions: this.model?.totalInteractions ?? 0,
      cacheAgeMs: this.cachedAt > 0 ? Date.now() - this.cachedAt : -1,
    }
  }

  // ── 内部方法 ──

  /** 从文本中提取话题关键词 */
  private extractKeywords(text: string): string[] {
    if (!text) return []
    const lower = text.toLowerCase()
    const keywords: string[] = []

    for (const [topic, words] of Object.entries(TOPIC_KEYWORDS)) {
      for (const word of words) {
        if (lower.includes(word)) {
          keywords.push(topic)
          break
        }
      }
    }

    return [...new Set(keywords)].slice(0, 3)
  }

  /** 根据小时获取时段标签 */
  private getPeriodLabel(hour: number): string {
    if (hour >= 6 && hour < 9) return '早晨'
    if (hour >= 9 && hour < 12) return '上午'
    if (hour >= 12 && hour < 14) return '中午'
    if (hour >= 14 && hour < 18) return '下午'
    if (hour >= 18 && hour < 22) return '晚间'
    return '深夜'
  }

  /** 生成人类可读的预测描述 */
  private getPredictionDescription(topic: string): string {
    const descriptions: Record<string, string> = {
      '天气': '查看天气状况',
      '时间': '查询时间/日期',
      '新闻': '浏览新闻',
      '编程': '开发工作',
      '写作': '写作任务',
      '学习': '学习或查资料',
      '翻译': '翻译内容',
      '图片': '生成或处理图片',
      '音乐': '听音乐',
      '视频': '看视频',
      '搜索': '搜索信息',
      '设置': '修改设置',
      '帮助': '寻求帮助',
      '推荐': '获取推荐',
      '日程': '查看日程安排',
      '交通': '查看交通信息',
    }
    return descriptions[topic] || `关于「${topic}」的查询`
  }

  /** 根据话题推断可能使用的工具 */
  private getAssociatedTool(topic: string): string | undefined {
    const toolMap: Record<string, string> = {
      '天气': 'query_trends',
      '新闻': 'query_trends',
      '编程': 'grep',
      '写作': 'writing_system',
      '图片': 'generate_image',
      '搜索': 'search_code',
    }
    return toolMap[topic]
  }

  /** 从 DB 加载交互记录 */
  private loadInteractions(since: number): InteractionRecord[] {
    const records: InteractionRecord[] = []
    try {
      const db = getRawDb()
      const result = db.exec(
        `SELECT id, user_text, topics, timestamp, created_at
         FROM interaction_log
         WHERE timestamp >= ${since}
         ORDER BY timestamp ASC`,
      )
      if (result && result.length > 0) {
        const columns = result[0].columns
        for (const row of result[0].values) {
          const obj: any = {}
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i]
          records.push({
            id: obj.id,
            userText: obj.user_text || '',
            responseTimeMs: null,
            topics: [],
            isExplicitRemember: false,
            rementionedMemoryIds: [],
            timestamp: obj.timestamp || 0,
            createdAt: obj.created_at || 0,
          })
        }
      }
    } catch (err) {
      log('WARN', 'periodic_predictor_load_failed', { error: String(err) })
    }
    return records
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const behaviorPeriodicPredictor = new BehaviorPeriodicPredictor()
