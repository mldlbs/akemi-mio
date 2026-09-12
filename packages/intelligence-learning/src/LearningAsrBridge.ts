/**
 * LearningAsrBridge — 学习系统 ↔ ASR 桥接器
 *
 * 职责：
 * 1. 将 TypeScript 学习知识点作为种子词表注入 ASR 热词管理器，
 *    使 ASR 在首次使用时就能准确识别 TypeScript 高级类型术语
 * 2. 将语音转写文本映射到最匹配的学习知识点
 * 3. 提供查询结果格式化，供 TTS 播报
 *
 * 集成方式：
 * - 在应用启动时（AppRuntime）调用 seedLearningVocab()
 * - 在 ASR 识别结果到达时调用 matchQuery() 获取匹配的知识点
 * - 通过 LearningQueryService 对外暴露查询能力
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { asrHotwordManager } from '@akemi-mio/audio/AsrHotwordManager'
import { learningVocabularyManager } from './LearningVocabularyManager'
import { TYPESCRIPT_LEARNING_ITEMS, ALL_LEARNING_CATEGORIES } from './types'
import type { LearningItem, LearningCategory, ConceptDifficulty } from './types'

// ── 预定义的 ASR 热词种子（从 TYPESCRIPT_LEARNING_ITEMS 提取） ──

/**
 * 从 TypeScript 学习知识点清单生成 ASR 热词种子列表。
 * 包括知识点名称和所有标签，确保 ASR 从首次使用就能准确识别。
 */
function buildAsrSeedWords(): Array<{ word: string; domain: '编程开发' }> {
  const seen = new Set<string>()
  const words: Array<{ word: string; domain: '编程开发' }> = []

  for (const item of TYPESCRIPT_LEARNING_ITEMS) {
    // 知识点名称作为热词
    if (!seen.has(item.name)) {
      seen.add(item.name)
      words.push({ word: item.name, domain: '编程开发' })
    }

    // 标签也作为热词（如 'extends', 'infer', 'keyof' 等）
    for (const tag of item.tags) {
      if (!seen.has(tag)) {
        seen.add(tag)
        words.push({ word: tag, domain: '编程开发' })
      }
    }
  }

  // 补充常见的中文 TypeScript 术语
  const cnTerms = [
    '泛型函数',
    '泛型约束',
    '泛型接口',
    '条件类型',
    '映射类型',
    '模板字面量',
    '类型守卫',
    '类型推断',
    '类型别名',
    '联合类型',
    '交叉类型',
    '工具类型',
    '类型参数',
    '类型收窄',
    '类型扩展',
  ]
  for (const term of cnTerms) {
    if (!seen.has(term)) {
      seen.add(term)
      words.push({ word: term, domain: '编程开发' })
    }
  }

  return words
}

// ── 查询匹配 ——

/** 查询匹配结果 */
export interface LearningMatchResult {
  /** 是否匹配到知识点 */
  matched: boolean
  /** 匹配到的知识点（按相关度排序） */
  items: LearningItem[]
  /** 匹配的知识点分类 */
  categories: LearningCategory[]
  /** 匹配的解释文本（用于 TTS 播报） */
  explanation: string
  /** 原始查询文本 */
  query: string
}

/**
 * 将语音查询文本与学习知识点进行关键词匹配。
 * 支持中文和英文模糊匹配。
 */
function matchLearningItems(query: string, items: LearningItem[]): { items: LearningItem[]; categories: LearningCategory[] } {
  const lowerQuery = query.toLowerCase()
  const matchedItems: LearningItem[] = []
  const matchedCats = new Set<LearningCategory>()

  for (const item of items) {
    const lowerName = item.name.toLowerCase()

    // 直接匹配名称
    if (lowerQuery.includes(lowerName) || lowerName.includes(lowerQuery)) {
      matchedItems.push(item)
      matchedCats.add(item.category)
      continue
    }

    // 匹配标签
    for (const tag of item.tags) {
      const lowerTag = tag.toLowerCase()
      if (lowerQuery.includes(lowerTag) || lowerTag.includes(lowerQuery)) {
        matchedItems.push(item)
        matchedCats.add(item.category)
        break
      }
    }
  }

  // 去重
  const seen = new Set<string>()
  const unique: LearningItem[] = []
  for (const item of matchedItems) {
    if (!seen.has(item.id)) {
      seen.add(item.id)
      unique.push(item)
    }
  }

  return { items: unique, categories: [...matchedCats] }
}

