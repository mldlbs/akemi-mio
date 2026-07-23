/**
 * BlogMemoryAssistant — 记忆驱动的博客助手
 *
 * 职责：
 * 1. 在新博客开始前，检索相似历史发布记录，通过 LLM 生成个性化建议
 *    （标题优化、最佳发布时间、内容改进点）
 * 2. 在博客发布后，将元数据（标题、摘要、平台、阅读量等）记录到 MemoryService
 * 3. 将历史洞察格式化为 Prompt 注入段，供工作流步骤消费
 * 4. 提供清除选项，尊重用户隐私
 *
 * 与现有服务的关系：
 * - BlogMemoryRecorder: 记录 Plan 执行过程中的经验（开发侧）
 * - BlogAnalyticsTracker: 追踪发布后的效果数据（分析侧）
 * - ExperienceMemoryService: 语义搜索历史博客记忆（检索侧）
 * - BlogMemoryAssistant: 统一上述能力的助理层（助手侧）
 *
 * 使用方式：
 *   const assistant = new BlogMemoryAssistant()
 *   // 开始新博客前获取建议
 *   const ctx = await assistant.onNewBlog('React 性能优化', '掘金')
 *   // 注入到 Prompt
 *   const promptSection = assistant.formatSuggestionPrompt(ctx.suggestions)
 *   // 发布后记录
 *   assistant.onBlogPublished({
 *     title: 'React 性能优化实战',
 *     summary: '...',
 *     platform: '掘金',
 *     topic: 'React 性能优化',
 *   })
 *   // 用户要求清除历史
 *   assistant.clearAllHistory()
 */

import { log } from '../../logger/Logger'
import { getMemoryService } from '../../tool/deps'
import { fallbackEmbed, cosineSimilarity } from '../embedding'
import { experienceMemoryService } from './ExperienceMemoryService'
import type {
  BlogPublicationMetadata,
  BlogMemorySuggestion,
  BlogMemoryAssistantConfig,
  BlogMemoryAssistantStats,
  BlogMemoryCategory,
  BlogMemoryStructuredData,
  BlogPublicationRecord,
} from './types'
import {
  BLOG_MEMORY_ENABLED,
  BLOG_MEMORY_DEFAULT_CONFIDENCE,
  BLOG_MEMORY_DEFAULT_TIER,
} from '../../config'

// =============================================================================
// 默认配置
// =============================================================================

const DEFAULT_CONFIG: BlogMemoryAssistantConfig = {
  enabled: BLOG_MEMORY_ENABLED,
  maxRetrievalCount: 5,
  similarityThreshold: 0.35,
  autoInjectPrompt: true,
  enableLlmGeneration: true,
  defaultTier: BLOG_MEMORY_DEFAULT_TIER,
  defaultConfidence: BLOG_MEMORY_DEFAULT_CONFIDENCE,
  maxPublicationRecords: 200,
}

// =============================================================================
// 发布参数
// =============================================================================

export interface PublishParams {
  /** 文章标题 */
  title: string
  /** 文章摘要（120 字以内） */
  summary: string
  /** 发布平台 */
  platform: string
  /** 博客主题/分类 */
  topic: string
  /** 正文字数（可选） */
  wordCount?: number
  /** SEO 标签（可选） */
  tags?: string[]
  /** 是否包含代码（可选） */
  hasCode?: boolean
  /** 关联的开发过程 blogId（可选，留空自动生成） */
  blogId?: string
  /** 效果数据（可选） */
  performance?: {
    views?: number
    likes?: number
    comments?: number
    shares?: number
  }
  /** 备注（可选） */
  notes?: string
}

/** 新博客开始时的上下文 */
export interface NewBlogContext {
  /** 当前主题 */
  topic: string
  /** 目标平台 */
  platform: string
  /** 生成的建议 */
  suggestions: BlogMemorySuggestion
  /** 引用到的历史记忆 */
  references: Array<{
    content: string
    category: string
    similarity: number
    title?: string
  }>
  /** 数据是否充足 */
  hasSufficientData: boolean
}

// =============================================================================
// LLM 建议生成回调类型
// =============================================================================

/**
 * LLM 建议生成函数签名。
 * 外部注入时需返回符合 BlogMemorySuggestion 结构的 JSON。
 * 实现方通常使用 LlmService.chatJson() 或 chatJsonWithCode()。
 */
