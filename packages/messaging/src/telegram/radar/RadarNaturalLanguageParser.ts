/**
 * RadarNaturalLanguageParser — 自然语言雷达推送规则解析器
 *
 * 使用正则/关键词提取时间、地点、频率：
 * - "每天上午8点"  → frequency=daily, hour=8, minute=0
 * - "每个工作日中午12点" → frequency=weekday, hour=12, minute=0
 * - "每周六晚上7点半" → frequency=weekly, dayOfWeek=6, hour=19, minute=30
 * - "北京 AI创业" → location=北京, keywords=['AI创业']
 * - "周末早上9点上海" → frequency=weekend, hour=9, location=上海
 *
 * ## 设计原则
 *
 * 1. 宽松解析：尽可能从文本中提取有用信息，解析失败的部分使用默认值
 * 2. 用户确认：返回置信度和描述文本，供用户确认
 * 3. 可扩展：关键词字典可随时添加新词条
 */

import type { ParsedRuleIntent, PushFrequency, PushPeriod } from '@akemi-mio/messaging/telegram/radar/types'
import { log } from '@akemi-mio/core/logger/Logger'

// ════════════════════════════════════════════════════════════════
// 时间段映射
// ════════════════════════════════════════════════════════════════

/** 时间段 → 小时范围 */
const PERIOD_HOUR_MAP: Record<PushPeriod, { min: number; max: number; default: number }> = {
  morning: { min: 5, max: 11, default: 8 },
  afternoon: { min: 12, max: 17, default: 14 },
  evening: { min: 18, max: 21, default: 19 },
  night: { min: 22, max: 23, default: 22 },
}

/** 中文时间段关键词 → PushPeriod */
const PERIOD_KEYWORDS: Record<string, PushPeriod> = {
  早上: 'morning',
  上午: 'morning',
  早晨: 'morning',
  中午: 'afternoon',
  下午: 'afternoon',
  晚上: 'evening',
  傍晚: 'evening',
  夜间: 'night',
  半夜: 'night',
  凌晨: 'night',
}

/** 频率关键词 */
const FREQUENCY_KEYWORDS: Array<{ pattern: RegExp; frequency: PushFrequency; dayOfWeek?: number }> = [
  { pattern: /每天|每日|天天/iu, frequency: 'daily' },
  { pattern: /每个工作日|每工作日|工作日|周一至周五|周一到周五/iu, frequency: 'weekday' },
  { pattern: /周末|每周末|周六日|星期六日/iu, frequency: 'weekend' },
  { pattern: /每周([一二三四五六日天]|周[一二三四五六日天])/iu, frequency: 'weekly' },
  { pattern: /每星期([一二三四五六日天])/iu, frequency: 'weekly' },
]

/** 星期映射：中文 → 数字 (0=周日) */
const DAY_OF_WEEK_MAP: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
}

/** 信息源关键词映射 */
const SOURCE_KEYWORDS: Record<string, string> = {
  hackernews: 'hackernews',
  hn: 'hackernews',
  github: 'github_trending',
  git: 'github_trending',
  微博: 'weibo_hot',
  weibo: 'weibo_hot',
  b站: 'bilibili',
  bilibili: 'bilibili',
  抖音: 'douyin',
  rss: 'rss',
  '36氪': '36kr',
  '36kr': '36kr',
  crunchbase: 'crunchbase',
}

/** 中国城市名称列表（常用） */
const CHINESE_CITIES = [
  '北京',
  '上海',
  '广州',
  '深圳',
  '杭州',
  '成都',
  '武汉',
  '南京',
  '西安',
  '长沙',
  '重庆',
  '天津',
  '苏州',
  '青岛',
  '厦门',
  '大连',
  '宁波',
  '郑州',
  '沈阳',
  '济南',
  '昆明',
  '合肥',
  '福州',
  '贵阳',
  '海口',
  '三亚',
  '珠海',
  '佛山',
  '东莞',
  '中山',
  '惠州',
]

/** 国际城市/地区 */
const INTNL_LOCATIONS = ['硅谷', '旧金山', '纽约', '伦敦', '东京', '新加坡', '柏林', '硅谷', '华尔街', '湾区']

// ════════════════════════════════════════════════════════════════
// 正则模式（编译一次，避免重复构造）
// ════════════════════════════════════════════════════════════════

/** 小时:分钟 模式，如 "8:30"、"08:00" */
const TIME_HHMM = /(\d{1,2}):(\d{2})/u

/** 中文时间模式：X点(Y分) / X点半 */
const TIME_CHINESE = /(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分)?/u

