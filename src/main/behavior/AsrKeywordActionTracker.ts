/**
 * AsrKeywordActionTracker — ASR 关键词行为动作预测跟踪器
 *
 * ## 职责
 * 1. 接收 ASR 实时识别的语音文本
 * 2. 提取领域关键词并映射到行为动作（如"查资料"→浏览、"放音乐"→听歌）
 * 3. 按时间周期（15 分钟桶 + 星期几）统计各动作的出现模式
 * 4. 为 Wallpaper 提供个性化的动作预测提示（如"上午好，要打开浏览器吗？"）
 *
 * ## 与现有系统的关系
 * - BehaviorPeriodicPredictor：使用 interaction_log 做话题预测
 * - AsrKeywordActionTracker：专门从 ASR 转录流中提取关键词并映射为动作级预测
 * - BehaviorPeriodicPreloadService：消费本跟踪器的预测，推送到 Wallpaper 显示
 * - AsrService.transcribe()：每次 ASR 识别完成后调用 recordTranscription()
 *
 * ## 设计原则
 * - 轻量级：所有计算同步完成，不阻塞 ASR 主路径
 * - 渐进式：样本不足时返回保守（空）预测
 * - 组合友好：预测结果合并到 BehaviorPeriodicPredictor 的现有输出中
 */
import { log } from '../logger/Logger'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 可预测的行为动作类别 */
export type AsrActionCategory =
  | 'browse'       // 浏览/搜索（浏览器）
  | 'music'        // 听歌/播放音乐
  | 'weather'      // 查看天气
  | 'news'         // 浏览新闻
  | 'code'         // 编程/代码
  | 'schedule'     // 日程/计划
  | 'write'        // 写作
  | 'translate'    // 翻译
  | 'image'        // 图片/设计
  | 'study'        // 学习/查资料
  | 'video'        // 视频
  | 'help'         // 帮助

/** 动作预测输出 */
export interface AsrActionPrediction {
  /** 动作类别 */
  category: AsrActionCategory
  /** 置信度 (0–1) */
  confidence: number
  /** 该动作在此时段的出现次数 */
  occurrenceCount: number
  /** 周期性强度 (0–1) */
  periodicityStrength: number
  /** 是否建议主动提示 */
  suggestHint: boolean
  /** 动作描述（如"打开浏览器"） */
  actionLabel: string
  /** 完整提示文本（如"上午好，要打开浏览器吗？"） */
  hintMessage: string
  /** 关联的图标 */
  icon: string
}

/** 时段动作预测结果 */
export interface TimeSlotActionPrediction {
  /** 小时桶键 "h:b" */
  slotKey: string
  /** 小时 */
  hour: number
  /** 15 分桶 */
  bucket: number
  /** 星期几 (0–6) */
  dayOfWeek: number
  /** 时段标签 */
  periodLabel: string
  /** 预测列表（按置信度降序） */
  predictions: AsrActionPrediction[]
  /** 是否有足够置信的预测 */
  actionable: boolean
}

/** 跟踪器统计信息 */
export interface AsrKeywordTrackerStats {
  totalRecords: number
  slotCount: number
  activeActions: AsrActionCategory[]
  isDataSufficient: boolean
}

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 分析窗口：最近 7 天的 ASR 转录记录 */
const ANALYSIS_WINDOW_DAYS = 7

/** 最小有效样本数 */
const MIN_SAMPLES = 3

/** 最大保留的转录记录数 */
const MAX_RECORDS = 500

/** 小时桶数（15 分钟一个桶） */
const BUCKETS_PER_HOUR = 4

/** 每桶分钟数 */
const MINUTES_PER_BUCKET = 60 / BUCKETS_PER_HOUR

/** 一周天数 */
const DAYS_OF_WEEK = 7

/** 置信度阈值：高于此值才生成壁纸提示 */
const HINT_CONFIDENCE_THRESHOLD = 0.3

/** 周期性强度阈值 */
const PERIODICITY_STRENGTH_THRESHOLD = 0.25

/** 每个时段保留的最大预测数 */
const MAX_PREDICTIONS_PER_SLOT = 3

