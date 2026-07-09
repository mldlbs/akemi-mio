/**
 * UserBehavior Layer — 类型定义
 *
 * UserBehavior 作为 Evolution 的上层增强层，拦截其输入输出
 * 进行预处理/后处理增强，通过 feature flag 控制开放范围。
 */

import type { PipelineMetrics } from '../evolution/automation'

// ==================== Feature Flag 配置 ====================

/**
 * UserBehavior 功能开关（环境变量驱动）
 *
 * USER_BEHAVIOR_FEATURES — 逗号分隔的启用特性列表
 * 示例: "summary_enhance,metrics_enrich,pre_collect_filter"
 *
 * 所有特性默认关闭，仅在显式声明后激活。
 */
export type UserBehaviorFeature =
  /** 增强进化周期报告的摘要内容 */
  | 'summary_enhance'
  /** 丰富管道指标（附加行为上下文） */
  | 'metrics_enrich'
  /** 预处理：在管道运行前过滤/调整 collectors */
  | 'pre_collect_filter'
  /** 后处理：在管道结果上施加额外分析 */
  | 'post_analyze'
  /** 行为驱动的管道参数调整（如 maxFixesPerCycle 动态调整） */
  | 'dynamic_pipeline_tuning'
  /** 行为驱动优化：根据高频序列生成代码优化计划 */
  | 'behavior_driven_optimization'
  /** 行为序列分析：提取工具调用 n-gram 序列 */
  | 'behavior_sequence_analysis'
  /** 行为驱动的自动预加载优化 */
  | 'behavior_preload_optimization'

export type UserBehaviorFeatureMap = ReadonlySet<UserBehaviorFeature>

// ==================== 钩子类型 ====================

/** 预处理上下文 — Evolution 执行前 */
export interface PreProcessContext {
  /** 当前时间戳 */
  timestamp: number
  /** 距上次成功运行的小时数 */
  hoursSinceLastRun: number
  /** 连续失败次数 */
  consecutiveFailures: number
  /** 安全模式 */
  safetyMode: 'review' | 'auto'
  /** 用户是否活跃 */
  userActive: boolean
}

/** 后处理上下文 — Evolution 执行后 */
export interface PostProcessContext {
  /** 原始管道指标 */
  rawMetrics: PipelineMetrics | null
  /** 是否成功 */
  success: boolean
  /** 原始摘要文本 */
  rawSummary: string
  /** 执行耗时 (ms) */
  durationMs: number
  /** 预处理阶段附加的数据（由 preProcess hook 写入） */
  preProcessData?: Record<string, unknown>
  /** 预处理阶段产生的日志/消息 */
  preProcessMessages?: string[]
}

/** 后处理结果 — 对原始结果的增强 */
export interface PostProcessResult {
  /** 增强后的摘要（可为空表示不替换原摘要） */
  enhancedSummary?: string
  /** 后处理附加数据（注入 event payload 或日志） */
  extraData?: Record<string, unknown>
  /** 后处理日志 */
  messages?: string[]
}

/** 预处理钩子签名 */
export type PreProcessHook = (ctx: PreProcessContext) => PreProcessContext | Promise<PreProcessContext>

/** 后处理钩子签名 */
export type PostProcessHook = (ctx: PostProcessContext) => PostProcessResult | Promise<PostProcessResult>

// ==================== 配置 ====================

export interface UserBehaviorConfig {
  /** 启用特性集合（空集合 = 层存在但不生效） */
  features: UserBehaviorFeature[]
  /** 注册的预处理钩子 */
  preHooks?: PreProcessHook[]
  /** 注册的后处理钩子 */
  postHooks?: PostProcessHook[]
  /** 调试模式：输出更多日志 */
  debug?: boolean
}

// ==================== 特性注册表 ====================

/** 解析 USER_BEHAVIOR_FEATURES 环境变量为特性集合 */
export function parseFeaturesFromEnv(): UserBehaviorFeature[] {
  const raw = process.env.USER_BEHAVIOR_FEATURES || ''
  if (!raw.trim()) return []

  const allowed: Set<string> = new Set([
    'summary_enhance',
    'metrics_enrich',
    'pre_collect_filter',
    'post_analyze',
    'dynamic_pipeline_tuning',
    'behavior_driven_optimization',
    'behavior_sequence_analysis',
    'behavior_preload_optimization',
  ])

  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => allowed.has(s)) as UserBehaviorFeature[]
}
