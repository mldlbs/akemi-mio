/**
 * PlanExperiment42 — 并发 Workflow 隔离性测试 类型定义
 *
 * 实验目标：验证 Plan 驱动的并发 Workflow 隔离机制
 * Phase 1: 旁路输出不做决策（当前阶段）
 * Phase 2: 作为建议源影响部分决策
 * Phase 3: 在验证可靠后替换 UserBehavior 的核心模块
 *
 * 核心能力：
 * - 监控 UserBehavior 的模式决策与 Plan/Workflow 状态
 * - 模拟 Plan-aware 决策，与真实行为对比
 * - 检测并发 Workflow 的隔离冲突
 */

import type { DevPlan } from '../../evolution/types'

// ==================== 实验阶段 ====================

/** 实验阶段 */
export type ExperimentPhase = 'passive_monitor' | 'suggestion_source' | 'core_replacement'

/** 实验阶段元数据 */
export const EXPERIMENT_PHASE_LABELS: Record<ExperimentPhase, string> = {
  passive_monitor: 'Phase 1: 旁路输出（观察+日志，不做决策）',
  suggestion_source: 'Phase 2: 建议源（影响部分决策）',
  core_replacement: 'Phase 3: 核心替换（替换 UserBehavior 决策模块）',
}

// ==================== 配置 ====================

export interface PlanExperiment42Config {
  /** 当前实验阶段 */
  phase: ExperimentPhase
  /** 观察窗口大小（保留最近 N 条观察记录） */
  observationWindowSize: number
  /** 并发隔离时间窗口 ms（之上间隔视为非并发） */
  concurrencyWindowMs: number
  /** 是否输出详细日志 */
  debug: boolean
}

export const DEFAULT_EXPERIMENT_CONFIG: PlanExperiment42Config = {
  phase: 'passive_monitor',
  observationWindowSize: 200,
  concurrencyWindowMs: 30_000,
  debug: false,
}

// ==================== 观察记录类型 ====================

/** 行为模式切换观察记录 */
export interface ModeSwitchObservation {
  /** 观察时间戳 */
  timestamp: number
  /** 实际切换：来源模式 */
  actualFromMode: string
  /** 实际切换：目标模式 */
  actualToMode: string
  /** 实际切换原因 */
  actualReason: string
  /** Plan-aware 建议的目标模式 */
  planRecommendedMode: string | null
  /** Plan-aware 建议原因 */
  planRecommendationReason: string | null
  /** 是否有活跃计划 */
  hasActivePlan: boolean
  /** 活跃计划标题 */
  activePlanTitle: string | null
  /** 是否建议不同（Plan-aware vs 实际） */
  wouldChange: boolean
  /** 差异描述 */
  difference: string
}

/** 并发 Workflow 隔离观察记录 */
export interface ConcurrencyObservation {
  /** 观察时间戳 */
  timestamp: number
  /** 并发的 Workflow/Plan 数量 */
  concurrentCount: number
  /** 正在运行的 Workflow 列表 */
  runningWorkflows: Array<{ runId: string; name?: string }>
  /** 活跃计划 */
  activePlans: Array<{ id: string; title: string }>
  /** 是否存在隔离冲突（同资源竞争） */
  hasConflict: boolean
  /** 冲突详情 */
  conflictDetail: string | null
  /** Plan-aware 建议的调度优先级 */
  suggestedPriority: string | null
  /** 建议描述 */
  suggestion: string | null
}

/** Evolution 周期观察记录 */
export interface EvolutionCycleObservation {
  /** 观察时间戳 */
  timestamp: number
  /** 周期是否成功 */
  success: boolean
  /** 执行耗时 ms */
  durationMs: number
  /** 预处理上下文摘要 */
  preContextSummary: string
  /** 后处理增强摘要 */
  postEnhancementSummary: string
  /** Plan-aware 建议的周期调整 */
  planSuggestedAdjustment: string | null
  /** 调整理由 */
  adjustmentReason: string | null
  /** 活跃计划信息 */
  activePlanInfo: {
    title: string
    stepProgress: string
  } | null
}

// ==================== 报告 ====================

/** 实验报告摘要 */
export interface ExperimentReport {
  /** 当前实验阶段 */
  phase: ExperimentPhase
  /** 总观察次数 */
  totalObservations: number
  /** 模式切换观察 */
  modeSwitches: ModeSwitchObservation[]
  /** 并发观察 */
  concurrencyEvents: ConcurrencyObservation[]
  /** Evolution 周期观察 */
  evolutionCycles: EvolutionCycleObservation[]
  /** Plan 决策覆盖率（Plan-aware 建议产生差异的比例） */
  planOverrideRate: number
  /** 并发冲突率 */
  conflictRate: number
  /** 采集时段（最早-最晚时间戳） */
  collectionWindow: { from: number; to: number }
  /** 报告生成时间 */
  generatedAt: number
  /** 简单总结 */
  summary: string
}