export type SuggestionGenerator = (
  topic: string,
  platform: string,
  references: Array<{ content: string; category: string; title?: string }>,
) => Promise<Partial<BlogMemorySuggestion>>

// =============================================================================
// BlogMemoryAssistant
// =============================================================================

export class BlogMemoryAssistant {
  private config: BlogMemoryAssistantConfig
  /** 外部 LLM 生成器（可选） */
  private llmGenerator: SuggestionGenerator | null = null

  constructor(
    config?: Partial<BlogMemoryAssistantConfig>,
    llmGenerator?: SuggestionGenerator | null,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    if (llmGenerator !== undefined) {
      this.llmGenerator = llmGenerator
    }
  }

  /** 注入或替换 LLM 生成器 */
  setLlmGenerator(generator: SuggestionGenerator | null): void {
    this.llmGenerator = generator
  }

  // ===========================================================================
  // 核心 API：新博客开始
  // ===========================================================================

  /**
   * 在新博客开始前调用：检索相似历史发布 + 生成个性化建议。
   *
   * @param topic 博客主题
   * @param platform 目标平台（如 '掘金', 'CSDN'）
   * @returns 包含建议和引用的上下文对象
   */
  async onNewBlog(topic: string, platform?: string): Promise<NewBlogContext> {
    const t0 = Date.now()

    // 1. 检索相似历史发布记忆
    const references = this.retrieveSimilarPublications(topic, this.config.maxRetrievalCount)

    // 2. 检索相似工作流经验记忆（来自 ExperienceMemoryService）
    const workflowReferences = this.retrieveWorkflowExperiences(topic)

    // 合并引用
    const allReferences = [...references, ...workflowReferences]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.config.maxRetrievalCount)

    const hasSufficientData = allReferences.length > 0

    // 3. 生成建议
    const suggestions = await this.generateSuggestions(topic, platform || '', allReferences)

    log('INFO', 'blog_assistant_new_blog', {
      topic: topic.slice(0, 50),
      platform: platform || '未指定',
      referencesFound: allReferences.length,
      hasSuggestions: !!suggestions.titleOptimization || !!suggestions.contentImprovements,
      durationMs: Date.now() - t0,
    })