/**
 * 生成知识点解释文本（用于 TTS 播报）。
 */
function buildExplanation(query: string, matched: LearningItem[], categories: LearningCategory[]): string {
  if (matched.length === 0) {
    return `关于「${query}」，我没有找到匹配的 TypeScript 知识点。你可以尝试说：什么是条件类型、泛型函数怎么用、或者解释映射类型。`
  }

  const parts: string[] = []

  // 单个知识点：详细解释
  if (matched.length === 1) {
    const item = matched[0]
    parts.push(`找到了知识点「${item.name}」`)
    parts.push(`属于${item.category}`)
    parts.push(`当前掌握度 ${Math.round(item.mastery * 100)}%`)
    if (item.totalAttempts > 0) {
      const accuracy = Math.round((item.correctCount / item.totalAttempts) * 100)
      parts.push(`练习正确率 ${accuracy}%`)
    }
    parts.push(buildConceptTip(item))
  } else {
    // 多个知识点：列出匹配项
    parts.push(`找到了 ${matched.length} 个相关的 TypeScript 知识点：`)
    for (const item of matched.slice(0, 5)) {
      parts.push(`- ${item.name}（${item.category}，掌握度 ${Math.round(item.mastery * 100)}%）`)
    }
    if (matched.length > 5) {
      parts.push(`以及另外 ${matched.length - 5} 个相关知识点`)
    }
  }

  return parts.join('。')
}

/**
 * 为单个知识点生成学习提示（用于 TTS 播报）。
 */
function buildConceptTip(item: LearningItem): string {
  const tips: Record<string, string> = {
    'Conditional Types': '条件类型根据类型关系在两种类型中二选一，使用 extends 关键字判断。例如 T extends U ? A : B。',
    'Distributive Conditional Types': '当条件类型作用于联合类型时，会自动分发到联合的每个成员。',
    'Infer Keyword': 'infer 关键字在条件类型中声明待推断的类型变量，常用于提取函数返回值类型等模式匹配场景。',
    'Mapped Types': '映射类型基于已有类型的键创建新类型，使用 in keyof 语法遍历属性。例如 {[P in keyof T]: T[P]}。',
    'Generic Functions': '泛型函数允许类型作为参数传递，用尖括号声明类型参数。例如 function identity<T>(arg: T): T。',
    'Generic Constraints': '泛型约束用 extends 限制类型参数的范围，确保类型安全的同时保持灵活性。',
    'Template Literal Types': '模板字面量类型使用模板字符串语法在类型层面拼接字符串字面量。',
    'Type Guards': '类型守卫是运行时检查，帮助 TypeScript 在特定代码块中收窄类型。',
    'Utility Types': 'TypeScript 内置工具类型如 Partial、Pick、Omit 等，用于常见的类型转换。',
    'Partial<T>': 'Partial 将类型的所有属性变为可选，相当于 {[P in keyof T]?: T[P]}。',
    'Pick<T, K>': 'Pick 从类型 T 中选取一组属性 K 构造新类型。',
    'Omit<T, K>': 'Omit 从类型 T 中排除一组属性 K 构造新类型。',
    'Record<K, T>': 'Record 构造一个键类型为 K、值类型为 T 的对象类型。',
    'ReturnType<T>': 'ReturnType 提取函数类型的返回值类型，结合 infer 实现。',
    'Parameters<T>': 'Parameters 提取函数类型的参数元组类型。',
    'Awaited<T>': 'Awaited 递归展开 Promise 类型，得到最终的值类型。',
    'Exclude<T, U>': 'Exclude 从联合类型 T 中排除可以赋值给 U 的成员。',
    'Extract<T, U>': 'Extract 从联合类型 T 中提取可以赋值给 U 的成员。',
    'NonNullable<T>': 'NonNullable 从类型 T 中排除 null 和 undefined。',
    'Key Remapping': '键重映射使用 as 子句在映射类型中变换键名。',
    'Property Modifiers': '属性修饰符如 readonly 和可选标记可以在映射类型中添加或移除。',
    'Assertion Functions': '断言函数使用 asserts 关键字，告诉编译器函数执行后类型已收窄。',
    'Contextual Typing': '上下文类型是 TypeScript 根据表达式所处位置推断类型的能力。',
    'Type Widening': '类型拓宽是指 const 声明的字面量类型在 let 或赋值时自动扩展为更宽的类型。',
    'Type Narrowing': '类型收窄是通过类型守卫、typeof 检查等操作，将宽类型缩小为更具体的子类型。',
  }

  return tips[item.name] || `知识点「${item.name}」是 ${item.category} 中的重要概念，建议通过练习加深理解。`
}

