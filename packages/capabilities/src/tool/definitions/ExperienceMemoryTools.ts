/**
 * ExperienceMemoryTools — 经验记忆工作流引擎 MCP 工具集
 *
 * 这些工具作为 AI 与 ExperienceMemoryService 之间的桥梁，
 * 让 LLM 可以查询、管理博客写作过程中的经验记忆。
 *
 * 工具列表：
 * - blog_memory_search — 语义搜索历史博客经验（相似度匹配）
 * - blog_memory_list — 列出指定博客的经验记录
 * - blog_memory_pin — 标记/取消标记重要经验
 * - blog_memory_delete — 删除单条经验
 * - blog_memory_clear — 清空指定博客的经验（保留固定项）
 * - blog_memory_stats — 查看经验记忆统计信息
 * - blog_memory_record — 手动记录一条经验
 */

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { experienceMemoryService } from '@akemi-mio/intelligence-memory/plan-memory-blog/ExperienceMemoryService'
import { getMemoryService } from '@akemi-mio/capabilities/tool/deps'
import type { BlogMemoryCategory } from '@akemi-mio/intelligence-memory/plan-memory-blog/types'

// =============================================================================
// blog_memory_search
// =============================================================================

export const blogMemorySearchTool = buildTool({
  name: 'blog_memory_search',
  description:
    '【体验记忆】语义搜索博客写作过程中的历史经验。输入自然语言描述，返回语义相似的历史经验（代码分析、设计决策、测试结果、发布效果等）。适用于新任务启动时参考过往经验',
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索查询（自然语言描述），如 "之前分析 React 性能优化的结论"',
      },
      limit: {
        type: 'number',
        description: '最大返回条数（默认 5，最大 20）',
      },
      category: {
        type: 'string',
        description:
          '按分类筛选：analysis（代码分析）、design_decision（设计决策）、test_result（测试结果）、refactoring（重构记录）、bug_fix（Bug修复）、performance（性能优化）、architecture（架构决定）',
      },
      blogId: {
        type: 'string',
        description: '按博客ID筛选（可选）',
      },
    },
    required: ['query'],
  },
  handler: async (args: { query: string; limit?: number; category?: string; blogId?: string }) => {
    try {
      const svc = experienceMemoryService
      if (!svc) return formatToolResult('⚠️ 经验记忆服务未初始化')

      const limit = Math.min(args.limit || 5, 20)
      let results = await svc.searchSimilar(args.query, limit * 3) // 获取更多用于过滤

      // 应用筛选
      if (args.category) {
        const cats = args.category.split(',').map((c) => c.trim()) as BlogMemoryCategory[]
        results = results.filter((r) => cats.includes(r.data.category))
      }
      if (args.blogId) {
        results = results.filter((r) => r.data.blogId === args.blogId)
      }

      results = results.slice(0, limit)

      if (results.length === 0) {
        return formatToolResult('未找到相似的历史经验。你可以继续写作，系统会自动记录新的经验。')
      }

      const lines: string[] = [`🔍 找到 ${results.length} 条相关经验（按相似度排序）：`, '']

      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        const categoryLabel = getCategoryLabel(r.data.category)
        const similarity = (r.score * 100).toFixed(0)
        const pinned = r.memoryEntry.isPinned ? ' 📌' : ''
        const time = formatTime(r.data.timestamp)

        lines.push(`  ${i + 1}. [${categoryLabel}]${pinned} 相关度 ${similarity}%`)
        lines.push(`     来源: ${r.data.blogId.slice(0, 24)} | ${time}`)
        lines.push(`     内容: ${r.memoryEntry.content.slice(0, 150)}`)
        if (r.data.stepDescription) {
          lines.push(`     步骤: ${r.data.stepDescription}`)
        }
        lines.push(`     记忆ID: ${r.memoryEntry.id}`)
        lines.push('')
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// blog_memory_list
// =============================================================================

export const blogMemoryListTool = buildTool({
  name: 'blog_memory_list',
  description: '【体验记忆】列出指定博客的所有经验记录。可按分类、时间范围筛选。如果不传 blogId，列出所有包含经验的博客',
  inputJSONSchema: {
    type: 'object',
    properties: {
      blogId: {
        type: 'string',
        description: '博客ID（可选）。不传则列出所有有经验的博客',
      },
      category: {
        type: 'string',
        description: '按分类筛选（可选），多个用逗号分隔',
      },
      pinnedOnly: {
        type: 'boolean',
        description: '仅显示已标记为重要的经验（默认 false）',
      },
      limit: {
        type: 'number',
        description: '最大返回条数（默认 10）',
      },
    },
    required: [],
  },
  handler: async (args: { blogId?: string; category?: string; pinnedOnly?: boolean; limit?: number }) => {
    try {
      const svc = experienceMemoryService
      if (!svc) return formatToolResult('⚠️ 经验记忆服务未初始化')

      if (!args.blogId) {
        // 列出所有有经验的博客
        const blogIds = svc.listBlogIds()
        if (blogIds.length === 0) {
          return formatToolResult('目前还没有任何经验记录。完成博客写作后会自动生成。')
        }
        const stats = svc.getStats()
        const lines: string[] = [
          `📚 经验记忆概览`,
          `总条数: ${stats.totalEntries}`,
          `已固定: ${stats.pinnedCount}`,
          `涉及博客: ${stats.blogCount}`,
          ``,
          `包含经验的博客:`,
          ...blogIds.map((id) => `  - ${id}`),
          '',
          '使用 blogId 参数查看具体博客的经验记录。',
        ]
        return formatToolResult(lines.join('\n'))
      }

      // 筛选分类
      const category = args.category ? (args.category.split(',').map((c) => c.trim()) as BlogMemoryCategory[]) : undefined

      const results = svc.listExperiences(args.blogId, {
        category,
        pinnedOnly: args.pinnedOnly,
        limit: args.limit || 10,
      })

      if (results.length === 0) {
        return formatToolResult(`博客「${args.blogId}」没有经验记录。`)
      }

      const lines: string[] = [`📝 博客「${args.blogId}」的经验记录 (${results.length} 条):`, '']

      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        const catLabel = getCategoryLabel(r.data.category)
        const pinned = r.memoryEntry.isPinned ? ' 📌' : ''
        const time = formatTime(r.data.timestamp)

        lines.push(`  ${i + 1}. [${catLabel}]${pinned}`)
        lines.push(`     时间: ${time}`)
        lines.push(`     内容: ${r.memoryEntry.content.slice(0, 200)}`)
        if (r.data.stepDescription) {
          lines.push(`     步骤: ${r.data.stepDescription}`)
        }
        lines.push(`     记忆ID: ${r.memoryEntry.id}`)
        lines.push('')
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// blog_memory_pin
// =============================================================================

export const blogMemoryPinTool = buildTool({
  name: 'blog_memory_pin',
  description: '【体验记忆】标记/取消标记一条经验为重要（固定）。被固定的经验不会被自动清理，在检索时优先展示',
  inputJSONSchema: {
    type: 'object',
    properties: {
      memoryId: {
        type: 'string',
        description: '经验记忆ID（来自 blog_memory_search 或 blog_memory_list 的结果）',
      },
      pin: {
        type: 'boolean',
        description: 'true=固定（标记重要），false=取消固定。不传则切换当前状态',
      },
    },
    required: ['memoryId'],
  },
  handler: async (args: { memoryId: string; pin?: boolean }) => {
    try {
      const svc = experienceMemoryService
      if (!svc) return formatToolError('经验记忆服务未初始化')

      if (args.pin !== undefined) {
        // 先获取当前状态
        const ms = getMemoryService()
        if (!ms) return formatToolError('记忆服务不可用')

        const entry = ms.getEntries().find((e) => e.id === args.memoryId && e.type === 'blog_memory')
        if (!entry) return formatToolError(`未找到经验记忆: ${args.memoryId}`)

        // 只在需要切换时才调用 toggle
        if (entry.isPinned !== args.pin) {
          svc.togglePin(args.memoryId)
        }
      } else {
        svc.togglePin(args.memoryId)
      }

      // 查询最新状态
      const ms = getMemoryService()
      const entry = ms?.getEntries().find((e) => e.id === args.memoryId)

      return formatToolResult(
        entry?.isPinned
          ? `✅ 已标记为重要（固定）。此经验将永久保留，不会受自动清理影响。\n内容: ${entry.content.slice(0, 100)}`
          : `已取消固定标记。此经验将按正常生命周期管理。`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// blog_memory_delete
// =============================================================================

export const blogMemoryDeleteTool = buildTool({
  name: 'blog_memory_delete',
  description: '【体验记忆】删除一条经验记录。删除后不可恢复。如果经验已被固定（标记重要），需要先取消固定才能删除',
  inputJSONSchema: {
    type: 'object',
    properties: {
      memoryId: {
        type: 'string',
        description: '要删除的经验记忆ID',
      },
      force: {
        type: 'boolean',
        description: '如果经验已被固定，设为 true 强制删除（默认 false）',
      },
    },
    required: ['memoryId'],
  },
  handler: async (args: { memoryId: string; force?: boolean }) => {
    try {
      const svc = experienceMemoryService
      if (!svc) return formatToolError('经验记忆服务未初始化')

      const ms = getMemoryService()
      if (!ms) return formatToolError('记忆服务不可用')

      const entry = ms.getEntries().find((e) => e.id === args.memoryId && e.type === 'blog_memory')
      if (!entry) return formatToolError(`未找到经验记忆: ${args.memoryId}`)

      // 检查是否已固定
      if (entry.isPinned && !args.force) {
        return formatToolResult(
          '⚠️ 该经验已被标记为重要（固定）。如果要删除，请：\n1. 先用 blog_memory_pin 取消固定\n2. 或者设置 force=true 强制删除',
        )
      }

      if (entry.isPinned && args.force) {
        svc.togglePin(args.memoryId) // 先取消固定
      }

      if (svc.deleteExperience(args.memoryId)) {
        return formatToolResult('✅ 经验已删除。')
      }
      return formatToolError('删除失败')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// blog_memory_clear
// =============================================================================

export const blogMemoryClearTool = buildTool({
  name: 'blog_memory_clear',
  description: '【体验记忆】清空指定博客的所有经验记录。保留被固定的经验（除非设置 includePinned=true）',
  inputJSONSchema: {
    type: 'object',
    properties: {
      blogId: {
        type: 'string',
        description: '要清空的博客ID',
      },
      includePinned: {
        type: 'boolean',
        description: '是否同时删除被固定的经验（默认 false）',
      },
    },
    required: ['blogId'],
  },
  handler: async (args: { blogId: string; includePinned?: boolean }) => {
    try {
      const svc = experienceMemoryService
      if (!svc) return formatToolError('经验记忆服务未初始化')

      const count = svc.clearBlogExperiences(args.blogId, args.includePinned)

      if (count === 0) {
        return formatToolResult(`博客「${args.blogId}」没有可清除的经验记录。`)
      }

      return formatToolResult(
        `✅ 已清除 ${count} 条经验记录。\n${args.includePinned ? '' : '被固定的经验已保留。如需删除固定经验，请设置 includePinned=true'}`,
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// blog_memory_stats
// =============================================================================

export const blogMemoryStatsTool = buildTool({
  name: 'blog_memory_stats',
  description: '【体验记忆】查看经验记忆系统的统计信息：总条目数、已固定数、涉及博客数、各分类分布',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const svc = experienceMemoryService
      if (!svc) return formatToolResult('⚠️ 经验记忆服务未初始化')

      const stats = svc.getStats()
      const categoryLabels: Record<string, string> = {
        analysis: '代码分析',
        design_decision: '设计决策',
        test_result: '测试结果',
        refactoring: '重构记录',
        bug_fix: 'Bug修复',
        performance: '性能优化',
        architecture: '架构决定',
        other: '其他',
      }

      const lines: string[] = [
        '📊 经验记忆统计',
        `━━━━━━━━━━━━━━━━━━`,
        `总条目数: ${stats.totalEntries}`,
        `已固定（重要）: ${stats.pinnedCount}`,
        `涉及博客数: ${stats.blogCount}`,
        '',
        '分类分布:',
      ]

      const categoryOrder = ['analysis', 'design_decision', 'refactoring', 'test_result', 'bug_fix', 'performance', 'architecture', 'other']
      for (const cat of categoryOrder) {
        const count = stats.categoryCounts[cat] || 0
        if (count > 0) {
          lines.push(`  ${categoryLabels[cat] || cat}: ${count} 条`)
        }
      }

      if (stats.totalEntries === 0) {
        lines.push('  暂无数据。完成博客写作后会自动生成经验记录。')
      }

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: true,
})

// =============================================================================
// blog_memory_record
// =============================================================================

export const blogMemoryRecordTool = buildTool({
  name: 'blog_memory_record',
  description: '【体验记忆】手动记录一条经验到记忆库。适用于 Agent 在写作过程中主动记录重要发现、决策、代码分析结论等',
  inputJSONSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: '经验内容（建议不超过500字），简明明了地描述这个经验',
      },
      category: {
        type: 'string',
        description:
          '分类：analysis（代码分析）、design_decision（设计决策）、test_result（测试结果）、refactoring（重构记录）、bug_fix（Bug修复）、performance（性能优化）、architecture（架构决定）、other（其他）',
        enum: ['analysis', 'design_decision', 'test_result', 'refactoring', 'bug_fix', 'performance', 'architecture', 'other'],
      },
      blogId: {
        type: 'string',
        description: '关联的博客ID（可选，不传则关联到当前活跃博客）',
      },
      stepDescription: {
        type: 'string',
        description: '步骤描述（可选），如 "性能优化分析"',
      },
    },
    required: ['content'],
  },
  handler: async (args: { content: string; category?: string; blogId?: string; stepDescription?: string }) => {
    try {
      const svc = experienceMemoryService
      if (!svc) return formatToolError('经验记忆服务未初始化')

      const cat = (args.category || 'other') as BlogMemoryCategory
      const result = svc.recordExperience(
        args.content,
        cat,
        args.blogId,
        args.stepDescription ? { stepDescription: args.stepDescription } : undefined,
      )

      if (result) {
        return formatToolResult(
          `✅ 经验已记录\n分类: ${getCategoryLabel(cat)}\n内容: ${args.content.slice(0, 100)}${args.content.length > 100 ? '…' : ''}`,
        )
      }
      return formatToolError('经验记录失败')
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

// =============================================================================
// 辅助函数
// =============================================================================

const CATEGORY_LABELS: Record<string, string> = {
  analysis: '代码分析',
  design_decision: '设计决策',
  test_result: '测试结果',
  refactoring: '重构记录',
  bug_fix: 'Bug修复',
  performance: '性能优化',
  architecture: '架构决定',
  other: '其他',
}

function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] || category
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(timestamp)
  }
}

