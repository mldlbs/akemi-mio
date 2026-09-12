/**
 * plan-scheduler/types.ts — Agent 驱动的智能任务调度器类型定义
 *
 * 核心概念：
 * - PlanTask: 计划步骤 → 可执行任务单元，包含工具分配、依赖、状态
 * - PlanTaskState: 状态机（pending → analyzing → tool_selected → executing → completed/failed）
 * - ToolAssignment: LLM 根据步骤描述自动分配的推荐工具
 * - PlanExecutionPlan: 全量执行计划（拓扑排序后的步骤队列 + 依赖边）
 * - FeedbackRecord: 每次执行后的反馈数据，用于调度策略优化
 */

import type { DevPlan, PlanManagerLike } from '@akemi-mio/evolution/types'

// ─── 状态机 ──────────────────────────────────────────────────

/** PlanTask 状态机 */
export type PlanTaskState =
  | 'pending' // 等待依赖就绪
  | 'analyzing' // LLM 分析步骤并分配工具
  | 'tool_selected' // 工具已确定，等待执行
  | 'executing' // 工具调用中
  | 'completed' // 执行成功
  | 'failed' // 执行失败（可重试）
  | 'degraded' // 降级执行（回退工具 / 简化参数）
  | 'needs_confirm' // 需用户确认后继续
  | 'skipped' // 跳过（依赖失败或用户取消）
  | 'cancelled' // 已取消

/** PlanTask 状态机合法迁移 */
export const VALID_STATE_TRANSITIONS: Record<PlanTaskState, PlanTaskState[]> = {
  pending: ['analyzing', 'skipped', 'cancelled'],
  analyzing: ['tool_selected', 'failed', 'cancelled'],
  tool_selected: ['executing', 'analyzing', 'cancelled'],
  executing: ['completed', 'failed', 'degraded', 'needs_confirm', 'cancelled'],
  completed: [],
  failed: ['analyzing', 'degraded', 'needs_confirm', 'skipped', 'cancelled'],
  degraded: ['executing', 'failed', 'needs_confirm', 'cancelled'],
  needs_confirm: ['executing', 'degraded', 'skipped', 'cancelled'],
  skipped: [],
  cancelled: [],
}

// ─── 工具分配 ──────────────────────────────────────────────────

/** LLM 推荐的工具分配 */
export interface ToolSuggestion {
  /** 工具名称（如 edit_file、run_command、read_file） */
  toolName: string
  /** 置信度 0-1 */
  confidence: number
  /** 预期参数模板（LLM 生成的示例参数） */
  expectedArgs: Record<string, unknown>
  /** 备选工具（当首选不可用时降级） */
  fallbackTools: string[]
  /** 人类可读的分配理由 */
  rationale: string
}

/** 步骤分析结果（LLM 输出） */
export interface StepAnalysisResult {
  /** 步骤索引 */
  stepIndex: number
  /** 步骤简短摘要 */
  summary: string
  /** 推荐工具列表（按优先级排序） */
  toolSuggestions: ToolSuggestion[]
  /** 此步骤依赖的其他步骤索引 */
  dependsOn: number[]
  /** 预期耗时估计（秒） */
  estimatedDurationSec: number
  /** 是否为阻塞性步骤（后续步骤需等待） */
  isBlocking: boolean
  /** 是否需要人工确认 */
  needsConfirmation: boolean
  /** 执行此步骤所需的环境/上下文提示 */
  contextHints: string[]
}

// ─── 可执行任务 ──────────────────────────────────────────────────

/** 计划中的单个可执行任务单元 */
export interface PlanTask {
  /** 唯一 ID */
  id: string
  /** 所属计划 ID */
  planId: string
  /** 步骤索引 */
  stepIndex: number
  /** 步骤描述 */
  description: string
  /** 当前状态 */
  state: PlanTaskState
  /** LLM 分析结果 */
  analysis: StepAnalysisResult | null
  /** 当前选中的工具名 */
  activeTool: string | null
  /** 选中工具的参数 */
  activeArgs: Record<string, unknown> | null
  /** 执行计数（失败重试次数） */
  attemptCount: number
  /** 最大重试次数 */
  maxAttempts: number
  /** 最近一次错误信息 */
  lastError: string | null
  /** 创建时间 */
  createdAt: number
  /** 开始执行时间 */
  startedAt: number | null
  /** 完成时间 */
  completedAt: number | null
  /** 执行耗时（毫秒） */
  durationMs: number | null
  /** 依赖的任务 ID 列表（这些任务完成后才能执行） */
  dependsOnTaskIds: string[]
  /** 工具调用返回的内容 */
  output: string | null
}

// ─── 执行计划 ──────────────────────────────────────────────────

/** 全量执行计划 */
export interface PlanExecutionPlan {
  /** 计划 ID */
  planId: string
  /** 计划标题 */
  planTitle: string
  /** 排序后的任务列表（拓扑序） */
  tasks: PlanTask[]
  /** 总预估耗时（秒） */
  estimatedTotalSec: number
  /** 并行批次（同批次可并行执行） */
  batches: PlanTask[][]
}

// ─── 反馈数据 ──────────────────────────────────────────────────

