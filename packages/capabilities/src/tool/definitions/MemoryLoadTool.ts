/**
 * memory_load — 结构化加载记忆偏好摘要与行为模式
 *
 * 专为 Agent 自主调用设计的记忆加载工具，与通用 retrieve_memory 不同：
 * - 返回结构化、分类整理的用户偏好摘要（而非原始记忆条目）
 * - 返回行为模式分析和高频话题趋势
 * - 返回"Agent 学到的新经验"摘要（由 memory_save 存储的经验）
 * - 自动过滤低置信度条目，聚焦高价值信息
 *
 * 使用场景：
 * 1. Agent 启动时加载用户画像和行为偏好
 * 2. Agent 在长对话中定期"刷新"对用户的了解
 * 3. 用户表达模糊需求时，Agent 主动调用来辅助决策
 */

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface MemoryLoadResult {
  /** 用户偏好分类摘要 */
  preferences: Array<{
    key: string
    value: string
    category: string
    confidence: number
  }>
  /** Agent 学习到的经验总结 */
  learnings: Array<{
    content: string
    confidence: number
    learnedAt: number
  }>
  /** 高频话题趋势 */
  topicTrends: Array<{
    topic: string
    mentionCount: number
    lastMentioned: number
  }>
  /** 用户常用 API/工具偏好 */
  toolPreferences: Array<{
    toolName: string
    usageCount: number
    context: string
  }>
  /** 活跃的决策/任务上下文 */
  activeContext: Array<{
    title: string
    status: string
    updatedAt: number
  }>
  /** 原始记忆上下文块（兼容 getFormattedContext） */
  rawContext: string
}

// ══════════════════════════════════════════
//  工具定义
// ══════════════════════════════════════════

export const memoryLoadTool = buildTool({
  name: 'memory_load',
  description:
    '加载结构化的用户偏好摘要和行为模式。返回分类整理的用户画像、Agent学习到的经验总结、' +
    '话题趋势和工具使用偏好。用于Agent在对话启动或长对话中刷新对用户的了解，辅助决策。' +
    '比retrieve_memory更适合理解用户全局画像。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      include_raw_context: {
        type: 'boolean',
        description: '是否同时返回原始记忆上下文块（用于 system prompt 注入），默认 false',
      },
      pref_limit: {
        type: 'number',
        description: '偏好条目上限，默认 10，范围 1-30',
      },
      learning_limit: {
        type: 'number',
        description: '学习经验条目上限，默认 5，范围 1-20',
      },
    },
    required: [],
  },
  handler: async (args: { include_raw_context?: boolean; pref_limit?: number; learning_limit?: number }) => {
    try {
      const ms = getMemoryService()
      if (!ms) return formatToolError('记忆服务暂不可用')

      const prefLimit = Math.min(Math.max(args.pref_limit || 10, 1), 30)
      const learningLimit = Math.min(Math.max(args.learning_limit || 5, 1), 20)
      const includeRaw = args.include_raw_context === true

      const result: MemoryLoadResult = {
        preferences: [],
        learnings: [],
        topicTrends: [],
        toolPreferences: [],
        activeContext: [],
        rawContext: '',
      }

      // 1. 加载用户偏好（来自 user_profile 类型条目）
      const allPrefs = ms.getUserPreferences()
      result.preferences = allPrefs
        .filter((p) => p.confidence >= 0.4) // 过滤低置信度
        .slice(0, prefLimit)
        .map((p) => ({
          key: p.key,
          value: p.value,
          category: p.category,
          confidence: p.confidence,
        }))

      // 2. 加载 Agent 学习到的经验（来自有 learning 标记的记忆条目）
      const allEntries = ms.getEntries()
      const learnings = allEntries
        .filter((e) => {
          // 检测经验标记：内容包含【经验】、【学到】前缀，或 structuredData 中标记为 learning
          const isLearning =
            e.type === 'user_fact' &&
            (e.content.startsWith('【经验】') ||
              e.content.startsWith('【学到】') ||
              (e.structuredData &&
                (() => {
                  try {
                    const sd = JSON.parse(e.structuredData!)
                    return sd.source === 'agent_learning' || sd.tags?.includes('learning')
                  } catch {
                    return false
                  }
                })()))
          return isLearning
        })
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, learningLimit)
        .map((e) => {
          // 去掉前缀标记
          const cleanContent = e.content
            .replace(/^【经验】/, '')
            .replace(/^【学到】/, '')
            .trim()
          return {
            content: cleanContent,
            confidence: e.confidence,
            learnedAt: e.createdAt,
          }
        })
      result.learnings = learnings

      // 3. 高频话题趋势（从最近的 user_fact 提取并统计）
      const recentEntries = allEntries.filter((e) => e.type === 'user_fact' && e.topics && e.topics.length > 0).slice(-50)

      const topicCounts = new Map<string, { count: number; lastTime: number }>()
      for (const e of recentEntries) {
        for (const topic of e.topics || []) {
          const existing = topicCounts.get(topic) || { count: 0, lastTime: 0 }
          existing.count++
          existing.lastTime = Math.max(existing.lastTime, e.updatedAt)
          topicCounts.set(topic, existing)
        }
      }
      result.topicTrends = [...topicCounts.entries()]
        .map(([topic, data]) => ({
          topic,
          mentionCount: data.count,
          lastMentioned: data.lastTime,
        }))
        .sort((a, b) => b.mentionCount - a.mentionCount)
        .slice(0, 10)

      // 4. 工具使用偏好（从 structuredData 中检测 tool_preference 标记）
      const toolPrefs = allEntries
        .filter((e) => {
          if (e.type !== 'user_fact') return false
          if (!e.structuredData) return false
          try {
            const sd = JSON.parse(e.structuredData!)
            return sd.source === 'tool_preference' || sd.tags?.includes('tool_preference')
          } catch {
            return false
          }
        })
        .map((e) => {
          let toolName = ''
          let usageCount = 0
          try {
            const sd = JSON.parse(e.structuredData!)
            toolName = sd.toolName || 'unknown'
            usageCount = sd.usageCount || 1
          } catch {
            toolName = e.content.match(/\[([^\]]+)\]/)?.[1] || 'unknown'
          }
          return {
            toolName,
            usageCount,
            context: e.content.slice(0, 100),
          }
        })
        .sort((a, b) => b.usageCount - a.usageCount)
        .slice(0, 10)
      result.toolPreferences = toolPrefs

      // 5. 活跃任务上下文
      try {
        const unfinishedTasks = ms.getUnfinishedTasks()
        result.activeContext = unfinishedTasks.slice(0, 5).map((t) => ({
          title: t.title,
          status: t.status,
          updatedAt: t.updatedAt,
        }))
      } catch {
        // 非关键路径
      }

      // 6. 可选的原始上下文块
      if (includeRaw) {
        result.rawContext = ms.getFormattedContext()
      }

      // 格式化输出
      const formatted = formatLoadResult(result)
      return formatToolResult(formatted)
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

