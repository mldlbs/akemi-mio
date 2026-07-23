/**
 * Plan Memory Blog — 记忆增强博客时光机类型定义
 *
 * 在 Plan 工作流步骤执行后，自动将关键信息摘要存入 Memory，
 * 按 blogId 和 timestamp 组织。发布前从 Memory 提取相关内容
 * 组装成"开发背后"章节或变更日志。
 */

/** 博客记忆的分类标签 */
export type BlogMemoryCategory =
  | 'analysis'      // 代码分析结论
  | 'design_decision' // 设计决策
  | 'test_result'   // 测试结果
  | 'refactoring'   // 重构记录
  | 'bug_fix'       // Bug 修复
  | 'performance'   // 性能优化
  | 'architecture'  // 架构决定
  | 'other'         // 其他

/** 博客记忆的结构化数据（存储在 MemoryEntry.structuredData 中） */
export interface BlogMemoryStructuredData {
  /** 博客 ID，用于分组相关记忆 */
  blogId: string
  /** 来源计划 ID */
  planId: string
  /** 来源计划标题 */
  planTitle: string
  /** 步骤索引 */
  stepIndex: number
  /** 步骤描述 */
  stepDescription: string
  /** 记录时间戳 */
  timestamp: number
  /** 记忆分类 */
  category: BlogMemoryCategory
}

/** 博客记忆检索选项 */
export interface BlogMemoryQueryOptions {
  /** 按分类筛选 */
  category?: BlogMemoryCategory | BlogMemoryCategory[]
  /** 最大返回条数 */
  limit?: number
  /** 起始时间戳 */
  fromTimestamp?: number
  /** 结束时间戳 */
  toTimestamp?: number
}

// =============================================================================
// 博客发布元数据（用于发布时记录）
// =============================================================================

/**
 * 博客发布元数据 — 记录发布时的关键信息。
 * 存入 blog_memory 类型条目的 structuredData 中，
 * 通过 BlogMemoryAssistant.onBlogPublished() 自动写入。
 */
export interface BlogPublicationMetadata {
  /** 文章标题 */
  title: string
  /** 文章摘要（120 字以内，SEO 友好） */
  summary: string
  /** 发布平台（blog/CSDN/知乎/掘金/公众号/个人博客等） */
  platform: string
  /** 博客主题/分类 */
  topic: string
  /** 正文字数 */
  wordCount?: number
  /** SEO 标签 */
  tags?: string[]
  /** 是否包含代码块 */
  hasCode?: boolean
  /** 发布后阅读量（发布时可能为 0） */
  views?: number
  /** 点赞数 */
  likes?: number
  /** 评论数 */
  comments?: number
  /** 分享/收藏数 */
  shares?: number
  /** 互动率（系统自动计算） */
  engagementRate?: number
  /** 博客 ID（用于关联开发过程记忆） */
  blogId: string
  /** 发布时间戳 */
  publishedAt: number
  /** 记录时间戳 */
  recordedAt: number
  /** 效果追踪备注 */
  notes?: string
}

// =============================================================================
// 博客记忆智能建议类型
// =============================================================================

/**
 * LLM 生成的博客建议 — 在开始新博客写作时基于相似历史记忆生成。
 * 由 BlogMemoryAssistant 自动调用 LLM 生成，注入工作流 Prompt。
 */
export interface BlogMemorySuggestion {
  /** 标题优化建议 */
  titleOptimization?: {
    /** 候选标题列表 */
    candidates: string[]
    /** 推荐理由 */
    reasoning: string
  }
  /** 发布时间建议 */
  publishingTime?: {
    /** 建议发布的小时 (0-23) */
    suggestedHour: number
    /** 建议发布的星期几 (0=周日) */
    suggestedDay: number
    /** 推荐置信度 */
    confidence: number
    /** 推荐理由 */
    reasoning: string
  }
  /** 内容改进建议 */
  contentImprovements?: string[]
  /** 相关选题推荐 */
  relatedTopics?: string[]
  /** 引用到的相似历史记忆 */
  references?: Array<{
    content: string
    category: string
    similarity: number
    title?: string
  }>
  /** 整体建议说明 */
  summary: string
  /** 生成时间 */
  generatedAt: number
}