/**
 * 关键词 → 动作类别映射。
 * 中文领域关键词 -> 对应的行为动作类别。
 */
const KEYWORD_ACTION_MAP: Record<string, AsrActionCategory> = {
  // 浏览/搜索
  '查资料': 'browse',
  '查一下': 'browse',
  '搜索': 'browse',
  '搜一下': 'browse',
  '查找': 'browse',
  '找资料': 'browse',
  '找文件': 'browse',
  '上网': 'browse',
  '浏览器': 'browse',
  '打开网页': 'browse',
  '打开浏览器': 'browse',
  '查询': 'browse',
  '搜': 'browse',
  // 音乐
  '放音乐': 'music',
  '播放': 'music',
  '听歌': 'music',
  '唱歌': 'music',
  '歌曲': 'music',
  '歌': 'music',
  '音乐': 'music',
  '歌单': 'music',
  '旋律': 'music',
  '听音乐': 'music',
  '放歌': 'music',
  // 天气
  '天气': 'weather',
  '温度': 'weather',
  '下雨': 'weather',
  '下雪': 'weather',
  '刮风': 'weather',
  '台风': 'weather',
  '气温': 'weather',
  '预报': 'weather',
  '气候': 'weather',
  // 新闻
  '新闻': 'news',
  '时事': 'news',
  '报道': 'news',
  '热点': 'news',
  '头条': 'news',
  '最新消息': 'news',
  // 编程
  '代码': 'code',
  '编程': 'code',
  '写代码': 'code',
  '调试': 'code',
  '重构': 'code',
  '编译': 'code',
  '部署': 'code',
  '开发': 'code',
  '程序': 'code',
  // 日程
  '日程': 'schedule',
  '计划': 'schedule',
  '安排': 'schedule',
  '待办': 'schedule',
  '会议': 'schedule',
  '预约': 'schedule',
  '提醒': 'schedule',
  // 写作
  '写作': 'write',
  '写文章': 'write',
  '写': 'write',
  '文案': 'write',
  '创作': 'write',
  '文档': 'write',
  '编辑': 'write',
  // 翻译
  '翻译': 'translate',
  '英文': 'translate',
  '中文': 'translate',
  '外语': 'translate',
  // 图片
  '图片': 'image',
  '图像': 'image',
  '照片': 'image',
  '画图': 'image',
  '设计图': 'image',
  '生成图': 'image',
  '画画': 'image',
  // 学习
  '学习': 'study',
  '教程': 'study',
  '教学': 'study',
  '课程': 'study',
  '练习': 'study',
  '理解': 'study',
  '概念': 'study',
  // 视频
  '视频': 'video',
  '看电影': 'video',
  '看剧': 'video',
  '短视频': 'video',
  '播放视频': 'video',
  '看视频': 'video',
  // 帮助
  '帮助': 'help',
  '怎么': 'help',
  '如何': 'help',
  '能不能': 'help',
  '可以吗': 'help',
  '怎样': 'help',
}

/** 动作类别 → 显示文本 */
const ACTION_LABELS: Record<AsrActionCategory, string> = {
  browse: '打开浏览器',
  music: '播放歌单',
  weather: '查看天气',
  news: '浏览新闻',
  code: '打开编辑器',
  schedule: '查看日程',
  write: '开始写作',
  translate: '翻译内容',
  image: '生成图片',
  study: '查资料学习',
  video: '看视频',
  help: '寻求帮助',
}

/** 动作类别 → 图标 */
const ACTION_ICONS: Record<AsrActionCategory, string> = {
  browse: '🌐',
  music: '🎵',
  weather: '🌤️',
  news: '📰',
  code: '💻',
  schedule: '📅',
  write: '✍️',
  translate: '🔤',
  image: '🎨',
  study: '📚',
  video: '🎬',
  help: '❓',
}

/** 时段标签 */
function getPeriodLabel(hour: number): string {
  if (hour >= 5 && hour < 9) return '早晨'
  if (hour >= 9 && hour < 12) return '上午'
  if (hour >= 12 && hour < 14) return '中午'
  if (hour >= 14 && hour < 18) return '下午'
  if (hour >= 18 && hour < 22) return '晚间'
  return '深夜'
}

