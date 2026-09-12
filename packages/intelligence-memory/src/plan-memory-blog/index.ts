/**
 * Plan Memory Blog — 记忆增强博客时光机 & 博客记忆助手
 *
 * 在 Plan 工作流每个步骤执行后，自动将关键信息摘要
 * （如代码分析结论、设计决策、测试结果）存入 Memory，
 * 按博客 ID 和时间戳组织。发布前从 Memory 提取相关内容
 * 组装成"开发背后"章节或变更日志，自动插入博客末尾。
 *
 * ExperienceMemoryService 在工作流引擎层面扩展了此功能，
 * 支持语义检索、用户标记、按任务/步骤/时间组织。
 *
 * BlogMemoryAssistant 提供记忆驱动的博客写作辅助：
 * - 新博客开始前检索相似历史记忆，生成个性化建议
 * - 发布后记录元数据（标题、摘要、平台、阅读量）
 * - 清除历史选项，尊重用户隐私
 */

export { BlogMemoryRecorder, blogMemoryRecorder, initBlogMemoryRecorder } from './BlogMemoryRecorder'
export { BlogMemoryRetriever, blogMemoryRetriever, initBlogMemoryRetriever } from './BlogMemoryRetriever'
export type { ParsedBlogMemory } from './BlogMemoryRetriever'
export { ExperienceMemoryService, experienceMemoryService, initExperienceMemoryService } from './ExperienceMemoryService'
export { BlogMemoryAssistant, blogMemoryAssistant, initBlogMemoryAssistant, suggestForNewBlog } from './BlogMemoryAssistant'
export type { PublishParams, NewBlogContext, SuggestionGenerator } from './BlogMemoryAssistant'
export type {
  BlogMemoryCategory,
  BlogMemoryStructuredData,
  BlogMemoryQueryOptions,
  BlogMemoryRenderOptions,
  BlogMemoryRecorderConfig,
  ExperienceSearchOptions,
  ExperienceSearchResult,
  BlogPublicationMetadata,
  BlogMemorySuggestion,
  BlogMemoryAssistantConfig,
  BlogMemoryAssistantStats,
  BlogPublicationRecord,
} from './types'