/** BlogMemoryAssistant 配置 */
export interface BlogMemoryAssistantConfig {
  /** 总开关 */
  enabled: boolean
  /** 历史检索返回的最大条数 */
  maxRetrievalCount: number
  /** 语义搜索相似度阈值 */
  similarityThreshold: number
  /** 自动注入 Prompt（为 true 时 selfSuggest 会将建议格式化为 prompt 注入段） */
  autoInjectPrompt: boolean
  /** 是否启用 LLM 生成（如果为 false 则仅返回基于规则的建议） */
  enableLlmGeneration: boolean
  /** 默认记忆层级 */
  defaultTier: 'permanent' | 'semi' | 'ephemeral'
  /** 默认置信度 */
  defaultConfidence: number
  /** 最大发布记录条数 */
  maxPublicationRecords: number
}

/** 博客发布记录结果 */
export interface BlogPublicationRecord {
  /** 记忆条目 ID */
  memoryId: string
  /** 博客 ID（用于后续检索分组） */
  blogId: string
  /** 记录时间 */
  recordedAt: number
  /** 文章标题 */
  title: string
}

/** 博客记忆统计数据 */
export interface BlogMemoryAssistantStats {
  /** 总记忆条目数 */
  totalEntries: number
  /** 发布记录数 */
  publicationCount: number
  /** 被固定（重要）的条目数 */
  pinnedCount: number
  /** 涉及的 blogId 数量 */
  blogCount: number
  /** 按平台分类的发布数 */
  platformCounts: Record<string, number>
  /** 分类分布 */
  categoryCounts: Record<string, number>
}

// =============================================================================
// 博客记忆渲染选项（已有）
// =============================================================================

/** 博客记忆渲染选项 */
export interface BlogMemoryRenderOptions {
  /** 是否包含时间戳 */
  showTimestamps?: boolean
  /** 是否按分类分组 */
  groupByCategory?: boolean
  /** 自定义标题 */
  title?: string
  /** 自定义介绍文字 */
  intro?: string
  /** 最大内容长度（0=不截断） */
  maxContentLength?: number
  /** 语言（zh/en） */
  locale?: 'zh' | 'en'
}

/** 博客记忆记录器配置 */
export interface BlogMemoryRecorderConfig {
  /** 总开关 */
  enabled: boolean
  /** 最大条目数 */
  maxEntries: number
  /** 单条内容最大长度 */
  maxContentLength: number
  /** 默认记忆层级 */
  defaultTier: 'permanent' | 'semi' | 'ephemeral'
  /** 默认置信度 */
  defaultConfidence: number
}

// =============================================================================
// 经验记忆工作流引擎类型
// =============================================================================

/** 经验搜索选项 */
export interface ExperienceSearchOptions {
  /** 按分类筛选 */
  category?: BlogMemoryCategory | BlogMemoryCategory[]
  /** 按博客 ID 筛选 */
  blogId?: string
  /** 仅显示已固定的 */
  pinnedOnly?: boolean
  /** 最大返回条数 */
  limit?: number
  /** 起始时间戳 */
  fromTimestamp?: number
  /** 结束时间戳 */
  toTimestamp?: number
}

/** 经验搜索结果条目 */
export interface ExperienceSearchResult {
  /** 原始记忆条目 */
  memoryEntry: { id: string; content: string; type: string; confidence: number; tier: string; isPinned: boolean; createdAt: number }
  /** 结构化数据 */
  data: BlogMemoryStructuredData
  /** 相似度得分（0-1），语义搜索时有效；关键词搜索=1.0 */
  score: number
}
