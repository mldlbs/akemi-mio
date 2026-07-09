/**
 * TypographyMemoryManager — 排版规则自适应记忆系统
 *
 * 职责：
 * 1. 每次排版完成后，将使用的排版参数及用户最终确认的版本（附带章节号）保存到 Memory
 * 2. 处理新章节前，从 Memory 查询最近排版偏好记录，提取断句密度、引用样式、导语长度等参数
 * 3. 通过标签系统隔离不同排版任务（如公众号、小红书等）
 * 4. 内置遗忘机制防止记忆过拟合（限制每故事/平台最大记录数，权重按时间衰减）
 *
 * 与 PolishingMemoryManager 的关系：
 * - PolishingMemoryManager 管理文学风格/润色决策（修改了什么、为什么这样改）
 * - TypographyMemoryManager 管理视觉排版/格式偏好（段落密度、引用样式、强调方式等）
 * - 两者互补，前者管"写得好不好"，后者管"排得美不美"
 */
import { log } from '../logger/Logger'
import { getMemoryService } from '../tool/deps'
import type { MemoryEntry } from '../memory/types'

// ============================================================
//  类型定义
// ============================================================

/** 排版参数 — 公众号排版的可调参数集合 */
export interface TypographyParameters {
  /** 断句密度: 每段平均句子数 */
  sentenceDensity: 'dense' | 'normal' | 'sparse'
  /** 引用样式 */
  citationStyle: 'blockquote' | 'indent' | 'inline_quote' | 'none'
  /** 导语长度 */
  introLength: 'none' | 'short' | 'medium' | 'long'
  /** 段落间距 */
  paragraphSpacing: 'compact' | 'normal' | 'wide'
  /** 重点强调样式 */
  emphasisStyle: 'bold' | 'color_mark' | 'bg_mark' | 'none'
  /** 列表样式 */
  listStyle: 'bullet' | 'number' | 'icon'
  /** 章节分隔方式 */
  sectionDivider: 'line' | 'spacing' | 'emoji'
  /** 图片说明样式 */
  imageCaption: 'below_center' | 'below_left' | 'none'
  /** 扩展参数（灵活字段） */
  [key: string]: string | number | boolean
}

/** 单次排版记录 */
export interface TypographyRecord {
  /** 故事/文章 ID */
  storyId: string
  /** 章节标题 */
  chapterTitle: string
  /** 章节序号 */
  chapterNumber: number
  /** 平台标签（如 "公众号"、"知乎"） */
  platformTag: string
  /** 本次使用的排版参数 */
  parameters: TypographyParameters
  /** 用户本次的修正描述（如果有） */
  userCorrections?: string
  /** 用户最终确认的版本片段（前 200 字） */
  confirmedExcerpt?: string
  /** 记录来源 */
  source: 'auto' | 'user_correction' | 'evolution'
  /** 记录时间 */
  createdAt: number
}

/** 跨章节偏好趋势分析报告 */
export interface TypographyTrendReport {
  storyId: string
  platformTag: string
  chapterCount: number
  /** 各参数的变化趋势 */
  parameterTrends: Record<string, {
    current: string | number | boolean
    previous: string | number | boolean
    changeCount: number
    direction: 'stable' | 'increasing' | 'decreasing' | 'changed'
  }>
  /** 用户修正最多的参数（按频率排序） */
  topCorrectedParams: Array<{ param: string; count: number }>
  /** 建议的默认参数 */
  suggestedDefaults: TypographyParameters
  /** 分析时间 */
  analyzedAt: number
}

/** 排版上下文提示（供 LLM 注入） */
export interface TypographyContextHint {
  contextPrompt: string
  recordCount: number
  isEmpty: boolean
}

// ============================================================
//  常量
// ============================================================

/** 存储条目中的前缀标记 */
const MEMORY_KEY_PREFIX = '[typography_pref]'

/** 单个故事/平台最大记录数（遗忘机制上限） */
const MAX_RECORDS_PER_STORY_PLATFORM = 30

/** 上下文提示中最多引用几条历史记录 */
const CONTEXT_MAX_RECORDS = 5

/** 参数映射：中文标签 */
const PARAM_LABELS: Record<string, string> = {
  sentenceDensity: '断句密度',
  citationStyle: '引用样式',
  introLength: '导语长度',
  paragraphSpacing: '段落间距',
  emphasisStyle: '重点强调',
  listStyle: '列表样式',
  sectionDivider: '章节分隔',
  imageCaption: '图片说明',
}