/** 只有小时没有分钟的简写，如 "8点" */
const TIME_HOUR_ONLY = /(\d{1,2})\s*点(?!\s*半|\s*\d)/u

// ════════════════════════════════════════════════════════════════
// 解析器
// ════════════════════════════════════════════════════════════════

export class RadarNaturalLanguageParser {
  /**
   * 解析自然语言文本为推送规则意图。
   *
   * @param text 用户输入的自然语言文本
   * @returns 解析结果
   */
  parse(text: string): ParsedRuleIntent {
    const trimmed = text.trim()
    if (!trimmed) {
      return this.defaultResult(trimmed, 0, '未检测到有效内容')
    }

    // 1. 解析频率
    const { frequency, dayOfWeek } = this.parseFrequency(trimmed)

    // 2. 解析时间
    const { hour, minute } = this.parseTime(trimmed)

    // 3. 解析地点
    const location = this.parseLocation(trimmed)

    // 4. 解析关键词（排除已识别的部分）
    const keywords = this.parseKeywords(trimmed, location)

    // 5. 解析信息源
    const sources = this.parseSources(trimmed)

    // 6. 计算置信度 & 构建描述
    const confidence = this.calculateConfidence(frequency, hour, keywords)
    const description = this.buildDescription({
      frequency,
      hour,
      minute,
      dayOfWeek,
      location,
      keywords,
      sources,
      rawText: trimmed,
      confidence,
    })

    return {
      frequency,
      hour,
      minute,
      dayOfWeek,
      location,
      keywords,
      sources,
      rawText: trimmed,
      confidence,
      description,
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 内部解析方法
  // ════════════════════════════════════════════════════════════════

  /**
   * 解析频率部分
   */
  private parseFrequency(text: string): { frequency: PushFrequency; dayOfWeek?: number } {
    for (const entry of FREQUENCY_KEYWORDS) {
      const match = text.match(entry.pattern)
      if (match) {
        if (entry.frequency === 'weekly') {
          // 从匹配文本中提取星期几
          const matchedText = match[0]
          for (const [cn, num] of Object.entries(DAY_OF_WEEK_MAP)) {
            if (matchedText.includes(cn)) {
              return { frequency: 'weekly', dayOfWeek: num }
            }
          }
          // 如果没指定具体星期几，默认周日
          return { frequency: 'weekly', dayOfWeek: 0 }
        }
        return { frequency: entry.frequency }
      }
    }
    // 未检测到频率关键词，默认每天
    return { frequency: 'daily' }
  }

  /**
   * 解析时间部分
   * 支持格式：HH:MM、X点(Y分)、X点半、X点、时间段（上午/下午/晚上）
   */
  private parseTime(text: string): { hour?: number; minute: number } {
    let hour: number | undefined
    let minute = 0

    // 1. 尝试 HH:MM 格式
    const hhmmMatch = text.match(TIME_HHMM)
    if (hhmmMatch) {
      hour = parseInt(hhmmMatch[1], 10)
      minute = parseInt(hhmmMatch[2], 10)
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return { hour, minute }
      }
    }

    // 2. 尝试中文时间格式
    const chMatch = text.match(TIME_CHINESE)
    if (chMatch) {
      hour = parseInt(chMatch[1], 10)
      if (chMatch[2] === '半') {
        minute = 30
      } else if (chMatch[3]) {
        minute = parseInt(chMatch[3], 10)
      }
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return { hour, minute }
      }
    }

    // 3. 尝试只有小时
    const hourMatch = text.match(TIME_HOUR_ONLY)
    if (hourMatch) {
      hour = parseInt(hourMatch[1], 10)
      if (hour >= 0 && hour <= 23) {
        return { hour, minute: 0 }
      }
    }

    // 4. 尝试时间段关键词
    for (const [keyword, period] of Object.entries(PERIOD_KEYWORDS)) {
      if (text.includes(keyword)) {
        const periodConf = PERIOD_HOUR_MAP[period]
        return { hour: periodConf.default, minute: 0 }
      }
    }

    // 未检测到时间，返回默认上午8点
    return { hour: 8, minute: 0 }
  }

  /**
   * 解析地点信息
   */
  private parseLocation(text: string): string | undefined {
    // 优先匹配中国城市
    for (const city of CHINESE_CITIES) {
      if (text.includes(city)) {
        return city
      }
    }
    // 匹配国际城市
    for (const loc of INTNL_LOCATIONS) {
      if (text.includes(loc)) {
        return loc
      }
    }
    return undefined
  }

