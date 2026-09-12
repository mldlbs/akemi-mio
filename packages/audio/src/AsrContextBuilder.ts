/**
 * AsrContextBuilder — 从 Memory 构建 ASR 上下文热词与提示词
 *
 * 功能：
 * 1. 从 SummaryMemory 的最近摘要中提取主题标签和关键实体
 * 2. 从 MemoryEntityExtractor 提取记忆中的命名实体（人名、项目名、地名）
 * 3. 构建动态热词列表（命名实体 > 关键实体 > 主题 > 静态配置）
 * 4. 构建 Whisper initial_prompt（注入当前对话上下文）
 *
 * 集成实体提取后，即使用户首次提及记忆中的名称（如"上次说的那个项目"），
 * ASR 也能借助热词准确识别，进而触发 Memory 检索。
 */

import type { SummaryEntry, MemoryEntry, InteractionRecord } from '@akemi-mio/intelligence-memory/types'
import type { AsrConversationContext } from './types'
import { ASR_HOTWORDS, ASR_INITIAL_PROMPT } from '@akemi-mio/core/config'
import { memoryEntityExtractor } from './MemoryEntityExtractor'

/**
 * 从 SummaryMemory 的最近摘要中提取对话上下文。
 * @param summaries 最近 N 轮对话摘要（SummaryEntry[]）
 * @param recentUserText 最近一条用户消息（可选）
 */
export function extractContextFromSummaries(summaries: SummaryEntry[], recentUserText?: string): AsrConversationContext {
  const topics: string[] = []
  const keyEntities: string[] = []

  // 从最近的摘要开始遍历，越近的优先级越高
  for (const summary of summaries) {
    for (const topic of summary.topics) {
      if (topic && !topics.includes(topic)) topics.push(topic)
    }
    for (const entity of summary.keyEntities) {
      if (entity && !keyEntities.includes(entity)) keyEntities.push(entity)
    }
  }

  return { topics, keyEntities, recentUserText }
}

/**
 * 构建动态热词列表：上下文实体 + 主题 + 静态配置，去重后返回。
 * 优先级：keyEntities > topics > 静态 ASR_HOTWORDS
 * @param context 对话上下文
 * @param maxHotwords 最大热词数（默认 30）
 */
export function buildContextualHotwords(context: AsrConversationContext, maxHotwords = 30): string[] {
  const dynamicHotwords: string[] = []

  // 1. 关键实体优先（专业术语、人名、项目名等）
  for (const entity of context.keyEntities) {
    if (entity && entity.length >= 2 && !dynamicHotwords.includes(entity)) {
      dynamicHotwords.push(entity)
    }
  }

  // 2. 主题标签
  for (const topic of context.topics) {
    if (topic && !dynamicHotwords.includes(topic)) {
      dynamicHotwords.push(topic)
    }
  }

  // 3. 合并静态配置热词，去重
  const staticHotwords = ASR_HOTWORDS.filter((hw) => !dynamicHotwords.includes(hw))
  const merged = [...dynamicHotwords, ...staticHotwords]

  return merged.slice(0, maxHotwords)
}

/**
 * 构建上下文感知的 Whisper initial_prompt。
 * 将当前对话主题和关键实体注入 prompt，引导模型关注相关领域词汇。
 * @param context 对话上下文
 */
export function buildContextualPrompt(context: AsrConversationContext): string {
  const basePrompt = ASR_INITIAL_PROMPT
  const parts: string[] = [basePrompt]

  if (context.topics.length > 0) {
    parts.push(`当前对话主题: ${context.topics.slice(0, 5).join('、')}。`)
  }

  if (context.keyEntities.length > 0) {
    parts.push(`关键实体: ${context.keyEntities.slice(0, 10).join(', ')}。`)
  }

  return parts.join(' ')
}

/**
 * 判断上下文是否有效（有足够的主题或实体信息）。
 * 如果 Memory 为空（新会话），返回 false，应回退到静态配置。
 */
export function isContextMeaningful(context: AsrConversationContext): boolean {
  return context.topics.length > 0 || context.keyEntities.length > 0
}

/**
 * 将上下文热词格式化为 Whisper prompt 中的 hotword 前缀。
 * 示例: "关键词: 编程, TypeScript, MCP, Agent, 部署, 测试。"
 */
export function formatHotwordPrefix(hotwords: string[], limit = 20): string {
  const display = hotwords.slice(0, limit)
  if (display.length === 0) return ''
  return `关键词: ${display.join(', ')}。`
}

// ══════════════════════════════════════════
//  记忆实体提取集成
// ══════════════════════════════════════════

/**
 * 将 Memory 中的记忆条目和交互记录馈入实体提取器。
 * 在 MemoryService 初始化或定期刷新时调用。
 *
 * 提取的命名实体（人名、项目名、地名）会被后续的
 * buildEntityDrivenHotwords() 用来生成 ASR 热词。
 *
 * @param entries 记忆条目列表
 * @param interactions 交互记录列表（可选）
 */
export function feedMemoryToEntityExtractor(entries: MemoryEntry[], interactions?: InteractionRecord[]): void {
  memoryEntityExtractor.feedEntries(entries, interactions)
}

/**
 * 构建实体驱动热词列表：从 MemoryEntityExtractor 中提取命名实体，
 * 与上下文热词合并后返回。
 *
 * 优先级：命名实体（人名/项目名/地名） > 上下文关键实体 > 主题 > 静态配置
 *
 * 这样即使用户说出"上次说到的那个项目"这样的模糊指代，
 * ASR 也能根据已注入的项目名热词准确识别实际的项目名称。
 *
 * @param context 对话上下文（可选，无上下文时只返回实体热词）
 * @param maxHotwords 最大热词数（默认 30）
 * @returns 合并后的热词列表
 */
export function buildEntityDrivenHotwords(context?: AsrConversationContext | null, maxHotwords = 30): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  // 1. 记忆实体提取器中的命名实体（最高优先级）
  const entityNames = memoryEntityExtractor.getEntityNames()
  for (const name of entityNames) {
    if (!seen.has(name) && name.length >= 2) {
      seen.add(name)
      result.push(name)
    }
  }

  // 2. 上下文关键实体
  if (context?.keyEntities) {
    for (const entity of context.keyEntities) {
      if (!seen.has(entity) && entity.length >= 2) {
        seen.add(entity)
        result.push(entity)
      }
    }
  }

  // 3. 上下文主题标签
  if (context?.topics) {
    for (const topic of context.topics) {
      if (!seen.has(topic) && topic.length >= 2) {
        seen.add(topic)
        result.push(topic)
      }
    }
  }

  // 4. 静态热词
  for (const hw of ASR_HOTWORDS) {
    if (!seen.has(hw)) {
      seen.add(hw)
      result.push(hw)
    }
  }

  return result.slice(0, maxHotwords)
}

/**
 * 获取实体提取器的统计信息（供调试/UI）。
 */
export function getEntityExtractorStats(): ReturnType<typeof memoryEntityExtractor.getStats> {
  return memoryEntityExtractor.getStats()
}

/**
 * 重置实体提取器的所有数据。
 */
export function resetEntityExtractor(): void {
  memoryEntityExtractor.clear()
}
