/**
 * BlogExecutionMode — 博客写作双模式类型定义
 *
 * 定义「MCP」和「Plan:推理链(Plan Reasoning Chain)」两种执行模式
 * 及其最佳工作条件、切换快照数据结构。
 *
 * 模式对比：
 * - MCP 模式: LLM 通过 MCP 工具交互式驱动博客写作（适合简单/交互式场景）
 * - Plan:推理链 模式: Plan 驱动的自动化博客写作流水线（适合复杂/批处理场景）
 */

import type { BlogSessionState, WritingHabitProfile } from './types'

// =============================================================================
// 执行模式枚举
// =============================================================================

export type BlogExecutionMode = 'mcp' | 'plan_chain'

export const BLOG_MODE_LABELS: Record<BlogExecutionMode, string> = {
  mcp: 'MCP交互模式',
  plan_chain: 'Plan推理链模式',
}

export const BLOG_MODE_DESCRIPTIONS: Record<BlogExecutionMode, string> = {
  mcp: 'LLM 通过 MCP 工具交互式驱动博客写作，每步征求用户意见，适合探索性/简单内容',
  plan_chain: 'Plan 驱动的自动化博客写作流水线，按预定义工作流自动执行，适合复杂/批量内容',
}

// =============================================================================
// 模式最优条件定义
// =============================================================================

/** 输入特征评分（0-1） */
export interface InputFeatureProfile {
  /** 主题复杂度：0=简单（如"今天学了什么"），1=极复杂（如"分布式系统设计模式分析"） */
  topicComplexity: number
  /** 用户是否偏好交互式写作（逐段确认） */
  prefersInteractive: boolean
  /** 是否有明确的结构化需求（如已知大纲） */
  hasStructuredRequirements: boolean
  /** 是否需要深度技术分析（代码分析、架构图等） */
  requiresDeepAnalysis: boolean
  /** 是否涉及跨平台发布（多平台适配） */
  crossPlatformPublishing: boolean
  /** 用户对写作速度的期望：0=不急，1=非常急 */
  urgencyLevel: number
  /** 历史写作轮次均值（越多表明需要迭代） */
  avgRevisionRounds: number
}

/** 模式切换推荐 */
export interface ModeRecommendation {
  recommendedMode: BlogExecutionMode
  /** 置信度 0-1 */
  confidence: number
  /** 推荐理由 */
  reasons: string[]
  /** 输入特征摘要 */
  features: InputFeatureProfile
}

/** MCP 模式的最佳工作区间 */
export const MCP_OPTIMAL_CONDITIONS = {
  inputFeatures: {
    /** 主题复杂度 ≤ 0.5 时 MCP 模式更有优势 */
    maxTopicComplexity: 0.5,
    /** 用户偏好交互式或未知时，MCP 是安全的默认 */
    interactivePreferred: true,
  },
  loadRange: {
    /** 最多同时处理 3 个会话（交互式限制） */
    maxConcurrentSessions: 3,
  },
  responseTime: {
    /** 交互式应该快速响应 */
    targetLatencyMs: 5_000,
    maxAcceptableLatencyMs: 15_000,
  },
  /** 最适合的场景描述 */
  bestFor: [
    '主题简单明确，用户知道想写什么',
    '用户想在写作过程中频繁调整方向',
    '需要逐段确认质量',
    '探索性主题，大纲未定',
    '用户偏好轻量快速写作',
  ],
} as const

/** Plan:推理链 模式的最佳工作区间 */
export const PLAN_CHAIN_OPTIMAL_CONDITIONS = {
  inputFeatures: {
    /** 主题复杂度 ≥ 0.4 时 Plan 模式开始展现优势 */
    minTopicComplexity: 0.4,
    /** 结构化需求明确时 Plan 模式效率最高 */
    requiresStructuredRequirements: true,
  },
  loadRange: {
    /** 至少 1 个会话即可启动，但批量时优势明显 */
    minSessionsForBatch: 1,
    /** 可并行处理多个复杂任务 */
    maxConcurrentPlans: 5,
  },
  responseTime: {
    /** 批处理可接受更长等待 */
    targetLatencyMs: 30_000,
    maxAcceptableLatencyMs: 120_000,
  },
  /** 最适合的场景描述 */
  bestFor: [
    '主题复杂，需要深度技术分析和素材收集',
    '用户有明确的大纲或结构化需求',
    '需要跨平台发布规划（多平台适配）',
    '批量写作场景（如系列博客）',
    '用户不在场，后台自动化执行',
  ],
} as const

// =============================================================================
// 模式切换快照
// =============================================================================

/** 模式切换快照 — 用于状态保存与恢复 */
export interface ModeSwitchSnapshot {
  /** 快照唯一 ID */
  snapshotId: string
  /** 会话 ID */
  sessionId: string
  /** 源模式 */
  fromMode: BlogExecutionMode
  /** 目标模式 */
  toMode: BlogExecutionMode
  /** 快照创建时间 */
  capturedAt: number
  /** 会话状态（完整复制） */
  sessionState: BlogSessionState | null
  /** 当前模式下的额外状态 */
  modeState: Record<string, any>
  /** 已完成的阶段输出（按阶段名索引） */
  completedStageOutputs: Record<string, string>
  /** 用户反馈 */
  userFeedback: string[]
  /** 是否已恢复 */
  restored: boolean
}