// ── LearningAsrBridge ──

export class LearningAsrBridge {
  private seeded = false

  /**
   * 初始化：将 TypeScript 学习知识点注入 ASR 热词管理器。
   *
   * 应在应用启动时（AppRuntime）调用一次。
   * 种子词直接进入长时词表，跨会话保留。
   */
  seedLearningVocab(): void {
    if (this.seeded) {
      log('DEBUG', 'learning_asr_bridge_already_seeded')
      return
    }
    this.seeded = true

    const seedWords = buildAsrSeedWords()
    asrHotwordManager.seedVocabulary(seedWords)

    // 同时确保 LearningVocabularyManager 已初始化
    learningVocabularyManager.initialize()

    log('INFO', 'learning_asr_bridge_seeded', {
      seedCount: seedWords.length,
      vocabSize: learningVocabularyManager.getSize(),
    })
  }

  /**
   * 将语音转写文本匹配到学习知识点。
   *
   * @param transcribedText - ASR 转写的文本
   * @returns 匹配结果，包含匹配的知识点和可读解释
   */
  matchQuery(transcribedText: string): LearningMatchResult {
    const query = transcribedText.trim()
    if (!query) {
      return { matched: false, items: [], categories: [], explanation: '', query }
    }

    // 确保学习词表已初始化
    if (!this.seeded) {
      this.seedLearningVocab()
    }

    const allItems = learningVocabularyManager.getAllItems()
    const { items, categories } = matchLearningItems(query, allItems)
    const explanation = buildExplanation(query, items, categories)

    log('INFO', 'learning_asr_bridge_query', {
      query: query.slice(0, 60),
      matched: items.length,
      categories: categories.length,
    })

    return {
      matched: items.length > 0,
      items,
      categories,
      explanation,
      query,
    }
  }

  /**
   * 获取所有可学习知识的概述文本（用于 TTS 播报学习计划）。
   */
  getLearningSummary(): string {
    const progress = learningVocabularyManager.getProgress()
    const parts: string[] = [
      `TypeScript 高级类型学习计划：`,
      `共 ${progress.totalItems} 个知识点`,
      `已掌握 ${progress.masteredCount} 个`,
      `学习中 ${progress.learningCount} 个`,
      `总体掌握率 ${Math.round(progress.overallMastery * 100)}%`,
    ]

    if (progress.categorySummary.length > 0) {
      const activeCats = progress.categorySummary.filter((c) => c.avgMastery < 0.8).slice(0, 3)
      if (activeCats.length > 0) {
        parts.push(`当前重点关注：${activeCats.map((c) => c.category).join('、')}`)
      }
    }

    return parts.join('。')
  }

  /**
   * 判断文本是否包含 TypeScript 学习相关的查询意图。
   */
  isLearningQuery(text: string): boolean {
    const lower = text.toLowerCase()
    const learningKeywords = [
      'typescript',
      'ts',
      '类型',
      'type',
      '泛型',
      'generic',
      '条件',
      'conditional',
      '映射',
      'mapped',
      '工具类型',
      'utility',
      '类型守卫',
      'guard',
      '推断',
      'infer',
      '学习',
      'learn',
      '复习',
      'review',
      '知识点',
      '什么是',
      '什么是',
      '解释',
      'explain',
      'what is',
      '怎么用',
      'how to',
      '用法',
      '用法',
    ]
    return learningKeywords.some((kw) => lower.includes(kw))
  }
}

/** 全局单例 */
export const learningAsrBridge = new LearningAsrBridge()