const PARAM_VALUE_LABELS: Record<string, Record<string, string>> = {
  sentenceDensity: { dense: '密集', normal: '适中', sparse: '稀疏' },
  citationStyle: { blockquote: '引用块', indent: '缩进', inline_quote: '行内引用', none: '无引用' },
  introLength: { none: '无导语', short: '短导语', medium: '中等', long: '长导语' },
  paragraphSpacing: { compact: '紧凑', normal: '适中', wide: '宽松' },
  emphasisStyle: { bold: '加粗', color_mark: '彩色标注', bg_mark: '背景高亮', none: '无' },
  listStyle: { bullet: '圆点列表', number: '数字列表', icon: '图标列表' },
  sectionDivider: { line: '分割线', spacing: '留白', emoji: 'Emoji分隔' },
  imageCaption: { below_center: '居中说明', below_left: '左对齐说明', none: '无说明' },
}

// ============================================================
//  核心服务
// ============================================================

export class TypographyMemoryManager {
  // ─── 写入 ───

  /**
   * 保存一次排版记录到 Memory。
   *
   * 存储格式：[typography_pref]<JSON> — 保存为 user_fact 类型，
   * 遵循 PolishingMemoryManager 的 key-prefix 模式。
   * 内置遗忘机制：超出 MAX_RECORDS_PER_STORY_PLATFORM 时移除最旧记录。
   */
  saveRecord(record: TypographyRecord): void {
    const ms = getMemoryService()
    if (!ms) {
      log('WARN', 'typography_memory_no_service', { storyId: record.storyId })
      return
    }

    const serialized = JSON.stringify(record)
    const content = `${MEMORY_KEY_PREFIX}${serialized}`

    ms.addFact(content, 0.8, { tier: 'semi' })

    log('INFO', 'typography_memory_saved', {
      storyId: record.storyId,
      chapterNumber: record.chapterNumber,
      chapterTitle: record.chapterTitle,
      platformTag: record.platformTag,
      source: record.source,
    })

    // 遗忘机制：超出上限时清除最旧的记录
    this.pruneOldRecords(record.storyId, record.platformTag)
  }

  /**
   * 遗忘机制 — 确保每故事/平台的记录不超过上限。
   * 删除最旧的超出部分记录（保留最新的 N 条）。
   */
  private pruneOldRecords(storyId: string, platformTag: string): void {
    const ms = getMemoryService()
    if (!ms) return

    const records = this.queryRecords(storyId, platformTag)
    if (records.length <= MAX_RECORDS_PER_STORY_PLATFORM) return

    // 按时间升序排列（最旧在前）
    records.sort((a, b) => a.createdAt - b.createdAt)
    const toRemove = records.slice(0, records.length - MAX_RECORDS_PER_STORY_PLATFORM)

    const entries = ms.getEntries()
    let removedCount = 0
    for (const oldRecord of toRemove) {
      const serialized = JSON.stringify(oldRecord)
      const content = `${MEMORY_KEY_PREFIX}${serialized}`
      const entry = entries.find(
        (e) => e.type === 'user_fact' && e.content === content,
      )
      if (entry) {
        ms.forgetEntry(entry.id)
        removedCount++
      }
    }

    if (removedCount > 0) {
      ms.flush()
      log('INFO', 'typography_memory_pruned', {
        storyId,
        platformTag,
        removed: removedCount,
        remaining: MAX_RECORDS_PER_STORY_PLATFORM,
      })
    }
  }

  // ─── 读取 ───

  /**
   * 查询指定故事/平台的排版记录。
   * 返回按时间降序排列（最新在前）。
   */
  queryRecords(
    storyId: string,
    platformTag: string,
    options?: { limit?: number },
  ): TypographyRecord[] {
    const ms = getMemoryService()
    if (!ms) return []

    const allEntries = ms.getEntries()
    const results: TypographyRecord[] = []
    const limit = options?.limit ?? 50

    for (const entry of allEntries) {
      if (entry.type !== 'user_fact') continue
      if (!entry.content.startsWith(MEMORY_KEY_PREFIX)) continue

      const record = this.tryParseRecord(entry)
      if (!record) continue

      if (record.storyId.toLowerCase() !== storyId.toLowerCase()) continue
      if (record.platformTag !== platformTag) continue

      results.push(record)
    }

    // 按时间降序（最新在前）
    results.sort((a, b) => b.createdAt - a.createdAt)
    return results.slice(0, limit)
  }