/** 单次步骤执行反馈 */
export interface FeedbackRecord {
  /** 反馈记录 ID */
  id: string
  /** 计划 ID */
  planId: string
  /** 步骤索引 */
  stepIndex: number
  /** 步骤描述 */
  stepDescription: string
  /** 选用的工具 */
  toolUsed: string | null
  /** 是否成功 */
  success: boolean
  /** 耗时（毫秒） */
  durationMs: number
  /** 重试次数 */
  retryCount: number
  /** 是否降级执行 */
  wasDegraded: boolean
  /** 错误信息（若有） */
  error: string | null
  /** LLM 工具推荐列表（用于对比实际效果） */
  suggestedTools: string[]
  /** 用户反馈评分 -1(差) ~ 1(好)，0=未评价 */
  userRating: number
  /** 创建时间 */
  createdAt: number
}

/** 聚合调度指标 */
export interface SchedulerMetrics {
  /** 统计窗口内的总任务数 */
  totalTasks: number
  /** 成功任务数 */
  succeededTasks: number
  /** 失败任务数 */
  failedTasks: number
  /** 成功率 */
  successRate: number
  /** 平均耗时（毫秒） */
  avgDurationMs: number
  /** 工具使用统计 */
  toolUsage: Record<string, number>
  /** 工具成功率 */
  toolSuccessRate: Record<string, number>
  /** 常见错误模式 */
  errorPatterns: Array<{ error: string; count: number }>
  /** 优化建议 */
  suggestions: string[]
}

/** 调度器事件类型 */
export type PlanSchedulerEvent =
  | { type: 'plan.registered'; planId: string; planTitle: string }
  | { type: 'plan.execution_started'; planId: string; taskCount: number }
  | { type: 'plan.execution_completed'; planId: string; success: boolean }
  | { type: 'plan.execution_failed'; planId: string; error: string }
  | { type: 'task.state_changed'; taskId: string; planId: string; from: PlanTaskState; to: PlanTaskState }
  | { type: 'task.tool_selected'; taskId: string; toolName: string }
  | { type: 'task.executing'; taskId: string; toolName: string }
  | { type: 'task.completed'; taskId: string; planId: string; durationMs: number }
  | { type: 'task.failed'; taskId: string; planId: string; error: string; attempt: number }
  | { type: 'task.degraded'; taskId: string; planId: string; fallbackTool: string; reason: string }
  | { type: 'task.needs_confirm'; taskId: string; planId: string; issue: string }
  | { type: 'feedback.collected'; record: FeedbackRecord }
  | { type: 'suggestion.generated'; suggestion: string }

/** 调度器配置 */
export interface PlanSchedulerConfig {
  /** 最大并发任务数 */
  maxConcurrency: number
  /** 单步最大重试次数 */
  maxRetriesPerStep: number
  /** 是否启用自动降级 */
  enableDegradation: boolean
  /** 是否启用 LLM 分析 */
  enableLLMAnalysis: boolean
  /** 分析超时（毫秒） */
  analysisTimeoutMs: number
  /** 执行超时（毫秒） */
  executionTimeoutMs: number
  /** 反馈收集窗口（毫秒） */
  feedbackWindowMs: number
  /** 是否需用户确认后才执行 */
  requireUserConfirmation: boolean
  /** LLM 模型温度 */
  llmTemperature: number
}

export const DEFAULT_SCHEDULER_CONFIG: PlanSchedulerConfig = {
  maxConcurrency: 3,
  maxRetriesPerStep: 2,
  enableDegradation: true,
  enableLLMAnalysis: true,
  analysisTimeoutMs: 30000,
  executionTimeoutMs: 120000,
  feedbackWindowMs: 7 * 24 * 60 * 60 * 1000, // 7 天
  requireUserConfirmation: false,
  llmTemperature: 0.2,
}

// ─── 快照类型 ──────────────────────────────────────────────────

/** 序列化的任务快照（PlanTask 的可持久化子集） */
export interface SerializedTaskSnapshot {
  id: string
  stepIndex: number
  description: string
  state: PlanTaskState
  analysis: StepAnalysisResult | null
  activeTool: string | null
  activeArgs: Record<string, unknown> | null
  attemptCount: number
  maxAttempts: number
  lastError: string | null
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
  dependsOnTaskIds: string[]
  output: string | null
}

/** 计划上下文快照数据（作为 Memory structuredData JSON 存储） */
export interface PlanSnapshotData {
  version: number
  planId: string
  planTitle: string
  tasks: SerializedTaskSnapshot[]
  summary: { total: number; completed: number; failed: number; skipped: number; cancelled: number; remaining: number }
  snapshotReason: string
  createdAt: number
}

/** 快照触发原因 */
export type SnapshotReason = 'batch_complete' | 'pause' | 'task_switch' | 'manual'

// ─── 调度器外部依赖 ─────────────────────────────────────────────

/** 调度器外部依赖 */
export interface PlanSchedulerDeps {
  planManager: PlanManagerLike
  llmService: { chatJson: (prompt: string, opts?: any) => Promise<{ data?: any; error?: string }> }
  emitEvent: (event: PlanSchedulerEvent) => void
  log: (level: string, msg: string, meta?: Record<string, any>) => void
}
