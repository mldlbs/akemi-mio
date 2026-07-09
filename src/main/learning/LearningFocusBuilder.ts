/**
 * LearningFocusBuilder — 学习关注焦点构建器
 *
 * 从 ASR AsrContextBuilder 中提取的核心策略：
 * 1. extractContext() → buildFocusContext() — 从上下文提取关注焦点
 * 2. buildContextualHotwords() → buildPriorityItems() — 构建优先级排序的学习项
 * 3. buildContextualPrompt() → buildFocusSummary() — 构建关注摘要文本
 * 4. isContextMeaningful() → isFocusMeaningful() — 判断关注上下文是否有效
 * 5. formatHotwordPrefix() → formatFocusPrefix() — 格式化关注项文本
 *
 * 对应关系：
 * - SummaryEntry.topics → focusCategories（关注的分类）
 * - SummaryEntry.keyEntities → recentConcepts（近期的知识点）
 * - ASR_HOTWORDS（静态配置）→ 预定义的必学知识点
 * - 优先级：实体 > 主题 > 静态
 */

import { log } from '../logger/Logger'
import type {
  LearningItem,
  LearningCategory,
  LearningFocusContext,
} from './types'
// ── 常量 ──

/** 最大关注项数量 */
const MAX_FOCUS_ITEMS = 15

/** 最大关注分类数 */
const MAX_FOCUS_CATEGORIES = 5

/** 上下文有效的最小关注项数 */
const MIN_MEANINGFUL_ITEMS = 2

/**
 * 预定义的 TypeScript 高级类型必学清单（对应 ASR_HOTWORDS）。
 * 这些是学习计划的核心知识点，始终保持在关注列表中。
 */
const CORE_LEARNING_ITEMS = [
  'Conditional Types',
  'Mapped Types',
  'Template Literal Types',
  'Infer Keyword',
  'Generics Constraints',
  'Utility Types',
  'Type Guards',
  'Discriminated Unions',
]

// ── 函数接口 ──

/**
 * 从学习项列表和上下文信息构建关注上下文。
 * 对应 AsrContextBuilder.extractContextFromSummaries()。
 *
 * @param items 当前所有学习项（含掌握度）
 * @param currentStepDescription 当前计划步骤描述（可选）
 * @returns 关注上下文
 */
export function buildFocusContext(
  items: LearningItem[],
  currentStepDescription?: string,
): LearningFocusContext {
  const focusCategories = new Set<LearningCategory>()
  const recentConcepts: string[] = []

  // 从掌握度最低的知识点提取关注类别（最需要关注的分类）
  const unmastered = items
    .filter((i) => i.mastery < 0.8)
    .sort((a, b) => a.mastery - b.mastery)

  for (const item of unmastered) {
    if (focusCategories.size < MAX_FOCUS_CATEGORIES) {
      focusCategories.add(item.category)
    }
    if (recentConcepts.length < MAX_FOCUS_ITEMS) {
      recentConcepts.push(item.name)
    }
  }

  // 如果当前步骤描述了下一步的学习内容，从中提取关注点
  let extractedStepCategory: LearningCategory | undefined
  if (currentStepDescription) {
    extractedStepCategory = extractCategoryFromText(currentStepDescription)
    if (extractedStepCategory) {
      focusCategories.add(extractedStepCategory)
    }
  }

  log('INFO', 'learning_focus_built', {
    categories: [...focusCategories],
    concepts: recentConcepts.slice(0, 5),
    hasStepContext: !!currentStepDescription,
  })

  return {
    focusCategories: [...focusCategories].slice(0, MAX_FOCUS_CATEGORIES),
    recentConcepts: recentConcepts.slice(0, MAX_FOCUS_ITEMS),
    recentInteractionText: currentStepDescription,
    currentStepDescription,
  }
}

/**
 * 构建优先级排序的学习项列表。
 * 对应 AsrContextBuilder.buildContextualHotwords()。
 *
 * 优先级：上下文未掌握项 > 核心必学项 > 其余项
 *
 * @param allItems 所有学习项
 * @param focusContext 当前关注上下文（可选）
 * @param maxItems 最大返回数
 */