/** 时段问候语前缀 */
function getGreetingPrefix(hour: number): string {
  if (hour >= 5 && hour < 9) return '早上好'
  if (hour >= 9 && hour < 12) return '上午好'
  if (hour >= 12 && hour < 14) return '中午好'
  if (hour >= 14 && hour < 18) return '下午好'
  if (hour >= 18 && hour < 22) return '晚上好'
  return '你好'
}

// ══════════════════════════════════════════
//  单条转录记录
// ══════════════════════════════════════════

interface AsrTranscriptionRecord {
  /** ASR 识别的文本 */
  text: string
  /** 提取到的动作类别 */
  detectedActions: AsrActionCategory[]
  /** 时间戳 */
  timestamp: number
}

// ══════════════════════════════════════════
//  AsrKeywordActionTracker
// ══════════════════════════════════════════

export class AsrKeywordActionTracker {
  /** 滑动窗口中的转录记录 */
  private records: AsrTranscriptionRecord[] = []

  /** 最大记录数 */
  private readonly maxRecords: number

  /** 懒计算的时段预测缓存 */
  private cachedSlots: Map<string, TimeSlotActionPrediction> | null = null

  /** 缓存最后更新时间的时段键 */
  private lastSlotKey = ''

  /** 缓存是否有效 */
  private cacheValid = false

  constructor(maxRecords = MAX_RECORDS) {
    this.maxRecords = maxRecords
  }

  // ══════════════════════════════════════════
  //  公共接口
  // ══════════════════════════════════════════

  /**
   * 记录一次 ASR 转录结果。
   * 应在 AsrService.transcribe() 成功后调用。
   */
  recordTranscription(text: string, timestamp = Date.now()): void {
    if (!text || text.trim().length === 0) return

    const trimmed = text.trim()
    const detectedActions = this.extractActions(trimmed)

    if (detectedActions.length === 0) return

    this.records.push({
      text: trimmed,
      detectedActions,
      timestamp,
    })

    // 裁剪超出上限的旧记录
    while (this.records.length > this.maxRecords) {
      this.records.shift()
    }

    // 使缓存失效
    this.cacheValid = false

    log('DEBUG', 'asr_keyword_action_recorded', {
      text: trimmed.slice(0, 30),
      actions: detectedActions,
      totalRecords: this.records.length,
    })
  }

  /**
   * 批量记录（用于初始化或恢复历史数据）。
   */
  recordBatch(entries: Array<{ text: string; timestamp: number }>): void {
    for (const entry of entries) {
      this.recordTranscription(entry.text, entry.timestamp)
    }
  }

  /**
   * 获取当前时段的动作预测。
   */
  predictCurrentSlot(): TimeSlotActionPrediction | null {
    const now = new Date()
    const dayOfWeek = now.getDay()
    const hour = now.getHours()
    const minute = now.getMinutes()
    const bucket = Math.floor(minute / MINUTES_PER_BUCKET)
    const slotKey = `${dayOfWeek}:${hour}:${bucket}`

    return this.getOrBuildSlot(slotKey, dayOfWeek, hour, bucket)
  }

  /**
   * 获取即将到来时段（最多 1 小时）的动作预测。
   */
  predictUpcomingSlots(lookaheadBuckets = 4): TimeSlotActionPrediction[] {
    const now = new Date()
    const dayOfWeek = now.getDay()
    const currentHour = now.getHours()
    const currentMinute = now.getMinutes()
    const currentBucket = Math.floor(currentMinute / MINUTES_PER_BUCKET)

    const results: TimeSlotActionPrediction[] = []
    const currentSlotIndex = currentHour * BUCKETS_PER_HOUR + currentBucket
    const maxBuckets = 24 * BUCKETS_PER_HOUR

    for (let i = 1; i <= lookaheadBuckets; i++) {
      const nextSlotIndex = (currentSlotIndex + i) % maxBuckets
      const h = Math.floor(nextSlotIndex / BUCKETS_PER_HOUR)
      const b = nextSlotIndex % BUCKETS_PER_HOUR
      let dow = dayOfWeek
      if (nextSlotIndex < currentSlotIndex) {
        dow = (dow + 1) % DAYS_OF_WEEK
      }
      const slotKey = `${dow}:${h}:${b}`
      const slot = this.getOrBuildSlot(slotKey, dow, h, b)
      if (slot && slot.actionable) {
        results.push(slot)
      }
    }

    return results
  }

