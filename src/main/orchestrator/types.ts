/**
 * orchestrator/types.ts — 工具链编排核心类型定义
 *
 * 定义编排流程中的子任务、依赖关系、进度事件和结果类型。
 * 与 TaskGraph 的 DAG 结构对齐：
 *
 * | TaskGraph          | OrchestrationStep     | 说明                     |
 * |--------------------|----------------------|-------------------------|
 * | taskId             | id                   | 子任务唯一标识             |
 * | meta.dependsOn     | dependsOn            | 依赖的上级步骤 ID 列表     |
 * | —                  | toolName             | 映射到的 MCP 工具名        |
 * | —                  | args                 | 工具调用参数               |
 *
 * ## 数据流
 * 用户请求 → ToolChainDecomposer → OrchestrationPlan (DAG)
 *   → ToolChainOrchestrator → 拓扑序执行 → OrchestrationResult
 *   → 过程中发射 OrchestrationProgress → Wallpaper Overlay
 */

import type { ToolResult } from '../agent/ToolScheduler'

// ═══════════════════════════════════════════════
//  编排步骤
// ═══════════════════════════════════════════════

/** 编排步骤状态 */
export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

/** 单个编排步骤 */
export interface OrchestrationStep {
  /** 步骤唯一标识 */
  id: string
  /** 步骤名称（人类可读） */
  name: string
  /** 步骤描述 */
  description: string
  /** 依赖的上级步骤 ID 列表（空数组表示无依赖，可并行） */
  dependsOn: string[]
  /** 匹配到的 MCP 工具名（空字符串表示纯 LLM 推理步骤，无需工具） */
  toolName: string
  /** 工具调用参数 */
  args: Record<string, any>
  /** 当前状态 */
  status: StepStatus
  /** 执行结果文本 */
  result?: string
  /** 错误信息 */
  error?: string
  /** 开始执行时间戳 */
  startedAt?: number
  /** 完成执行时间戳 */
  completedAt?: number
  /** 执行耗时 (ms) */
  durationMs?: number
  /** 重试次数 */
  retryCount?: number
}

// ═══════════════════════════════════════════════
//  编排计划
// ═══════════════════════════════════════════════

/** 完整的编排计划（对应于 TaskGraph 的 DAG） */
export interface OrchestrationPlan {
  /** 计划唯一 ID */
  planId: string
  /** 原始用户请求 */
  userRequest: string
  /** 步骤列表 */
  steps: OrchestrationStep[]
  /** 计划创建时间 */
  createdAt: number
  /** 计划状态 */
  status: 'pending' | 'running' | 'completed' | 'failed'
}

// ═══════════════════════════════════════════════
//  进度事件（推送到 Wallpaper Overlay）
// ═══════════════════════════════════════════════

/** 进度事件类型 */
export type ProgressEventType =
  | 'plan_created'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'step_skipped'
  | 'orchestration_completed'
  | 'orchestration_failed'
  | 'retry_attempted'

/** 编排进度事件 payload */
export interface OrchestrationProgress {
  /** 事件类型 */
  type: ProgressEventType
  /** 计划 ID */
  planId: string
  /** 关联步骤 ID（按事件类型） */
  stepId?: string
  /** 步骤名称（展示用） */
  stepName?: string
  /** 完成步骤数 */
  completedSteps: number
  /** 总步骤数 */
  totalSteps: number
  /** 进度百分比 0-100 */
  percent: number
  /** 当前状态描述 */
  message: string
  /** 错误信息 */
  error?: string
  /** 时间戳 */
  timestamp: number
  /** 所有步骤的当前状态快照 */
  stepStatuses: Array<{
    id: string
    name: string
    status: StepStatus
    toolName: string
  }>
}

// ═══════════════════════════════════════════════
//  编排结果
// ═══════════════════════════════════════════════

/** 编排执行结果 */
export interface OrchestrationResult {
  /** 计划 ID */
  planId: string
  /** 是否全部成功 */
  success: boolean
  /** 各步骤的详细结果 */
  steps: OrchestrationStep[]
  /** 聚合后的最终输出文本 */
  summary: string
  /** 总耗时 (ms) */
  totalDurationMs: number
  /** 时间戳 */
  timestamp: number
  /** 错误信息 */
  error?: string
}

// ═══════════════════════════════════════════════
//  分解中间结果
// ═══════════════════════════════════════════════

/** LLM 分解返回的原始步骤定义（解析 JSON 用） */
export interface DecomposedStep {
  id: string
  name: string
  description: string
  dependsOn: string[]
  toolName: string
  args: Record<string, any>
}

/** LLM 分解返回的完整 JSON 结构 */
export interface DecompositionResult {
  reasoning: string
  steps: DecomposedStep[]
}

// ═══════════════════════════════════════════════
//  EventBus 事件名常量
// ═══════════════════════════════════════════════

export const ORCHESTRATION_EVENTS = {
  PROGRESS: 'orchestration:progress' as const,
  PLAN_CREATED: 'orchestration:plan_created' as const,
  COMPLETED: 'orchestration:completed' as const,
} as const

// ═══════════════════════════════════════════════
//  默认配置
// ═══════════════════════════════════════════════

export interface OrchestratorConfig {
  /** 步骤间最长执行时间 (ms) */
  stepTimeoutMs: number
  /** 失败重试次数 */
  maxRetries: number
  /** 是否启用自动降级（跳过失败的非关键步骤） */
  autoDegradation: boolean
  /** 最大并发步骤数 */
  maxConcurrency: number
  /** 分解时温度参数 */
  decompositionTemperature: number
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  stepTimeoutMs: 60000,
  maxRetries: 2,
  autoDegradation: true,
  maxConcurrency: 5,
  decompositionTemperature: 0.2,
}
