/**
 * BlogMemoryRetriever — 博客记忆检索与渲染器
 *
 * 职责：
 * 1. 从 MemoryService 中按 blogId 检索 blog_memory 类型的条目
 * 2. 按时间戳排序
 * 3. 通过模板引擎渲染为 Markdown 段落
 * 4. 支持分类筛选、时间范围过滤
 *
 * 使用方式：
 *   const retriever = new BlogMemoryRetriever(getMemoryService())
 *   const md = retriever.renderForBlog('my-blog-id')
 *   // 将 md 插入博客末尾
 */

import { log } from '../../logger/Logger'
import type { MemoryService } from '../../memory/MemoryService'
import type { MemoryEntry } from '../../memory/types'
import type {
  BlogMemoryStructuredData,
  BlogMemoryCategory,
  BlogMemoryQueryOptions,
  BlogMemoryRenderOptions,
} from './types'

/** 分类标签的中文映射 */
const CATEGORY_LABELS_ZH: Record<BlogMemoryCategory, string> = {
  analysis: '代码分析',
  design_decision: '设计决策',
  test_result: '测试结果',
  refactoring: '重构记录',
  bug_fix: 'Bug 修复',
  performance: '性能优化',
  architecture: '架构决定',
  other: '其他',
}

/** 分类标签的英文映射 */
const CATEGORY_LABELS_EN: Record<BlogMemoryCategory, string> = {
  analysis: 'Code Analysis',
  design_decision: 'Design Decision',
  test_result: 'Test Result',
  refactoring: 'Refactoring',
  bug_fix: 'Bug Fix',
  performance: 'Performance',
  architecture: 'Architecture',
  other: 'Other',
}

export class BlogMemoryRetriever {
  private memoryService: MemoryService | null = null

  constructor(memoryService?: MemoryService | null) {
    this.memoryService = memoryService ?? null
  }

  /** 设置 MemoryService 引用 */
  setMemoryService(ms: MemoryService | null): void {
    this.memoryService = ms
  }

  /**
   * 按 blogId 检索博客记忆条目。
   * 返回按 timestamp 升序排列的条目列表。
   */
  getForBlog(blogId: string, options?: BlogMemoryQueryOptions): ParsedBlogMemory[] {
    if (!this.memoryService) {
      log('WARN', 'blog_memory_retriever_no_memory')
      return []
    }

    const entries = this.memoryService.getEntries()
    const results: ParsedBlogMemory[] = []

    for (const entry of entries) {
      if (entry.type !== 'blog_memory') continue
      if (!entry.structuredData) continue

      try {
        const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData

        // 按 blogId 过滤
        if (data.blogId !== blogId) continue

        // 按分类过滤
        if (options?.category) {
          const categories = Array.isArray(options.category)
            ? options.category
            : [options.category]
          if (!categories.includes(data.category)) continue
        }

        // 按时间范围过滤
        if (options?.fromTimestamp && data.timestamp < options.fromTimestamp) continue
        if (options?.toTimestamp && data.timestamp > options.toTimestamp) continue

        results.push({
          memoryEntry: entry,
          data,
        })
      } catch {
        // 跳过无法解析的结构化数据
        continue
      }
    }

    // 按时间戳升序排列（由远及近）
    results.sort((a, b) => a.data.timestamp - b.data.timestamp)

    // 应用 limit
    if (options?.limit && options.limit > 0) {
      return results.slice(-options.limit)
    }

    return results
  }

  /**
   * 获取所有可用的 blogId 列表（有 blog_memory 记录的）。
   */
  listBlogIds(): string[] {
    if (!this.memoryService) return []

    const ids = new Set<string>()
    for (const entry of this.memoryService.getEntries()) {
      if (entry.type !== 'blog_memory' || !entry.structuredData) continue
      try {
        const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData
        ids.add(data.blogId)
      } catch {
        continue
      }
    }
    return Array.from(ids).sort()
  }

  /**
   * 统计指定 blogId 的各分类条目数。
   */
  getCategoryStats(blogId: string): Record<BlogMemoryCategory, number> {
    const stats: Record<string, number> = {
      analysis: 0,
      design_decision: 0,
      test_result: 0,
      refactoring: 0,
      bug_fix: 0,
      performance: 0,
      architecture: 0,
      other: 0,
    }

    const entries = this.getForBlog(blogId)
    for (const entry of entries) {
      stats[entry.data.category] = (stats[entry.data.category] || 0) + 1
    }

    return stats as Record<BlogMemoryCategory, number>
  }