  /**
   * 为指定故事/平台构建排版上下文提示，供 LLM 在排版前注入。
   *
   * 包含：
   * - 最近 N 条记录使用的参数汇总
   * - 与默认参数的差异
   * - 用户最近的修正记录
   * - 趋势摘要（如果有多章记录）
   */
  buildTypographyContext(
    storyId: string,
    platformTag: string,
    chapterNumber?: number,
  ): TypographyContextHint {
    const records = this.queryRecords(storyId, platformTag, {
      limit: CONTEXT_MAX_RECORDS,
    })

    if (records.length === 0) {
      return {
        contextPrompt: '',
        recordCount: 0,
        isEmpty: true,
      }
    }

    const lines: string[] = []
    lines.push(`---`)
    lines.push(`【排版偏好参考 — ${platformTag}】`)
    lines.push(`以下是从前 ${records.length} 章整理的排版偏好，供当前章节参考：`)
    lines.push('')

    // 1. 最近一次使用的参数
    const latest = records[0]
    lines.push(`最近使用参数（第 ${latest.chapterNumber} 章 ${latest.chapterTitle}）：`)
    for (const [key, value] of Object.entries(latest.parameters)) {
      if (key.startsWith('_')) continue // 跳过内部字段
      const label = PARAM_LABELS[key] || key
      const valueLabel = PARAM_VALUE_LABELS[key]?.[String(value)] || String(value)
      lines.push(`  - ${label}: ${valueLabel}`)
    }

    // 2. 用户最近的修正记录
    const recentCorrections = records
      .filter((r) => r.source === 'user_correction' && r.userCorrections)
      .slice(0, 2)
    if (recentCorrections.length > 0) {
      lines.push('')
      lines.push('用户最近修正：')
      for (const r of recentCorrections) {
        lines.push(`  - 第 ${r.chapterNumber} 章: ${r.userCorrections!.slice(0, 120)}`)
      }
    }

    // 3. 跨章节趋势摘要（如果有多条记录）
    if (records.length >= 3) {
      const trends = this.detectParameterTrends(records)
      const changedParams = Object.entries(trends)
        .filter(([, t]) => t.direction !== 'stable')
        .slice(0, 3)
      if (changedParams.length > 0) {
        lines.push('')
        lines.push('正在变化中的参数：')
        for (const [param, trend] of changedParams) {
          const label = PARAM_LABELS[param] || param
          const currentVal = PARAM_VALUE_LABELS[param]?.[String(trend.current)] || String(trend.current)
          lines.push(`  - ${label}: 趋近 ${currentVal}（${trend.changeCount} 次变化）`)
        }
      }
    }

    lines.push('')
    lines.push(
      '请参考以上排版偏好调整当前章节的排版设置，保持与历史章节一致的排版风格。',
    )
    lines.push(`---`)

    return {
      contextPrompt: lines.join('\n'),
      recordCount: records.length,
      isEmpty: false,
    }
  }

  // ─── 趋势分析 ───

