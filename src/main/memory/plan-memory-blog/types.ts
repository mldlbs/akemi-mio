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