  /**
   * 解析关键词。
   * 从文本中移除已识别的部分（频率词、时间词、地点），剩余内容作为关键词。
   */
  private parseKeywords(text: string, location?: string): string[] {
    // 移除常见噪音词
    let remaining = text

    // 移除频率词
    for (const entry of FREQUENCY_KEYWORDS) {
      remaining = remaining.replace(entry.pattern, '')
    }

    // 移除时间词
    remaining = remaining.replace(TIME_HHMM, '')
    remaining = remaining.replace(TIME_CHINESE, '')
    remaining = remaining.replace(TIME_HOUR_ONLY, '')

    // 移除时间段词
    for (const keyword of Object.keys(PERIOD_KEYWORDS)) {
      remaining = remaining.replace(new RegExp(keyword, 'u'), '')
    }

    // 移除地点
    if (location) {
      remaining = remaining.replace(new RegExp(location, 'u'), '')
    }

    // 移除信息源词
    for (const srcKw of Object.keys(SOURCE_KEYWORDS)) {
      remaining = remaining.replace(new RegExp(srcKw, 'iu'), '')
    }

    // 移除推送/雷达等控制词
    remaining = remaining
      .replace(/设置|创建|添加|新增|修改|删除|查看|查询|推送|雷达|规则/gu, '')
      .replace(/[，。！？、；：""''（）【】《》\s,.\-:]/gu, ' ')
      .trim()

    // 拆分剩余文本为关键词，过滤掉太短或无意义的词
    const words = remaining
      .split(/[\s,，、]+/u)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && !/^\d+$/.test(w))

    return [...new Set(words)]
  }

  /**
   * 解析信息源
   */
  private parseSources(text: string): string[] {
    const sources: string[] = []
    for (const [keyword, source] of Object.entries(SOURCE_KEYWORDS)) {
      if (new RegExp(keyword, 'iu').test(text)) {
        sources.push(source)
      }
    }
    return sources
  }

  // ════════════════════════════════════════════════════════════════
  // 辅助方法
  // ════════════════════════════════════════════════════════════════

  /**
   * 计算解析置信度
   */
  private calculateConfidence(frequency: PushFrequency, hour: number | undefined, keywords: string[]): number {
    let score = 0.3 // 基础分

    // 频率越具体，置信度越高
    if (frequency !== 'daily') score += 0.15

    // 有时间信息加分
    if (hour !== undefined) score += 0.25

    // 有关键词加分
    if (keywords.length >= 1) score += 0.15
    if (keywords.length >= 2) score += 0.1

    return Math.min(1, score)
  }

  /**
   * 构建人类可读的描述文本（用于用户确认）
   */
  buildDescription(intent: Omit<ParsedRuleIntent, 'description'>): string {
    const parts: string[] = []

    // 频率描述
    const freqLabel: Record<PushFrequency, string> = {
      daily: '每天',
      weekday: '每个工作日（周一至周五）',
      weekend: '每周末',
      weekly: `每周${this.dayOfWeekLabel(intent.dayOfWeek)}`,
      custom: '自定义',
    }
    parts.push(freqLabel[intent.frequency] || '每天')

    // 时间描述
    if (intent.hour !== undefined) {
      const hourStr = intent.hour < 10 ? `0${intent.hour}` : `${intent.hour}`
      const minStr = intent.minute < 10 ? `0${intent.minute}` : `${intent.minute}`
      parts.push(`${hourStr}:${minStr}`)
    } else {
      parts.push('08:00')
    }

    const desc = parts.join(' ')

    // 地点
    let extras = ''
    if (intent.location) {
      extras += `📍${intent.location} `
    }
    if (intent.keywords.length > 0) {
      extras += `关键词: ${intent.keywords.join(', ')}`
    }
    if (intent.sources.length > 0) {
      extras += `${extras ? ' | ' : ''}来源: ${intent.sources.join(', ')}`
    }

    return extras ? `${desc}\n📋 ${extras}` : desc
  }

  /**
   * 星期几的中文标签
   */
  private dayOfWeekLabel(day?: number): string {
    if (day === undefined) return '日'
    const labels = ['日', '一', '二', '三', '四', '五', '六']
    return labels[day] ?? '日'
  }

  /**
   * 默认解析结果
   */
  private defaultResult(rawText: string, confidence: number, description: string): ParsedRuleIntent {
    return {
      frequency: 'daily',
      hour: 8,
      minute: 0,
      keywords: [],
      sources: [],
      rawText,
      confidence,
      description,
    }
  }
}

/** 全局单例 */
export const radarNaturalLanguageParser = new RadarNaturalLanguageParser()