export function buildPriorityItems(
  allItems: LearningItem[],
  focusContext?: LearningFocusContext,
  maxItems = MAX_FOCUS_ITEMS,
): LearningItem[] {
  const ordered: LearningItem[] = []
  const seen = new Set<string>()

  // 1. 上下文匹配的未掌握项（最高优先级）
  if (focusContext) {
    const contextItems = allItems.filter(
      (item) =>
        item.mastery < 0.8 &&
        (focusContext.focusCategories.includes(item.category) ||
          focusContext.recentConcepts.includes(item.name)),
    )
    for (const item of contextItems) {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        ordered.push(item)
      }
    }
  }

  // 2. 核心必学项
  for (const coreName of CORE_LEARNING_ITEMS) {
    const coreItem = allItems.find(
      (i) => i.name.toLowerCase() === coreName.toLowerCase(),
    )
    if (coreItem && !seen.has(coreItem.id)) {
      seen.add(coreItem.id)
      ordered.push(coreItem)
    }
  }

  // 3. 其余未掌握项（按掌握度升序）
  const remaining = allItems
    .filter((item) => !seen.has(item.id) && item.mastery < 0.8)
    .sort((a, b) => a.mastery - b.mastery)

  for (const item of remaining) {
    if (ordered.length >= maxItems) break
    ordered.push(item)
  }

  return ordered.slice(0, maxItems)
}

/**
 * 构建关注摘要文本（用于上下文提示/日志）。
 * 对应 AsrContextBuilder.buildContextualPrompt()。
 *
 * @param focusContext 关注上下文
 * @returns 可读的关注摘要字符串
 */
export function buildFocusSummary(focusContext: LearningFocusContext): string {
  const parts: string[] = ['【当前学习关注焦点】']

  if (focusContext.focusCategories.length > 0) {
    parts.push(
      `关注分类: ${focusContext.focusCategories.join('、')}`,
    )
  }

  if (focusContext.recentConcepts.length > 0) {
    const concepts = focusContext.recentConcepts.slice(0, 8).join(', ')
    parts.push(`近期知识点: ${concepts}`)
  }

  if (focusContext.currentStepDescription) {
    parts.push(`当前步骤: ${focusContext.currentStepDescription}`)
  }

  if (focusContext.recentInteractionText) {
    parts.push(
      `最近交互: ${focusContext.recentInteractionText.slice(0, 100)}`,
    )
  }

  return parts.join('\n')
}

/**
 * 判断关注上下文是否有效（有足够的关注点）。
 * 对应 AsrContextBuilder.isContextMeaningful()。
 */
export function isFocusMeaningful(context: LearningFocusContext): boolean {
  return (
    context.focusCategories.length > 0 || context.recentConcepts.length >= MIN_MEANINGFUL_ITEMS
  )
}

/**
 * 格式化关注项为可读文本（用于日志/UI）。
 * 对应 AsrContextBuilder.formatHotwordPrefix()。
 *
 * @param items 关注项列表
 * @param limit 显示上限
 */
export function formatFocusPrefix(items: LearningItem[], limit = 10): string {
  const display = items.slice(0, limit)
  if (display.length === 0) return ''
  const itemsStr = display
    .map((i) => `${i.name}(${Math.round(i.mastery * 100)}%)`)
    .join(', ')
  return `重点学习: ${itemsStr}。`
}

// ══════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════

/**
 * 从文本中提取关联的学习分类。
 * 基于关键词匹配，用于从步骤描述或交互文本中推断当前关注的分类。
 */
function extractCategoryFromText(text: string): LearningCategory | undefined {
  const lower = text.toLowerCase()

  if (/条件类型|conditional|extends\?|infer/i.test(lower)) return '条件类型'
  if (/映射类型|mapped|keyof/i.test(lower)) return '映射类型'
  if (/模板字面量|template\s+literal|字面量类型/i.test(lower)) return '模板字面量类型'
  if (/泛型|generic|type\s+parameter/i.test(lower)) return '泛型'
  if (/工具类型|utility|partial|pick|omit|record/i.test(lower)) return '工具类型'
  if (/类型守卫|type\s+guard|assertion/i.test(lower)) return '类型守卫'
  if (/推断|narrow|widen|inferr?ence/i.test(lower)) return '类型推断'
  if (/基础|union|intersection|alias/i.test(lower)) return '基础类型'
  if (/声明|declare|\.d\.ts/i.test(lower)) return '声明文件'
  if (/模块|module|import|export/i.test(lower)) return '模块'

  return undefined
}