  /**
   * 获取当前时段最佳的动作提示消息（供 Wallpaper 直接使用）。
   * 返回 null 表示无足够置信的预测。
   */
  getCurrentHint(): { message: string; icon: string; category: AsrActionCategory; confidence: number } | null {
    const slot = this.predictCurrentSlot()
    if (!slot || !slot.actionable || slot.predictions.length === 0) return null

    const best = slot.predictions[0]
    return {
      message: best.hintMessage,
      icon: best.icon,
      category: best.category,
      confidence: best.confidence,
    }
  }

  /**
   * 获取所有有数据的时段预测（用于构建完整的周期性模型）。
   */
  getAllSlots(): Map<string, TimeSlotActionPrediction> {
    if (this.cacheValid && this.cachedSlots) return this.cachedSlots

    if (this.records.length < MIN_SAMPLES) {
      this.cachedSlots = new Map()
      this.cacheValid = true
      return this.cachedSlots
    }

    this.cachedSlots = this.buildAllSlots()
    this.cacheValid = true
    return this.cachedSlots
  }

  /** 获取统计信息 */
  getStats(): AsrKeywordTrackerStats {
    const activeActions = new Set<AsrActionCategory>()
    for (const rec of this.records) {
      for (const action of rec.detectedActions) {
        activeActions.add(action)
      }
    }
    const allSlots = this.cacheValid && this.cachedSlots
      ? this.cachedSlots
      : this.getAllSlots()
    return {
      totalRecords: this.records.length,
      slotCount: allSlots.size,
      activeActions: Array.from(activeActions),
      isDataSufficient: this.records.length >= MIN_SAMPLES,
    }
  }

  /** 清空所有记录 */
  reset(): void {
    this.records = []
    this.cachedSlots = null
    this.cacheValid = false
    log('INFO', 'asr_keyword_action_tracker_reset')
  }

  // ══════════════════════════════════════════
  //  内部：关键词提取
  // ══════════════════════════════════════════

  /**
   * 从文本中提取匹配的动作类别。
   * 使用 KEYWORD_ACTION_MAP 做关键词匹配。
   */
  private extractActions(text: string): AsrActionCategory[] {
    if (!text || text.length === 0) return []

    const detected = new Set<AsrActionCategory>()
    const lower = text.toLowerCase()

    // 按关键词长度降序排序（优先匹配长词，避免短词先匹配阻断长词）
    const sortedKeywords = Object.keys(KEYWORD_ACTION_MAP).sort(
      (a, b) => b.length - a.length,
    )

    for (const keyword of sortedKeywords) {
      if (lower.includes(keyword)) {
        detected.add(KEYWORD_ACTION_MAP[keyword])
      }
    }

    return Array.from(detected)
  }

  // ══════════════════════════════════════════
  //  内部：时段构建
  // ══════════════════════════════════════════

  /**
   * 获取或构建单个时段的预测。
   */
  private getOrBuildSlot(
    slotKey: string,
    dayOfWeek: number,
    hour: number,
    bucket: number,
  ): TimeSlotActionPrediction | null {
    // 如果完整缓存可用且有该时段，直接返回
    if (this.cacheValid && this.cachedSlots) {
      return this.cachedSlots.get(slotKey) ?? null
    }

    // 否则只计算这一个时段（轻量，不构建全量模型）
    const relevant = this.records.filter((rec) => {
      if (rec.detectedActions.length === 0) return false
      const d = new Date(rec.timestamp)
      return (
        d.getDay() === dayOfWeek &&
        d.getHours() === hour &&
        Math.floor(d.getMinutes() / MINUTES_PER_BUCKET) === bucket
      )
    })

    if (relevant.length < MIN_SAMPLES) return null

    return this.buildSlotFromRecords(slotKey, dayOfWeek, hour, bucket, relevant)
  }