// =============================================================================
// 模式切换请求
// =============================================================================

export interface ModeSwitchRequest {
  sessionId: string
  targetMode: BlogExecutionMode
  /** 切换原因 */
  reason: string
  /** 是否强制切换（即使可能存在风险） */
  force: boolean
}

/** 模式切换结果 */
export interface ModeSwitchResult {
  success: boolean
  snapshotId?: string
  fromMode: BlogExecutionMode
  toMode: BlogExecutionMode
  /** 切换耗时 ms */
  durationMs: number
  /** 失败原因 */
  error?: string
  /** 警告列表 */
  warnings: string[]
}

// =============================================================================
// 模式切换审计日志
// =============================================================================

export interface ModeSwitchLogEntry {
  timestamp: number
  sessionId: string
  fromMode: BlogExecutionMode
  toMode: BlogExecutionMode
  reason: string
  success: boolean
  durationMs: number
  trigger: 'auto' | 'manual' | 'forced'
}

// =============================================================================
// 复杂度评估辅助工具
// =============================================================================

/**
 * 评估博客主题的复杂度（0-1）
 * 基于关键词匹配和写作习惯
 */
export function evaluateTopicComplexity(topic: string, profile?: WritingHabitProfile): number {
  if (!topic || !topic.trim()) return 0.3

  const lower = topic.toLowerCase()

  // 高复杂度关键词（技术深度、架构、系统设计等）
  const highComplexitySignals = [
    '架构',
    '设计模式',
    '分布式',
    '微服务',
    '性能优化',
    '源码分析',
    '算法',
    '编译器',
    '内核',
    '数据库',
    'architecture',
    'design pattern',
    'distributed',
    'microservice',
    'deep dive',
    'under the hood',
    'internals',
    'optimization',
    '系统设计',
    '高并发',
    '高可用',
    '容错',
    '一致性',
    '原理',
    '机制',
    '实现',
    '底层',
    '框架设计',
  ]

  // 低复杂度关键词（入门、介绍、心得等）
  const lowComplexitySignals = [
    '入门',
    '介绍',
    '初探',
    '笔记',
    '心得',
    '教程',
    '指南',
    '快速',
    '简单',
    'hello world',
    'introduction',
    'getting started',
    'beginner',
    'tutorial',
    'guide',
    'quick',
    'simple',
    'basic',
    '日常',
    '记录',
    '分享',
    '随笔',
    '杂谈',
  ]

  let complexity = 0.5 // 默认中等

  // 高复杂度关键词匹配
  const highCount = highComplexitySignals.filter((kw) => lower.includes(kw)).length
  complexity += highCount * 0.08

  // 低复杂度关键词匹配
  const lowCount = lowComplexitySignals.filter((kw) => lower.includes(kw)).length
  complexity -= lowCount * 0.06

  // 主题长度也是一个指标（越长的主题越复杂）
  if (topic.length > 30) complexity += 0.1
  if (topic.length > 60) complexity += 0.1

  // 基于写作习惯的调整
  if (profile) {
    // 如果用户在高复杂度主题上有经验，适当降低复杂度评分
    if (profile.avgRevisionRounds >= 3) complexity -= 0.1
    // 如果用户偏好的文章较长，表明可能有深度内容
    if (profile.preferredLengthRange.max >= 3000) complexity += 0.05
  }

  return Math.max(0, Math.min(1, complexity))
}

/**
 * 评估输入特征，用于模式推荐
 */
export function evaluateInputFeatures(topic: string, userInput: string, profile?: WritingHabitProfile): InputFeatureProfile {
  const lower = (userInput || '').toLowerCase()

  return {
    topicComplexity: evaluateTopicComplexity(topic, profile),
    prefersInteractive: /逐段|一步一步|分步|确认|问我|交互|interactive|step by step/i.test(lower) || !profile || profile.totalSessions < 3,
    hasStructuredRequirements: /大纲|结构|章节|目录|outline|structure|chapter|toc/i.test(lower) || (profile?.prefersOutline ?? true),
    requiresDeepAnalysis:
      /源码|代码分析|实现原理|性能|架构|设计|source code|analysis|implementation|architecture/i.test(lower) ||
      evaluateTopicComplexity(topic) > 0.5,
    crossPlatformPublishing: /多平台|全平台|公众号.*博客|多端|multiple platform|cross.publish/i.test(lower || '') || false,
    urgencyLevel: /急|马上|尽快|urgent|asap|quick|immediately/i.test(lower) ? 0.8 : 0.3,
    avgRevisionRounds: profile?.avgRevisionRounds ?? 1,
  }
}
