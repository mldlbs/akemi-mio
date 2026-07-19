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
  /** 模块热力图：在进化周期前生成模块级使用/错误热力图 */
  | 'module_heatmap'
  /** 热力图驱动的进化优先级：根据热力图调整进化分析重点 */
  | 'heatmap_driven_priority'
  /** 冷模块降频：低使用率模块降低分析频率 */
  | 'cold_module_dampening'
  /** 质量指标追踪：跨周期质量指标趋势分析与降级检测 */
  | 'quality_metrics'
  /** 反馈回路：MCP ↔ UserBehavior 强化回路（核心开关） */
  | 'mcp_feedback_loop'
  /** 反馈回路阻尼：指数平滑参数调整（防止振荡发散） */
  | 'feedback_loop_damping'
  /** 反馈回路收敛自动切换：收敛后自动从 monitor 切到 auto */
  | 'feedback_loop_auto_switch'

  // ═════════════════════════════════════════════════════════════════
  //  Plan:实验42：并发Workflow隔离性测试 — 渐进式引入
  // ═════════════════════════════════════════════════════════════════

  /** 实验42 Phase 1: 旁路输出不做决策（观察+日志） */
  | 'plan_experiment_42_passive'
  /** 实验42 Phase 2: 作为建议源影响部分决策 */
  | 'plan_experiment_42_suggestion'
  /** 实验42 Phase 3: 替换 UserBehavior 核心模块 */
  | 'plan_experiment_42_replacement'

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

// ==================== 模块热力图类型 ====================

/** 模块使用趋势 */
export type ModuleTrend = 'rising' | 'stable' | 'declining'

/** 模块优先级标签 */
export type ModulePriority = 'high' | 'medium' | 'low'

/** 模块热力图条目 */
export interface ModuleHeatmapEntry {
  /** 模块名称（如 agent, tts, asr 等） */
  module: string
  /** 窗口内的调用次数 */
  usageCount: number
  /** 窗口内的错误次数 */
  errorCount: number
  /** 成功率（0-1） */
  successRate: number
  /** 错误率（0-1） */
  errorRate: number
  /** 使用趋势 */
  trend: ModuleTrend
  /** 优化优先级 */
  priority: ModulePriority
  /** 模块中文描述 */
  description: string
}

// ==================== 质量指标类型 ====================

/** 指标趋势方向 */
export type MetricTrend = 'improving' | 'stable' | 'declining'

/** 单个质量指标的快照值 */
export interface MetricSnapshot {
  /** 指标名称（如 error_rate, success_rate, avg_pause_time） */
  name: string
  /** 当前值（0-1 范围，1 = 最好状态） */
  value: number
  /** 趋势方向 */
  trend: MetricTrend
  /** 与上一周期的变化量（绝对值） */
  delta: number
  /** 是否触发降级阈值 */
  degraded: boolean
  /** 该指标关联的模块（多个模块逗号分隔） */
  relatedModules?: string
  /** 指标描述 */
  description: string
}

/** 一次进化周期的质量指标快照 */
export interface QualityMetricsSnapshot {
  /** 快照 ID（格式: qm_{timestamp}） */
  id: string
  /** 创建时间戳 */
  createdAt: number
  /** 距上次快照的小时数 */
  hoursSinceLastSnapshot: number
  /** 指标列表 */
  metrics: MetricSnapshot[]
  /** 总体健康评分（0-100，0=最差，100=最好） */
  healthScore: number
  /** 健康评分变化量 */
  healthScoreDelta: number
  /** 是否触发了总体降级 */
  isDegraded: boolean
  /** 分析窗口内的总工具调用数 */
  totalToolCalls: number
  /** 降级信号列表（仅当 isDegraded=true 时非空） */
  degradationSignals: DegradationSignal[]
}

/** 降级信号 — Evolution 的优化目标 */
export interface DegradationSignal {
  /** 信号 ID */
  id: string
  /** 降级的指标名称 */
  metricName: string
  /** 当前值 */
  currentValue: number
  /** 上一周期值 */
  previousValue: number
  /** 变化量 */
  delta: number
  /** 降级严重度（0-1） */
  severity: number
  /** 关联模块 */
  relatedModules: string[]
  /** 建议的优化类型 */
  suggestedOptimizationType: string
  /** 优化描述 */
  description: string
  /** 推荐的优化目标代码模块 */
  recommendedTarget: string
}

/** 质量指标追踪器配置 */
export interface QualityMetricsConfig {
  /** 状态持久化路径 */
  stateFilePath: string
  /** 降级阈值：指标变化超过此值视为降级（默认 0.1 = 10%） */
  degradationThreshold: number
  /** 降级严重度阈值：超过此值才生成优化信号（默认 0.3） */
  severityThreshold: number
  /** 最大历史快照保留数 */
  maxSnapshots: number
}

// ==================== 模块热力图类型 ====================

/** 模块热力图 — Evolution 的优先级输入 */
export interface ModuleHeatmap {
  /** 全量条目列表（按使用量降序） */
  entries: ModuleHeatmapEntry[]
  /** 高频模块（高优先级进化目标） */
  hotModules: ModuleHeatmapEntry[]
  /** 高错误模块（进化修复候选人） */
  errorModules: ModuleHeatmapEntry[]
  /** 低频模块（可降低进化频率） */
  coldModules: ModuleHeatmapEntry[]
  /** 数据是否足够做判断 */
  hasSufficientData: boolean
  /** 分析窗口内总工具调用数 */
  totalToolCalls: number
  /** 生成时间戳 */
  generatedAt: number
}

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
    'module_heatmap',
    'heatmap_driven_priority',
    'cold_module_dampening',
    'quality_metrics',
    'mcp_feedback_loop',
    'feedback_loop_damping',
    'feedback_loop_auto_switch',
    'plan_experiment_42_passive',
    'plan_experiment_42_suggestion',
    'plan_experiment_42_replacement',
  ])

  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => allowed.has(s)) as UserBehaviorFeature[]
}