/**
 * 将结构化加载结果格式化为 Agent 友好文本。
 */
function formatLoadResult(result: MemoryLoadResult): string {
  const parts: string[] = ['📋 记忆负载报告']

  // 用户偏好
  if (result.preferences.length > 0) {
    parts.push('')
    parts.push('【用户偏好摘要】')
    const byCategory: Record<string, string[]> = {}
    for (const p of result.preferences) {
      const cat = p.category || 'other'
      if (!byCategory[cat]) byCategory[cat] = []
      byCategory[cat].push(`${p.key}: ${p.value}`)
    }
    for (const [cat, items] of Object.entries(byCategory)) {
      const catLabels: Record<string, string> = {
        style: '风格偏好',
        detail: '详略偏好',
        language: '语言偏好',
        preference: '个人偏好',
        identity: '身份信息',
        other: '其他',
      }
      parts.push(`  ${catLabels[cat] || cat}:`)
      for (const item of items) {
        parts.push(`    • ${item}`)
      }
    }
  }

  // 学习经验
  if (result.learnings.length > 0) {
    parts.push('')
    parts.push('【学到的经验】')
    for (const l of result.learnings) {
      const timeStr = new Date(l.learnedAt).toLocaleDateString('zh-CN')
      parts.push(`  • [${timeStr}] ${l.content.slice(0, 150)}`)
    }
  }

  // 话题趋势
  if (result.topicTrends.length > 0) {
    parts.push('')
    parts.push('【高频话题趋势】')
    for (const t of result.topicTrends) {
      parts.push(`  • ${t.topic}（${t.mentionCount} 次提及）`)
    }
  }

  // 工具偏好
  if (result.toolPreferences.length > 0) {
    parts.push('')
    parts.push('【常用工具偏好】')
    for (const tp of result.toolPreferences) {
      parts.push(`  • ${tp.toolName}（使用 ${tp.usageCount} 次）`)
    }
  }

  // 活跃上下文
  if (result.activeContext.length > 0) {
    parts.push('')
    parts.push('【活跃任务】')
    for (const ctx of result.activeContext) {
      const statusLabel = ctx.status === 'active' ? '进行中' : '已暂停'
      parts.push(`  • ${ctx.title}（${statusLabel}）`)
    }
  }

  // 原始上下文
  if (result.rawContext) {
    parts.push('')
    parts.push('【记忆上下文块】')
    parts.push(result.rawContext)
  }

  return parts.join('\n')
}

