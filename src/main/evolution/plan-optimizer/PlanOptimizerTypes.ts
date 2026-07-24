/**
 * PlanOptimizerTypes — 自进化计划优化器类型定义
 *
 * 定义计划优化分析的核心数据类型：
 * - PlanTaskDescriptor: 单个计划中某个步骤的结构化描述
 * - OptimizationSuggestion: LLM 生成的优化建议
 * - OptimizationRollback: 回滚快照
 * - PlanOptimizerConfig: 优化器配置
 */

import type { DevPlan } from '../types'

// =============================================================================
// 优化建议分类
// =============================================================================

export type OptimizationCategory =
  | 'duplicate_task'        // 多个计划中的相同/相似任务
  | 'conflicting_task'      // 冲突任务（如同时修改同一文件）
  | 'redundant_task'        // 冗余任务（已被其他已完成任务覆盖）
  | 'dependency_chain'      // 缺失的依赖链接
  | 'resource_contention'   // 竞争同一有限资源

// =============================================================================
// 计划任务描述符（结构化表示）
// =============================================================================

export interface PlanTaskDescriptor {
  /** 计划 ID */
  planId: string
  /** 计划标题 */
  planTitle: string
  /** 步骤在计划中的索引 */
  stepIndex: number
  /** 步骤 ID */
  stepId: string
  /** 步骤描述 */
  description: string
  /** 步骤状态 */
  status: string
  /** 估算的资源消耗类型 */
  estimatedResource?: string
  /** 受影响的文件路径列表 */
  affectedFiles?: string[]
  /** 任务依赖描述 */
  dependencies?: string[]
  /** 步骤已执行结果摘要（如有） */
  existingResult?: string
}

// =============================================================================
// 优化建议
// =============================================================================

export interface OptimizationSuggestion {
  /** 建议唯一标识 */
  id: string
  /** 优化分类 */
  category: OptimizationCategory
  /** 建议标题 */
  title: string
  /** 详细说明 */
  description: string
  /** 涉及的任务列表（跨计划） */
  affectedTasks: PlanTaskDescriptor[]
  /** 合并目标（可选） */
  mergeTarget?: { planId: string; stepIndex: number }
  /** 合并后的步骤描述（可选） */
  mergedDescription?: string
  /** 建议的操作类型 */
  suggestedAction: 'merge' | 'delete' | 'reorder' | 'split'
  /** LLM 置信度 0-1 */
  confidence: number
  /** 是否为可自动执行（无需用户审批） */
  autoExecutable: boolean
}

// =============================================================================
// 优化建议集合
// =============================================================================

export interface OptimizationAnalysis {
  /** 分析时间戳 */
  analyzedAt: number
  /** 被分析的计划列表 */
  analyzedPlanIds: string[]
  /** 发现的优化建议 */
  suggestions: OptimizationSuggestion[]
  /** 概述信息 */
  summary: string
  /** 是否发现任何优化机会 */
  hasOpportunity: boolean
}

// =============================================================================
// 回滚快照
// =============================================================================

export interface PlanOptimizerRollback {
  /** 快照 ID */
  id: string
  /** 创建时间 */
  createdAt: number
  /** 快照内容：计划 ID → 完整 DevPlan 快照 */
  snapshot: Map<string, DevPlan>
  /** 操作描述 */
  action: string
  /** 是否已回滚 */
  rolledBack: boolean
  /** 回滚时间 */
  rolledBackAt?: number
}

// =============================================================================
// 优化器配置
// =============================================================================

export interface PlanOptimizerConfig {
  /** 采集最小间隔（毫秒） */
  collectIntervalMs: number
  /** 单次最大建议数 */
  maxSuggestionsPerCycle: number
  /** 自动执行置信度阈值（高于此值且 autoExecutable=true 时可自动执行） */
  autoExecuteConfidenceThreshold: number
  /** 是否启用自动执行模式 */
  autoExecuteEnabled: boolean
  /** LLM 分析超时（毫秒） */
  llmAnalysisTimeoutMs: number
}

export const DEFAULT_PLAN_OPTIMIZER_CONFIG: PlanOptimizerConfig = {
  collectIntervalMs: 2 * 60 * 60 * 1000, // 匹配进化周期 2h
  maxSuggestionsPerCycle: 5,
  autoExecuteConfidenceThreshold: 0.85,
  autoExecuteEnabled: false, // 默认手动审批
  llmAnalysisTimeoutMs: 60000,
}