    return {
      topic,
      platform: platform || '',
      suggestions,
      references: allReferences,
      hasSufficientData,
    }
  }

  // ===========================================================================
  // 核心 API：博客发布记录
  // ===========================================================================

  /**
   * 在博客发布后调用：将元数据记录到 MemoryService。
   *
   * @param params 发布参数
   * @returns 发布记录结果
   */
  onBlogPublished(params: PublishParams): BlogPublicationRecord {
    if (!this.config.enabled) {
      log('INFO', 'blog_assistant_disabled')
      return { memoryId: '', blogId: '', recordedAt: Date.now(), title: params.title }
    }

    const ms = getMemoryService()
    if (!ms) {
      log('WARN', 'blog_assistant_no_memory_service')
      return { memoryId: '', blogId: '', recordedAt: Date.now(), title: params.title }
    }

    const blogId = params.blogId || `pub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()

    // 计算互动率
    const perf = params.performance
    let engagementRate: number | undefined
    const views = perf?.views || 0
    if (views > 0) {
      const engagements = (perf?.likes || 0) + (perf?.comments || 0) + (perf?.shares || 0)
      engagementRate = Math.round((engagements / views) * 10000) / 10000
    }

    const metadata: BlogPublicationMetadata = {
      title: params.title,
      summary: params.summary.slice(0, 300),
      platform: params.platform,
      topic: params.topic,
      wordCount: params.wordCount,
      tags: params.tags,
      hasCode: params.hasCode,
      views,
      likes: perf?.likes,
      comments: perf?.comments,
      shares: perf?.shares,
      engagementRate,
      blogId,
      publishedAt: now,
      recordedAt: now,
      notes: params.notes,
    }

    // 将发布数据编码到 structuredData 中
    const structuredData: BlogMemoryStructuredData = {
      blogId,
      planId: `publish_${blogId}`,
      planTitle: params.title,
      stepIndex: -1,
      stepDescription: `发布到 ${params.platform}`,
      timestamp: now,
      category: this.categorizeByTopic(params.topic),
    }

    ms.addEntry('blog_memory', this.formatPublicationContent(metadata), this.config.defaultConfidence, {
      tier: this.config.defaultTier,
      structuredData: JSON.stringify(structuredData),
    })

    log('INFO', 'blog_assistant_published', {
      blogId,
      title: params.title.slice(0, 50),
      platform: params.platform,
      topic: params.topic.slice(0, 30),
      wordCount: params.wordCount,
    })

    return {
      memoryId: blogId,
      blogId,
      recordedAt: now,
      title: params.title,
    }
  }

  // ===========================================================================
  // 核心 API：清除历史
  // ===========================================================================

  /**
   * 清除所有博客记忆。
   *
   * @param keepPinned 是否保留被固定的条目（默认 true）
   * @returns 清除的条目数
   */
  clearAllHistory(keepPinned = true): number {
    const ms = getMemoryService()
    if (!ms) return 0

    let count = 0
    for (const entry of ms.getEntries()) {
      if (entry.type !== 'blog_memory') continue
      if (keepPinned && entry.isPinned) continue
      if (ms.forgetEntry(entry.id)) count++
    }

    log('INFO', 'blog_assistant_cleared', { count, keepPinned })
    return count
  }

  /**
   * 清除指定 blogId 的记忆。
   */
  clearBlogHistory(blogId: string, keepPinned = true): number {
    const ms = getMemoryService()
    if (!ms) return 0

    let count = 0
    for (const entry of ms.getEntries()) {
      if (entry.type !== 'blog_memory') continue
      if (!entry.structuredData) continue
      if (keepPinned && entry.isPinned) continue
      try {
        const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData
        if (data.blogId === blogId) {
          if (ms.forgetEntry(entry.id)) count++
        }
      } catch {
        continue
      }
    }

    log('INFO', 'blog_assistant_cleared_blog', { blogId, count, keepPinned })
    return count
  }

  // ===========================================================================
  // 核心 API：Prompt 注入
  // ===========================================================================

  /**
   * 将建议格式化为 Prompt 注入段。
   * 适合插入博客工作流子代理的 Prompt 模板。
   *
   * @param suggestions 由 onNewBlog 返回的建议
   * @returns 格式化后的纯文本段落
   */
  formatSuggestionPrompt(suggestions: BlogMemorySuggestion): string {
    if (!this.config.autoInjectPrompt) return ''

    const lines: string[] = []
    lines.push('')
    lines.push('【记忆驱动博客助手 · 基于历史数据的建议】')
    lines.push('')

    // 标题优化
    if (suggestions.titleOptimization?.candidates?.length) {
      lines.push('📌 标题建议：')
      for (const c of suggestions.titleOptimization.candidates) {
        lines.push(`   - ${c}`)
      }
      if (suggestions.titleOptimization.reasoning) {
        lines.push(`   → ${suggestions.titleOptimization.reasoning}`)
      }
      lines.push('')
    }

    // 发布时间
    if (suggestions.publishingTime) {
      const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
      const day = dayNames[suggestions.publishingTime.suggestedDay] || '周三'
      lines.push(`⏰ 推荐发布时间：${day} ${suggestions.publishingTime.suggestedHour}:00`)
      if (suggestions.publishingTime.reasoning) {
        lines.push(`   → ${suggestions.publishingTime.reasoning}`)
      }
      lines.push('')
    }

    // 内容改进
    if (suggestions.contentImprovements?.length) {
      lines.push('✏️ 内容改进建议：')
      for (const imp of suggestions.contentImprovements) {
        lines.push(`   - ${imp}`)
      }
      lines.push('')
    }

    // 相关选题
    if (suggestions.relatedTopics?.length) {
      lines.push('🔗 相关选题推荐：')
      for (const t of suggestions.relatedTopics) {
        lines.push(`   - ${t}`)
      }
      lines.push('')
    }

    // 引用来源
    if (suggestions.references?.length) {
      lines.push(`📚 参考了 ${suggestions.references.length} 条历史记忆`)
      for (const ref of suggestions.references.slice(0, 3)) {
        lines.push(`   - [${ref.category}] ${ref.content.slice(0, 100)}`)
      }
      lines.push('')
    }

    if (suggestions.summary) {
      lines.push(`💡 ${suggestions.summary}`)
      lines.push('')
    }

    lines.push('---')
    lines.push('')

    return lines.join('\n')
  }

  // ===========================================================================
  // 核心 API：统计
  // ===========================================================================

  /**
   * 获取博客记忆的统计信息。
   */
  getStats(): BlogMemoryAssistantStats {
    const ms = getMemoryService()
    if (!ms) {
      return {
        totalEntries: 0,
        publicationCount: 0,
        pinnedCount: 0,
        blogCount: 0,
        platformCounts: {},
        categoryCounts: {},
      }
    }

    const blogIds = new Set<string>()
    const platformCounts: Record<string, number> = {}
    const categoryCounts: Record<string, number> = {}
    let publicationCount = 0
    let pinnedCount = 0
    let totalEntries = 0

    for (const entry of ms.getEntries()) {
      if (entry.type !== 'blog_memory') continue
      totalEntries++
      if (entry.isPinned) pinnedCount++

      if (entry.structuredData) {
        try {
          const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData
          blogIds.add(data.blogId)
          categoryCounts[data.category] = (categoryCounts[data.category] || 0) + 1

          // 检测是否为发布记录（stepIndex 为 -1 且 stepDescription 以 "发布到" 开头）
          if (data.stepIndex === -1 && data.stepDescription.startsWith('发布到')) {
            publicationCount++
            // 从 stepDescription 提取平台
            const platform = data.stepDescription.replace('发布到 ', '')
            platformCounts[platform] = (platformCounts[platform] || 0) + 1
          }
        } catch {
          continue
        }
      }
    }

    return {
      totalEntries,
      publicationCount,
      pinnedCount,
      blogCount: blogIds.size,
      platformCounts,
      categoryCounts,
    }
  }

  /**
   * 获取历史发布记录列表。
   */
  getPublicationHistory(limit = 10): BlogPublicationMetadata[] {
    const ms = getMemoryService()
    if (!ms) return []

    const publications: BlogPublicationMetadata[] = []

    for (const entry of ms.getEntries()) {
      if (entry.type !== 'blog_memory') continue
      if (!entry.structuredData) continue

      try {
        const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData
        // 只提取发布记录
        if (data.stepIndex !== -1 || !data.stepDescription.startsWith('发布到')) continue

        publications.push({
          title: data.planTitle || '未命名',
          summary: entry.content.slice(0, 200),
          platform: data.stepDescription.replace('发布到 ', ''),
          topic: data.category,
          blogId: data.blogId,
          publishedAt: data.timestamp,
          recordedAt: data.timestamp,
        })
      } catch {
        continue
      }
    }

    // 按时间降序排列
    publications.sort((a, b) => b.publishedAt - a.publishedAt)
    return publications.slice(0, limit)
  }

  // ===========================================================================
  // 内部方法：检索
  // ===========================================================================

  /**
   * 检索相似的历史发布记忆（基于 fallback 嵌入的语义相似度）。
   */
  private retrieveSimilarPublications(
    query: string,
    limit: number,
  ): Array<{ content: string; category: string; similarity: number; title?: string }> {
    const ms = getMemoryService()
    if (!ms || !query.trim()) return []

    const queryEmb = fallbackEmbed(query)
    const results: Array<{ content: string; category: string; similarity: number; title?: string }> = []

    for (const entry of ms.getEntries()) {
      if (entry.type !== 'blog_memory') continue
      if (!entry.structuredData) continue

      try {
        const data = JSON.parse(entry.structuredData) as BlogMemoryStructuredData
        const contentEmb = fallbackEmbed(entry.content)
        const similarity = cosineSimilarity(queryEmb, contentEmb)

        if (similarity >= this.config.similarityThreshold) {
          results.push({
            content: entry.content.slice(0, 300),
            category: data.category,
            similarity,
            title: data.planTitle || undefined,
          })
        }
      } catch {
        continue
      }
    }

    results.sort((a, b) => b.similarity - a.similarity)
    return results.slice(0, limit)
  }

  /**
   * 从 ExperienceMemoryService 检索相似工作流经验。
   */
  private retrieveWorkflowExperiences(
    query: string,
  ): Array<{ content: string; category: string; similarity: number; title?: string }> {
    if (!experienceMemoryService) return []

    try {
      const results = experienceMemoryService.searchSimilarSync(query, this.config.maxRetrievalCount)
      return results.map((r) => ({
        content: r.memoryEntry.content.slice(0, 300),
        category: r.data.category,
        similarity: r.score,
        title: r.data.planTitle || undefined,
      }))
    } catch {
      return []
    }
  }

  // ===========================================================================
  // 内部方法：建议生成
  // ===========================================================================

  /**
   * 生成建议：优先使用 LLM，回退到基于规则的默认建议。
   */
  private async generateSuggestions(
    topic: string,
    platform: string,
    references: Array<{ content: string; category: string; similarity: number; title?: string }>,
  ): Promise<BlogMemorySuggestion> {
    // 尝试 LLM 生成
    if (this.config.enableLlmGeneration && this.llmGenerator && references.length > 0) {
      try {
        const llmResult = await this.llmGenerator(topic, platform, references)
        const now = Date.now()

        return {
          titleOptimization: llmResult.titleOptimization,
          publishingTime: llmResult.publishingTime,
          contentImprovements: llmResult.contentImprovements,
          relatedTopics: llmResult.relatedTopics,
          references: references.map((r) => ({
            content: r.content.slice(0, 200),
            category: r.category,
            similarity: Math.round(r.similarity * 100) / 100,
            title: r.title,
          })),
          summary: llmResult.summary || '已基于历史记忆生成建议，供参考。',
          generatedAt: now,
        }
      } catch (err) {
        log('WARN', 'blog_assistant_llm_failed', { error: String(err) })
        // LLM 失败后回退到规则建议
      }
    }

    // 基于规则的默认建议
    return this.buildRuleBasedSuggestions(topic, platform, references)
  }

  /**
   * 基于规则的默认建议生成（无 LLM 时的 fallback）。
   */
  private buildRuleBasedSuggestions(
    topic: string,
    platform: string,
    references: Array<{ content: string; category: string; similarity: number; title?: string }>,
  ): BlogMemorySuggestion {
    const now = Date.now()
    const refCategories = references.map((r) => r.category)
    const uniqueCategories = [...new Set(refCategories)]

    // 标题优化：基于主题生成候选
    const titleCandidates = this.generateTitleCandidates(topic, platform)

    // 发布时间：使用通用推荐
    const currentHour = new Date().getHours()
    const suggestedHour = currentHour < 12 ? 20 : currentHour < 18 ? 20 : 9
    const suggestedDay = new Date().getDay() < 3 ? 3 : new Date().getDay() > 5 ? 3 : (new Date().getDay() + 2) % 7

    // 内容改进建议
    const contentImprovements: string[] = []
    if (uniqueCategories.includes('analysis') || uniqueCategories.includes('design_decision')) {
      contentImprovements.push('历史记忆中有架构决策类内容，建议在文章中补充技术选型理由')
    }
    if (uniqueCategories.includes('bug_fix') || uniqueCategories.includes('performance')) {
      contentImprovements.push('你有过相关调优经验，建议加入具体的性能数据对比')
    }
    if (uniqueCategories.includes('test_result')) {
      contentImprovements.push('历史记录中包含测试结果，建议补充测试覆盖率或验证方法')
    }

    // 如果没有任何引用，给出通用建议
    if (contentImprovements.length === 0) {
      contentImprovements.push('建议用具体代码示例替代抽象描述，提高文章实用性')
      contentImprovements.push('在文章开头用实际问题或场景引入，增强读者代入感')
    }

    return {
      titleOptimization: {
        candidates: titleCandidates,
        reasoning: references.length > 0
          ? `基于 ${references.length} 条相似历史记忆的主题倾向生成`
          : '基于当前主题生成的通用标题建议',
      },
      publishingTime: {
        suggestedHour,
        suggestedDay,
        confidence: references.length > 0 ? 0.5 : 0.2,
        reasoning: references.length > 0
          ? '基于历史写作活跃度的通用推荐'
          : '历史数据不足，使用默认推荐时段',
      },
      contentImprovements,
      relatedTopics: references.length > 0
        ? [...uniqueCategories].slice(0, 3).map((c) => this.categoryToTopic(c))
        : undefined,
      references: references.map((r) => ({
        content: r.content.slice(0, 200),
        category: r.category,
        similarity: Math.round(r.similarity * 100) / 100,
        title: r.title,
      })),
      summary: references.length > 0
        ? `找到 ${references.length} 条相关的历史博客记忆可供参考，涵盖 ${uniqueCategories.join('、')} 等方面。建议结合历史经验优化文章结构和深度。`
        : '暂无相似历史博客记忆。建议先发布文章积累数据，后续迭代时自动优化。',
      generatedAt: now,
    }
  }

  // ===========================================================================
  // 内部方法：辅助
  // ===========================================================================

  /**
   * 生成标题候选。
   */
  private generateTitleCandidates(topic: string, platform: string): string[] {
    const candidates: string[] = []

    // 根据平台生成不同风格的标题
    if (platform === '掘金' || platform === 'CSDN') {
      candidates.push(`${topic}：从入门到实践`)
      candidates.push(`深入理解${topic}：原理与最佳实践`)
      candidates.push(`手把手教你实现${topic}`)
      candidates.push(`一文读懂${topic}`)
      candidates.push(`${topic}实战指南`)
    } else if (platform === '知乎') {
      candidates.push(`如何系统地学习${topic}？`)
      candidates.push(`关于${topic}，你不得不知的 5 个关键点`)
      candidates.push(`${topic}有哪些坑？我的踩坑总结`)
    } else if (platform === '公众号') {
      candidates.push(`${topic}，你真的了解吗？`)
      candidates.push(`深度解析${topic}：原理 + 实战`)
      candidates.push(`${topic}进阶指南`)
    } else {
      candidates.push(`${topic}实战：从原理到应用`)
      candidates.push(`深入解析${topic}`)
      candidates.push(`${topic}最佳实践指南`)
    }

    return candidates.slice(0, 5)
  }

  /**
   * 将 blog 分类映射为可读的主题建议。
   */
  private categoryToTopic(category: string): string {
    const map: Record<string, string> = {
      analysis: '代码分析相关',
      design_decision: '设计决策与架构',
      test_result: '测试与质量保障',
      refactoring: '代码重构与优化',
      bug_fix: '调试与 Bug 修复',
      performance: '性能优化与调优',
      architecture: '系统架构设计',
      other: '综合技术分享',
    }
    return map[category] || '技术分享'
  }

  /**
   * 通过主题内容猜测分类。
   */
  private categorizeByTopic(topic: string): BlogMemoryCategory {
    const lower = topic.toLowerCase()
    if (/性能|优化|benchmark|高并发/.test(lower)) return 'performance'
    if (/架构|设计|微服务|分布式/.test(lower)) return 'architecture'
    if (/测试|e2e|单元测试|集成测试/.test(lower)) return 'test_result'
    if (/重构|重构|重写|简化/.test(lower)) return 'refactoring'
    if (/bug|调试|修复|错误|error/.test(lower)) return 'bug_fix'
    if (/分析|解析|源码|原理|implement/.test(lower)) return 'analysis'
    if (/决定|选择|方案|对比|选型/.test(lower)) return 'design_decision'
    return 'other'
  }

  /**
   * 将发布元数据格式化为存储内容。
   */
  private formatPublicationContent(metadata: BlogPublicationMetadata): string {
    const parts: string[] = [`【发布】${metadata.title}`]
    if (metadata.summary) parts.push(`摘要：${metadata.summary}`)
    parts.push(`平台：${metadata.platform} | 主题：${metadata.topic}`)
    if (metadata.wordCount) parts.push(`字数：${metadata.wordCount}`)
    if (metadata.tags?.length) parts.push(`标签：${metadata.tags.join('、')}`)
    if (metadata.views !== undefined) parts.push(`阅读量：${metadata.views}`)
    if (metadata.likes !== undefined) parts.push(`点赞：${metadata.likes}`)
    if (metadata.comments !== undefined) parts.push(`评论：${metadata.comments}`)
    if (metadata.engagementRate !== undefined) parts.push(`互动率：${(metadata.engagementRate * 100).toFixed(2)}%`)
    return parts.join(' | ')
  }
}

// =============================================================================
// 全局单例
// =============================================================================

/** 全局 BlogMemoryAssistant 单例 */
export let blogMemoryAssistant: BlogMemoryAssistant | null = null

/**
 * 初始化博客记忆助手。
 * 应用启动时调用一次。
 */
export function initBlogMemoryAssistant(
  config?: Partial<BlogMemoryAssistantConfig>,
  llmGenerator?: SuggestionGenerator | null,
): BlogMemoryAssistant {
  if (!blogMemoryAssistant) {
    blogMemoryAssistant = new BlogMemoryAssistant(config, llmGenerator)
  }
  return blogMemoryAssistant
}

/**
 * 便捷方法：在开始新博客时获取建议 + 注入文本。
 * 等价于调用 initBlogMemoryAssistant().onNewBlog() 后再调用 formatSuggestionPrompt()。
 */
export async function suggestForNewBlog(
  topic: string,
  platform?: string,
): Promise<{ context: NewBlogContext; promptSegment: string }> {
  const assistant = blogMemoryAssistant || initBlogMemoryAssistant()
  const context = await assistant.onNewBlog(topic, platform)
  const promptSegment = assistant.formatSuggestionPrompt(context.suggestions)
  return { context, promptSegment }
}