  /**
   * 将博客记忆渲染为 Markdown 字符串。
   * 默认生成"开发背后"章节，适合插入博客末尾。
   */
  renderForBlog(blogId: string, options?: BlogMemoryRenderOptions): string {
    const entries = this.getForBlog(blogId, options)
    if (entries.length === 0) return ''

    const locale = options?.locale || 'zh'
    const showTimestamps = options?.showTimestamps ?? true
    const groupByCategory = options?.groupByCategory ?? true
    const title = options?.title || (locale === 'zh' ? '🕰️ 开发背后' : '🕰️ Behind the Development')

    const lines: string[] = []
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push(`## ${title}`)
    lines.push('')

    // 介绍文字
    if (options?.intro) {
      lines.push(options.intro)
      lines.push('')
    } else if (locale === 'zh') {
      lines.push('本文记录了在实现过程中产生的关键决策和发现。这些内容来自开发计划执行的自动记录。')
      lines.push('')
    } else {
      lines.push('This article documents key decisions and discoveries made during implementation, automatically recorded from development plan execution.')
      lines.push('')
    }

    if (groupByCategory) {
      this.renderGrouped(entries, lines, locale, showTimestamps, options?.maxContentLength)
    } else {
      this.renderChronological(entries, lines, locale, showTimestamps, options?.maxContentLength)
    }

    return lines.join('\n')
  }

  // ── 私有渲染方法 ──

  /** 按分类分组渲染 */
  private renderGrouped(
    entries: ParsedBlogMemory[],
    lines: string[],
    locale: 'zh' | 'en',
    showTimestamps: boolean,
    maxContentLength?: number,
  ): void {
    const labels = locale === 'zh' ? CATEGORY_LABELS_ZH : CATEGORY_LABELS_EN
    const grouped = new Map<BlogMemoryCategory, ParsedBlogMemory[]>()

    for (const entry of entries) {
      const cat = entry.data.category
      if (!grouped.has(cat)) grouped.set(cat, [])
      grouped.get(cat)!.push(entry)
    }

    // 按分类优先级排序
    const categoryOrder: BlogMemoryCategory[] = [
      'design_decision',
      'architecture',
      'analysis',
      'refactoring',
      'performance',
      'test_result',
      'bug_fix',
      'other',
    ]

    for (const cat of categoryOrder) {
      const group = grouped.get(cat)
      if (!group || group.length === 0) continue

      const label = labels[cat] || cat
      lines.push(`### ${label}`)
      lines.push('')

      for (const entry of group) {
        const prefix = showTimestamps
          ? `- **${formatTime(entry.data.timestamp, locale)}** — ${entry.memoryEntry.content}`
          : `- ${entry.memoryEntry.content}`
        lines.push(prefix)

        // 附加步骤描述作为上下文
        if (entry.data.stepDescription) {
          lines.push(`  - *${locale === 'zh' ? '步骤' : 'Step'}: ${entry.data.stepDescription}*`)
        }
      }
      lines.push('')
    }
  }

  /** 按时间顺序渲染 */
  private renderChronological(
    entries: ParsedBlogMemory[],
    lines: string[],
    locale: 'zh' | 'en',
    showTimestamps: boolean,
    maxContentLength?: number,
  ): void {
    const labels = locale === 'zh' ? CATEGORY_LABELS_ZH : CATEGORY_LABELS_EN

    if (showTimestamps) {
      lines.push(`| ${locale === 'zh' ? '时间' : 'Time'} | ${locale === 'zh' ? '分类' : 'Category'} | ${locale === 'zh' ? '内容摘要' : 'Summary'} |`)
      lines.push('|------|--------|----------|')
    }

    for (const entry of entries) {
      const timeStr = formatTime(entry.data.timestamp, locale, true)
      const categoryLabel = labels[entry.data.category] || entry.data.category
      const content = maxContentLength && maxContentLength > 0
        ? entry.memoryEntry.content.slice(0, maxContentLength) + (entry.memoryEntry.content.length > maxContentLength ? '…' : '')
        : entry.memoryEntry.content

      if (showTimestamps) {
        lines.push(`| ${timeStr} | ${categoryLabel} | ${content} |`)
      } else {
        lines.push(`- **${categoryLabel}**: ${content}`)
      }
    }
    lines.push('')
  }
}

// ── 辅助工具 ──

/** 解析后的博客记忆 */
export interface ParsedBlogMemory {
  memoryEntry: MemoryEntry
  data: BlogMemoryStructuredData
}

/**
 * 格式化时间戳为可读字符串
 */
function formatTime(timestamp: number, locale: 'zh' | 'en', short = false): string {
  try {
    const date = new Date(timestamp)
    if (short) {
      return date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }
    return date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')
  } catch {
    return String(timestamp)
  }
}

/** 单例导出 */
export let blogMemoryRetriever: BlogMemoryRetriever | null = null

export function initBlogMemoryRetriever(memoryService?: MemoryService | null): BlogMemoryRetriever {
  if (!blogMemoryRetriever) {
    blogMemoryRetriever = new BlogMemoryRetriever(memoryService)
  }
  return blogMemoryRetriever
}