  /**
   * 分析指定故事/平台跨章节的排版参数变化趋势。
   */
  analyzeTrends(
    storyId: string,
    platformTag: string,
  ): TypographyTrendReport | null {
    const records = this.queryRecords(storyId, platformTag, { limit: 50 })
    if (records.length < 2) return null

    // 按时间升序排列
    records.sort((a, b) => a.createdAt - b.createdAt)

    // 检测各参数变化
    const parameterTrends: TypographyTrendReport['parameterTrends'] = {}
    const correctionCounts: Record<string, number> = {}
    const suggestedDefaults: Record<string, string | number | boolean> = {}

    // 获取所有参数 key
    const allKeys = new Set<string>()
    for (const r of records) {
      for (const key of Object.keys(r.parameters)) {
        if (!key.startsWith('_')) allKeys.add(key)
      }
    }

    for (const key of allKeys) {
      const values = records.map((r) => r.parameters[key])
      const current = values[values.length - 1]
      const previous = values.length >= 2 ? values[values.length - 2] : current

      let changeCount = 0
      for (let i = 1; i < values.length; i++) {
        if (String(values[i]) !== String(values[i - 1])) changeCount++
      }

      // 建议默认值 = 最新值（如果变化频繁则取众数）
      const mode = this.mode(values.filter((v) => v !== undefined))
      const direction: TypographyTrendReport['parameterTrends'][string]['direction'] =
        changeCount === 0
          ? 'stable'
          : changeCount <= 2
            ? 'changed'
            : changeCount > values.length / 3
              ? 'increasing'
              : 'decreasing'

      suggestedDefaults[key] = mode !== undefined ? mode : current

      parameterTrends[key] = {
        current,
        previous,
        changeCount,
        direction,
      }
    }

    // 统计用户修正最多的参数
    for (const r of records) {
      if (r.source === 'user_correction' && r.userCorrections) {
        // 从修正文本中推测涉及哪些参数
        for (const key of allKeys) {
          const label = PARAM_LABELS[key] || key
          if (r.userCorrections.includes(label)) {
            correctionCounts[key] = (correctionCounts[key] || 0) + 1
          }
        }
      }
    }

    const topCorrected = Object.entries(correctionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([param, count]) => ({ param, count }))

    return {
      storyId,
      platformTag,
      chapterCount: records.length,
      parameterTrends,
      topCorrectedParams: topCorrected,
      suggestedDefaults: suggestedDefaults as TypographyParameters,
      analyzedAt: Date.now(),
    }
  }

  /**
   * 简单的趋势检测：比较前一半和后一半参数值的差异。
   */
  private detectParameterTrends(
    records: TypographyRecord[],
  ): Record<string, { current: string | number | boolean; changeCount: number; direction: string }> {
    const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt)
    const trends: Record<string, any> = {}

    const allKeys = new Set<string>()
    for (const r of sorted) {
      for (const key of Object.keys(r.parameters)) {
        if (!key.startsWith('_')) allKeys.add(key)
      }
    }

    for (const key of allKeys) {
      const values = sorted.map((r) => r.parameters[key])
      const current = values[values.length - 1]

      let changeCount = 0
      for (let i = 1; i < values.length; i++) {
        if (String(values[i]) !== String(values[i - 1])) changeCount++
      }

      trends[key] = {
        current: current !== undefined ? current : 'unknown',
        changeCount,
        direction: changeCount === 0 ? 'stable' : 'changed',
      }
    }

    return trends
  }

  /**
   * 计算数组的众数（出现最频繁的值）。
   */
  private mode(values: Array<string | number | boolean | undefined>): string | number | boolean | undefined {
    if (values.length === 0) return undefined
    const counts = new Map<string, number>()
    for (const v of values) {
      if (v !== undefined) {
        const key = String(v)
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
    let maxCount = 0
    let modeValue: string | undefined
    for (const [key, count] of counts) {
      if (count > maxCount) {
        maxCount = count
        modeValue = key
      }
    }
    if (modeValue === undefined) return undefined
    // 尝试恢复原始类型
    const original = values.find((v) => String(v) === modeValue)
    return original
  }

  // ─── 辅助 ───

  /**
   * 从 MemoryEntry 的 content 中解析 TypographyRecord。
   * 剥离前缀后解析 JSON。
   */
  private tryParseRecord(entry: MemoryEntry): TypographyRecord | null {
    if (entry.type !== 'user_fact') return null
    if (!entry.content.startsWith(MEMORY_KEY_PREFIX)) return null

    try {
      const json = entry.content.slice(MEMORY_KEY_PREFIX.length)
      const parsed = JSON.parse(json)

      // 验证必要字段
      if (!parsed.storyId || !parsed.chapterTitle || !parsed.platformTag || !parsed.parameters) {
        return null
      }

      return parsed as TypographyRecord
    } catch {
      return null
    }
  }

  /**
   * 获取所有排版记录（跨所有故事/平台）。
   */
  getAllRecords(limit: number = 100): TypographyRecord[] {
    const ms = getMemoryService()
    if (!ms) return []

    const entries = ms.getEntries()
    const results: TypographyRecord[] = []

    for (const entry of entries) {
      if (entry.type !== 'user_fact') continue
      if (!entry.content.startsWith(MEMORY_KEY_PREFIX)) continue

      const record = this.tryParseRecord(entry)
      if (record) {
        results.push(record)
      }
      if (results.length >= limit) break
    }

    results.sort((a, b) => b.createdAt - a.createdAt)
    return results
  }
}