  /**
   * 从匹配的记录构建一个时段预测。
   */
  private buildSlotFromRecords(
    slotKey: string,
    dayOfWeek: number,
    hour: number,
    bucket: number,
    records: AsrTranscriptionRecord[],
  ): TimeSlotActionPrediction {
    const now = Date.now()

    // 统计每个动作在此时段出现的次数
    const actionCounts = new Map<AsrActionCategory, { count: number; lastSeen: number }>()
    for (const rec of records) {
      for (const action of rec.detectedActions) {
        const existing = actionCounts.get(action)
        if (existing) {
          existing.count++
          existing.lastSeen = Math.max(existing.lastSeen, rec.timestamp)
        } else {
          actionCounts.set(action, { count: 1, lastSeen: rec.timestamp })
        }
      }
    }

    const totalInSlot = records.length
    const predictions: AsrActionPrediction[] = []

    for (const [category, data] of actionCounts) {
      if (data.count < MIN_SAMPLES) continue

      // 频率占比
      const frequencyRatio = data.count / totalInSlot
      // 近因加权
      const recencyDays = (now - data.lastSeen) / (24 * 60 * 60 * 1000)
      const recencyWeight = Math.max(0.3, 1 - recencyDays / ANALYSIS_WINDOW_DAYS)
      // 周期性强度
      const periodicityStrength = Math.min(frequencyRatio * 2, 1)
      // 综合置信度
      const confidence = Math.round(
        Math.min(frequencyRatio * recencyWeight * 1.5, 1) * 100,
      ) / 100

      const actionLabel = ACTION_LABELS[category]
      const greeting = getGreetingPrefix(hour)
      const hintMessage = `${greeting}，要${actionLabel}吗？`

      predictions.push({
        category,
        confidence,
        occurrenceCount: data.count,
        periodicityStrength,
        suggestHint:
          confidence >= HINT_CONFIDENCE_THRESHOLD &&
          periodicityStrength >= PERIODICITY_STRENGTH_THRESHOLD,
        actionLabel,
        hintMessage,
        icon: ACTION_ICONS[category],
      })
    }

    if (predictions.length === 0) {
      return {
        slotKey,
        hour,
        bucket,
        dayOfWeek,
        periodLabel: getPeriodLabel(hour),
        predictions: [],
        actionable: false,
      }
    }

    // 按置信度降序，取 Top-N
    predictions.sort((a, b) => b.confidence - a.confidence)
    const topPredictions = predictions.slice(0, MAX_PREDICTIONS_PER_SLOT)
    const hasActionable = topPredictions.some((p) => p.suggestHint)

    return {
      slotKey,
      hour,
      bucket,
      dayOfWeek,
      periodLabel: getPeriodLabel(hour),
      predictions: topPredictions,
      actionable: hasActionable,
    }
  }

  /**
   * 构建所有时段的预测模型（全量计算）。
   */
  private buildAllSlots(): Map<string, TimeSlotActionPrediction> {
    const slots = new Map<string, TimeSlotActionPrediction>()

    if (this.records.length < MIN_SAMPLES) return slots

    // 按 (dayOfWeek, hour, bucket) 分组
    const grouped = new Map<string, AsrTranscriptionRecord[]>()
    for (const rec of this.records) {
      const d = new Date(rec.timestamp)
      const dow = d.getDay()
      const h = d.getHours()
      const b = Math.floor(d.getMinutes() / MINUTES_PER_BUCKET)
      const key = `${dow}:${h}:${b}`
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(rec)
    }

    for (const [slotKey, recs] of grouped) {
      const [dowStr, hourStr, bucketStr] = slotKey.split(':')
      const dayOfWeek = parseInt(dowStr, 10)
      const hour = parseInt(hourStr, 10)
      const bucket = parseInt(bucketStr, 10)

      if (recs.length < MIN_SAMPLES) continue

      const slot = this.buildSlotFromRecords(slotKey, dayOfWeek, hour, bucket, recs)
      if (slot.predictions.length > 0) {
        slots.set(slotKey, slot)
      }
    }

    return slots
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const asrKeywordActionTracker = new AsrKeywordActionTracker()
