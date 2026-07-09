/**
 * LearningVocabularyManager — 学习知识点词表管理器
 *
 * 从 ASR AsrHotwordManager 中提取的核心算法：
 * 1. 滑动窗口频次分析 → 知识点掌握度
 * 2. 长期持久化（跨会话保留已学知识点）
 * 3. 分类标签管理（学习领域的自动归类）
 * 4. 遗忘曲线模拟（时间衰减）
 * 5. 隐私管理：查询/删除已学知识点
 *
 * 对应关系：
 * - AsrHotwordManager.HotwordEntry → LearningItem
 * - AsrHotwordManager.tokenize() → ConceptTokenizer（知识点分词）
 * - AsrHotwordManager.classifyDomain() → classifyCategory()（知识点分类）
 * - AsrHotwordManager.longTermVocab → 持久化存储
 * - AsrHotwordManager.MAX_HOTWORDS → MAX_FOCUS_ITEMS
 */

import { log } from '../logger/Logger'
import { WORKSPACE } from '../config'
import { join, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import type {
  LearningItem,
  LearningCategory,
  LearningProgress,
  ConceptDifficulty,
} from './types'
import { TYPESCRIPT_LEARNING_ITEMS } from './types'

// ── 配置常量 ──

/** 滑动窗口大小（最近 N 次交互） */
const WINDOW_SIZE = 32

/** 高掌握度阈值（>= 此值视为已掌握） */
const MASTERY_THRESHOLD = 0.8

/** 学习中阈值（>= 此值视为学习中） */
const LEARNING_THRESHOLD = 0.2

/** 长期知识表持久化路径 */
const VOCABULARY_FILE = join(WORKSPACE.cache, 'learning-vocabulary.json')

/** 最大关注项数量（避免关注过多降低学习效率） */
const MAX_FOCUS_ITEMS = 20

/** 长期知识点最大数量 */
const MAX_LONG_TERM_ITEMS = 200

/** 高掌握度持久化阈值：掌握度 >= 此值才持久化 */
const HIGH_MASTERY_PERSIST_THRESHOLD = 0.3

/** 掌握度衰减率（每天衰减比例，模拟遗忘曲线） */
const MASTERY_DECAY_RATE = 0.05

/** 正确回答的掌握度增量 */
const CORRECT_MASTERY_DELTA = 0.1

/** 错误回答的掌握度减量 */
const WRONG_MASTERY_DELTA = 0.08

/** 每次遇到的掌握度微增 */
const ENCOUNTER_MASTERY_DELTA = 0.02

// ── 知识点分类规则（对应 AsrHotwordManager 的 DOMAIN_RULES） ──

/**
 * 分类关键词映射表。
 * 匹配优先级由上到下（先匹配先归类）。
 */
const CATEGORY_RULES: Array<{
  category: LearningCategory
  patterns: RegExp[]
}> = [
  {
    category: '条件类型',
    patterns: [
      /^(conditional|extends\?|infer|distributive)/i,
      /^条件类型$/i,
      /^extends\?/i,
      /^infer\b/i,
    ],
  },
  {
    category: '映射类型',
    patterns: [
      /^(mapped|keyof|in\s+\w+|remap|property.modifier|filtering)/i,
      /^映射类型$/i,
      /^keyof/i,
      /^P\s+in\s+K/i,
    ],
  },
  {
    category: '模板字面量类型',
    patterns: [
      /^(template\s+literal|string\.manipulation|uppercase|lowercase|capitalize|uncapitalize)/i,
      /^模板字面量/i,
      /`\$\{/,
      /template\s+literal/i,
    ],
  },
  {
    category: '泛型',
    patterns: [
      /^(generic|type\s+parameter|constraint|parameter\s+default)/i,
      /^泛型$/i,
      /<T>/i,
      /^<.*>$/i,
    ],
  },
  {
    category: '工具类型',
    patterns: [
      /^(partial|required|readonly|pick|omit|record|exclude|extract|nonnullable|returntype|parameters|awaited|thisparameter|omitthis|instanceType)/i,
      /^utility/i,
      /\bPartial\b/,
      /\bRequired\b/,
      /\bPick\b/,
      /\bOmit\b/,
      /\bRecord\b/,
    ],
  },
  {
    category: '类型守卫',
    patterns: [
      /^(type\s+guard|assertion|type\s+predicate|guards?)/i,
      /^类型守卫$/i,
      /\bis\s+\w+/i,
      /asserts/i,
    ],
  },
  {
    category: '类型推断',
    patterns: [
      /^(contextual\s+typing|best\s+common|narrowing|widening|inferr?ence)/i,
      /^类型推断$/i,
      /type\s+narrow/i,
      /type\s+widen/i,
    ],
  },
  {
    category: '基础类型',
    patterns: [
      /^(union|intersection|alias|literal|nullable)/i,
      /^基础类型$/i,
      /^type\s+alias/i,
      /\bunion\b/i,
      /\bintersection\b/i,
    ],
  },
]

// ── LearningVocabularyManager ──

export class LearningVocabularyManager {
  /** 是否启用 */
  private enabled = true

  /** 滑动窗口内的交互记录 */
  private recentInteractions: string[] = []

  /** 总交互次数 */
  private totalInteractions = 0

  /** 当前学习项（按 lastSeenAt 排序） */
  private items: LearningItem[] = []

  /** 长期积累知识表（跨会话持久化） */
  private longTermItems: Map<string, LearningItem> = new Map()

  /** 持久化文件路径 */
  private vocabFilePath: string

  constructor(vocabFilePath?: string) {
    this.vocabFilePath = vocabFilePath || VOCABULARY_FILE
  }

  // ── 初始化 ──

  /**
   * 初始化学习词表：从预定义清单加载知识点 + 从持久化存储恢复已学知识。
   * 在应用启动 / 学习计划创建时调用。
   */
  initialize(): void {
    // 加载预定义的 TS 高级类型知识点
    for (const item of TYPESCRIPT_LEARNING_ITEMS) {
      const id = this.normalizeConceptId(item.name)
      if (!this.longTermItems.has(id)) {
        this.longTermItems.set(id, {
          id,
          name: item.name,
          category: item.category,
          difficulty: item.difficulty,
          mastery: 0,
          encounterCount: 0,
          correctCount: 0,
          totalAttempts: 0,
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          tags: item.tags,
        })
      }
    }

    // 从持久化恢复（覆盖预定义项中已有的掌握度）
    this.loadPersistedVocabulary()

    log('INFO', 'learning_vocab_initialized', {
      predefined: TYPESCRIPT_LEARNING_ITEMS.length,
      long_term: this.longTermItems.size,
    })
  }

  /**
   * 从持久化存储加载长期知识表。
   */
  loadPersistedVocabulary(): void {
    try {
      if (!existsSync(this.vocabFilePath)) return
      const raw = readFileSync(this.vocabFilePath, 'utf-8')
      const data: Array<Record<string, unknown>> = JSON.parse(raw)
      if (!Array.isArray(data)) return

      let loaded = 0
      for (const rawItem of data) {
        if (!rawItem.id || typeof rawItem.id !== 'string') continue
        const existing = this.longTermItems.get(rawItem.id)
        if (existing) {
          // 合并持久化数据到预定义项
          existing.encounterCount = (rawItem.encounterCount as number) || existing.encounterCount
          existing.correctCount = (rawItem.correctCount as number) || existing.correctCount
          existing.totalAttempts = (rawItem.totalAttempts as number) || existing.totalAttempts
          existing.mastery = (rawItem.mastery as number) || existing.mastery
          existing.lastSeenAt = (rawItem.lastSeenAt as number) || existing.lastSeenAt
        } else {
          // 恢复预定义清单中未覆盖的自定义项
          this.longTermItems.set(rawItem.id as string, {
            id: rawItem.id as string,
            name: (rawItem.name as string) || (rawItem.id as string),
            category: (rawItem.category as LearningCategory) || '其他',
            difficulty: (rawItem.difficulty as ConceptDifficulty) || 'medium',
            mastery: (rawItem.mastery as number) || 0,
            encounterCount: (rawItem.encounterCount as number) || 0,
            correctCount: (rawItem.correctCount as number) || 0,
            totalAttempts: (rawItem.totalAttempts as number) || 0,
            firstSeenAt: (rawItem.firstSeenAt as number) || Date.now(),
            lastSeenAt: (rawItem.lastSeenAt as number) || Date.now(),
            tags: (rawItem.tags as string[]) || [],
          })
        }
        loaded++
      }

      log('INFO', 'learning_vocab_loaded', {
        count: loaded,
        total: this.longTermItems.size,
      })
    } catch (err) {
      log('WARN', 'learning_vocab_load_failed', { error: String(err) })
    }
  }

  /**
   * 将长期知识表持久化到磁盘。
   */
  savePersistedVocabulary(): void {
    try {
      const data = Array.from(this.longTermItems.values())
        .sort((a, b) => b.mastery - a.mastery)
        .slice(0, MAX_LONG_TERM_ITEMS)
        .map((item) => ({
          id: item.id,
          name: item.name,
          category: item.category,
          difficulty: item.difficulty,
          mastery: Math.round(item.mastery * 100) / 100,
          encounterCount: item.encounterCount,
          correctCount: item.correctCount,
          totalAttempts: item.totalAttempts,
          firstSeenAt: item.firstSeenAt,
          lastSeenAt: item.lastSeenAt,
          tags: item.tags,
        }))

      const dir = dirname(this.vocabFilePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.vocabFilePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      log('WARN', 'learning_vocab_save_failed', { error: String(err) })
    }
  }

  // ── 交互记录 ──

  /**
   * 记录一次知识点交互（学习/练习/遇到）。
   * 对应 AsrHotwordManager.feedUserText()。
   *
   * @param conceptName 知识点名称
   * @param correct 是否回答正确（可选，仅练习时传）
   */
  recordInteraction(conceptName: string, correct?: boolean): void {
    if (!this.enabled || !conceptName) return

    const normalized = this.normalizeConceptId(conceptName)

    // 滑动窗口记录
    this.recentInteractions.push(normalized)
    this.totalInteractions++
    while (this.recentInteractions.length > WINDOW_SIZE) {
      this.recentInteractions.shift()
    }

    // 更新或创建知识点
    let item = this.longTermItems.get(normalized)
    if (!item) {
      // 自动发现新知识点
      const category = this.classifyCategory(conceptName)
      item = {
        id: normalized,
        name: conceptName,
        category,
        difficulty: 'medium',
        mastery: 0,
        encounterCount: 0,
        correctCount: 0,
        totalAttempts: 0,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        tags: [category],
      }
      this.longTermItems.set(normalized, item)
    }

    // 更新频次
    item.encounterCount++
    item.lastSeenAt = Date.now()

    // 掌握度微增（每次遇到）
    item.mastery = Math.min(1, item.mastery + ENCOUNTER_MASTERY_DELTA)

    // 练习反馈
    if (correct !== undefined) {
      item.totalAttempts++
      if (correct) {
        item.correctCount++
        item.mastery = Math.min(1, item.mastery + CORRECT_MASTERY_DELTA)
      } else {
        item.mastery = Math.max(0, item.mastery - WRONG_MASTERY_DELTA)
      }
      item.lastAttemptCorrect = correct
    }

    // 重建滑动窗口统计
    this.rebuildWindowStats()

    // 高掌握度持久化
    if (item.mastery >= HIGH_MASTERY_PERSIST_THRESHOLD) {
      this.savePersistedVocabulary()
    }

    log('INFO', 'learning_vocab_interaction', {
      concept: conceptName,
      correct,
      mastery: Math.round(item.mastery * 100) / 100,
      encounterCount: item.encounterCount,
      totalInteractions: this.totalInteractions,
    })
  }

  /**
   * 批处理：从已有的交互文本序列重建统计数据。
   */
  loadFromInteractions(interactions: string[]): void {
    this.recentInteractions = interactions.slice(-WINDOW_SIZE)
    this.totalInteractions = interactions.length
    this.rebuildWindowStats()
  }

  // ── 查询接口 ──

  /**
   * 获取所有学习项列表（含掌握度信息）。
   */
  getAllItems(): LearningItem[] {
    return Array.from(this.longTermItems.values())
      .sort((a, b) => b.mastery - a.mastery)
  }

  /**
   * 获取某个知识点的掌握详情。
   */
  getItem(conceptName: string): LearningItem | undefined {
    return this.longTermItems.get(this.normalizeConceptId(conceptName))
  }

  /**
   * 获取当前高频关注的 TOP-N 知识点。
   * 对应 AsrHotwordManager.getHotwords()。
   * 策略：窗口频次高 + 掌握度低的知识点为最高关注。
   */
  getFocusItems(limit = MAX_FOCUS_ITEMS): LearningItem[] {
    // 1. 窗口内频次排序
    const freqMap = this.buildFreqMap()

    // 2. 按 (窗口频次 * (1 - mastery)) 降序排列
    const scored = Array.from(this.longTermItems.values())
      .map((item) => {
        const windowFreq = freqMap.get(item.id) || 0
        const focusScore = windowFreq * (1 - item.mastery) + (1 / (1 + item.mastery))
        return { item, focusScore }
      })
      .sort((a, b) => b.focusScore - a.focusScore)

    return scored.slice(0, limit).map((s) => s.item)
  }

  /**
   * 获取尚待掌握的知识点（mastery < MASTERY_THRESHOLD）。
   * 用于生成学习计划的待办步骤。
   */
  getUnmasteredItems(): LearningItem[] {
    return Array.from(this.longTermItems.values())
      .filter((item) => item.mastery < MASTERY_THRESHOLD)
      .sort((a, b) => a.mastery - b.mastery) // 掌握度最低的优先
  }

  /**
   * 获取已掌握的知识点列表。
   */
  getMasteredItems(): LearningItem[] {
    return Array.from(this.longTermItems.values())
      .filter((item) => item.mastery >= MASTERY_THRESHOLD)
      .sort((a, b) => b.mastery - a.mastery)
  }

  /**
   * 获取整体学习进度摘要。
   */
  getProgress(): LearningProgress {
    const allItems = Array.from(this.longTermItems.values())
    const totalItems = allItems.length
    const masteredCount = allItems.filter((i) => i.mastery >= MASTERY_THRESHOLD).length
    const learningCount = allItems.filter(
      (i) => i.mastery >= LEARNING_THRESHOLD && i.mastery < MASTERY_THRESHOLD,
    ).length
    const notStartedCount = allItems.filter((i) => i.mastery < LEARNING_THRESHOLD).length

    const overallMastery =
      totalItems > 0
        ? allItems.reduce((s, i) => s + i.mastery, 0) / totalItems
        : 0

    const totalAttempts = allItems.reduce((s, i) => s + i.totalAttempts, 0)
    const totalCorrect = allItems.reduce((s, i) => s + i.correctCount, 0)
    const overallAccuracy = totalAttempts > 0 ? totalCorrect / totalAttempts : 0

    // 各分类摘要
    const categoryMap = new Map<LearningCategory, { count: number; totalMastery: number }>()
    for (const item of allItems) {
      const existing = categoryMap.get(item.category) || { count: 0, totalMastery: 0 }
      existing.count++
      existing.totalMastery += item.mastery
      categoryMap.set(item.category, existing)
    }
    const categorySummary = Array.from(categoryMap.entries())
      .map(([category, data]) => ({
        category,
        count: data.count,
        avgMastery: Math.round((data.totalMastery / data.count) * 100) / 100,
      }))
      .sort((a, b) => b.avgMastery - a.avgMastery)

    return {
      totalItems,
      masteredCount,
      learningCount,
      notStartedCount,
      overallMastery: Math.round(overallMastery * 100) / 100,
      totalAttempts,
      totalCorrect,
      overallAccuracy: Math.round(overallAccuracy * 100) / 100,
      categorySummary,
    }
  }

  /**
   * 应用遗忘曲线衰减。
   * 每天调用一次，模拟艾宾浩斯遗忘曲线。
   */
  applyForgettingDecay(): void {
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    let decayedCount = 0

    for (const item of this.longTermItems.values()) {
      if (item.mastery <= 0) continue
      const daysSinceLastSeen = (now - item.lastSeenAt) / dayMs
      if (daysSinceLastSeen >= 1) {
        const decay = MASTERY_DECAY_RATE * daysSinceLastSeen * (1 - item.mastery)
        item.mastery = Math.max(0, item.mastery - decay)
        decayedCount++
      }
    }

    if (decayedCount > 0) {
      this.savePersistedVocabulary()
      log('INFO', 'learning_vocab_decay', { decayedCount })
    }
  }

  // ── 管理接口 ──

  /**
   * 删除指定知识点。
   */
  deleteItem(conceptName: string): boolean {
    const id = this.normalizeConceptId(conceptName)
    const existed = this.longTermItems.delete(id)
    if (existed) {
      this.savePersistedVocabulary()
      log('INFO', 'learning_vocab_item_deleted', { concept: conceptName })
    }
    return existed
  }

  /**
   * 清空所有已学知识。
   */
  clearAll(): void {
    this.longTermItems.clear()
    this.recentInteractions = []
    this.items = []
    this.savePersistedVocabulary()
    log('INFO', 'learning_vocab_all_cleared')
  }

  /**
   * 获取长期知识表大小。
   */
  getSize(): number {
    return this.longTermItems.size
  }

  /**
   * 启用/禁用。
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /**
   * 是否启用。
   */
  isEnabled(): boolean {
    return this.enabled
  }

  // ── 内部方法 ──

  /**
   * 知识点 ID 归一化（小写 + trim）。
   */
  private normalizeConceptId(name: string): string {
    return name.toLowerCase().replace(/[<>]/g, '_').trim()
  }

  /**
   * 对概念名称进行分类。
   * 对应 AsrHotwordManager.classifyDomain()。
   */
  private classifyCategory(name: string): LearningCategory {
    for (const { category, patterns } of CATEGORY_RULES) {
      for (const pattern of patterns) {
        pattern.lastIndex = 0
        if (pattern.test(name)) return category
      }
    }
    return '其他'
  }

  /**
   * 从滑动窗口重建频次映射。
   */
  private buildFreqMap(): Map<string, number> {
    const freqMap = new Map<string, number>()
    for (const interaction of this.recentInteractions) {
      freqMap.set(interaction, (freqMap.get(interaction) || 0) + 1)
    }
    return freqMap
  }

  /**
   * 重建窗口内统计（对应 AsrHotwordManager.rebuildEntries()）。
   */
  private rebuildWindowStats(): void {
    const freqMap = this.buildFreqMap()

    this.items = Array.from(freqMap.entries())
      .map(([id, count]) => {
        const existing = this.longTermItems.get(id)
        return {
          id,
          name: existing?.name || id,
          category: existing?.category || '其他',
          difficulty: existing?.difficulty || 'medium',
          mastery: existing?.mastery || 0,
          encounterCount: existing?.encounterCount || count,
          correctCount: existing?.correctCount || 0,
          totalAttempts: existing?.totalAttempts || 0,
          firstSeenAt: existing?.firstSeenAt || Date.now(),
          lastSeenAt: Date.now(),
          tags: existing?.tags || [],
        }
      })
      .sort((a, b) => b.encounterCount - a.encounterCount)
  }
}

/** 全局单例 */
export const learningVocabularyManager = new LearningVocabularyManager()
