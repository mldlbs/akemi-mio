/**
 * Plan Memory Blog — 记忆增强博客时光机
 *
 * 在 Plan 工作流每个步骤执行后，自动将关键信息摘要
 * （如代码分析结论、设计决策、测试结果）存入 Memory，
 * 按博客 ID 和时间戳组织。发布前从 Memory 提取相关内容
 * 组装成"开发背后"章节或变更日志，自动插入博客末尾。
 */

export { BlogMemoryRecorder, blogMemoryRecorder, initBlogMemoryRecorder } from './BlogMemoryRecorder'
export { BlogMemoryRetriever, blogMemoryRetriever, initBlogMemoryRetriever } from './BlogMemoryRetriever'
export type { ParsedBlogMemory } from './BlogMemoryRetriever'
export type {
  BlogMemoryCategory,
  BlogMemoryStructuredData,
  BlogMemoryQueryOptions,
  BlogMemoryRenderOptions,
  BlogMemoryRecorderConfig,
} from './types'
