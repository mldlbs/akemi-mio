/**
 * Anti-MCP 类型定义
 *
 * 反 MCP：对当前 MCP↔Plan 关系的假设反转探索。
 *
 * 当前关系假设：
 * 1. MCP 是基础设施层，Plan 是内容层（MCP主，Plan从）
 * 2. MCP 先执行（工具路由），Plan 后执行（被动存储）
 * 3. MCP 决策（工具可用性/授权），Plan 执行（跟踪步骤）
 *
 * 本模块实现反转版本：Plan 决策，MCP 执行
 */

import type { Tool } from '../tool/types'
import type { RewritePlan, RewriteTask } from '../writing/types'
import type { MCPToolResult } from '../mcp/types'

// ============================================================================
// Plan 驱动执行器的核心类型
// ============================================================================

/** Plan 驱动的执行步骤 */
export interface PlanDrivenStep {
  /** 对应原始计划中的任务 ID */
  taskId: string
  /** 步骤序号 */
  sequence: number
  /** 步骤描述 */
  description: string
  /** 要调用的 MCP 工具名 */
  toolName: string
  /** 工具调用参数（可含模板变量 ${chapterNumber} 等） */
  toolArgs: Record<string, any>
  /** 结果评估策略 */
  evaluation: StepEvaluation
  /** 成功后的跳转（下一步或完成） */
  onSuccess: StepTransition
  /** 失败后的跳转（重试或回退） */
  onFailure: StepTransition
  /** 最大重试次数 */
  maxRetries: number
  /** 当前重试计数 */
  retryCount?: number
  /** 上一步骤序号（用于依赖跟踪） */
  dependsOn: number[]
}

/** 步骤结果评估策略 */
export type StepEvaluation =
  | { type: 'check_isError' }  // 检查 MCP result.isError
  | { type: 'string_match'; pattern: RegExp }  // 匹配结果文本
  | { type: 'llm_judge'; prompt: string }  // 由 LLM 评判
  | { type: 'always_pass' }  // 无条件通过

/** 步骤跳转 */
export interface StepTransition {
  type: 'next' | 'goto' | 'complete' | 'fail'
  targetSequence?: number
}

/** 执行上下文 */
export interface ExecutionContext {
  /** 原始重写计划 */
  rewritePlan: RewritePlan
  /** 展开的执行步骤列表 */
  steps: PlanDrivenStep[]
  /** 当前步骤索引 */
  currentStepIndex: number
  /** 已完成步骤的结果 */
  completedResults: Map<string, {
    stepSequence: number
    result: MCPToolResult | null
    success: boolean
    durationMs: number
    error?: string
  }>
  /** 开始时间 */
  startedAt: number
  /** 最后一次更新时间 */
  lastUpdatedAt: number
  /** 执行状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'paused'
  /** 执行日志 */
  log: ExecutionLogEntry[]
}

/** 执行日志条目 */
export interface ExecutionLogEntry {
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'debug'
  stepSequence?: number
  message: string
  data?: any
}

/** Plan 驱动执行器的输出报告 */
export interface PlanDrivenReport {
  planId: string
  storyName: string
  totalTasks: number
  completedTasks: number
  failedTasks: number
  overallProgress: number // 0-100
  durationMs: number
  status: ExecutionContext['status']
  stepResults: Array<{
    sequence: number
    taskId: string
    toolName: string
    success: boolean
    durationMs: number
    error?: string
  }>
  log: ExecutionLogEntry[]
}

// ============================================================================
// Plan 驱动适配器接口
// ============================================================================

/**
 * 工具调用桥接器 — 由 ServerManager 或外部 Mock 实现。
 * 这是 Plan→MCP 的反转调用点。
 */
export interface ToolCallBridge {
  callTool(name: string, args: Record<string, any>): Promise<MCPToolResult>
  getTool(name: string): Tool | undefined
  listTools(): string[]
}

// ============================================================================
// 假设反转分析报告
// ============================================================================

/** 假设反转分析 */
export interface AssumptionInversion {
  /** 当前假设前提 */
  assumption: string
  /** 反转后的前提 */
  inversed: string
  /** 可行性评估 */
  feasibility: 'high' | 'medium' | 'low'
  /** 影响范围 */
  scope: string
  /** 风险 */
  risks: string[]
  /** 如果实现了会有什么价值 */
  value: string
}
