/**
 * HybridTypes — 混合流水线类型定义
 *
 * 定义 Evolution + Plan:TypeScript 双路径并行流水线的核心契约：
 *
 * 路径 A（原始路径）：PlanTypeScriptExecutor 原有流程
 * 路径 B（进化路径）：Evolution 方法论的映射应用
 *
 * 汇合点（Convergence Points）：
 * 1. step_planning      — 步骤建议生成
 * 2. difficulty         — 困难评估与分类
 * 3. strategy           — 策略调整建议
 * 4. progress_evaluation — 进度/效果评估
 */

import type { LearningDifficulty, LearningCategory } from './types'
import type { LearningStrategyType } from './LearningProgressTracker'

// =============================================================================
// 路径输出包装
// =============================================================================

/** 单一路径的输出包装，携带置信度 */
export interface HybridPathOutput<T> {
  /** 路径标识 */
  path: 'original' | 'evolution'
  /** 实际输出 */
  output: T
  /** 置信度 0–1 */
  confidence: number
  /** 额外元数据（可选）*/
  metadata?: Record<string, unknown>
}

// =============================================================================
// 汇合点输出类型
// =============================================================================

/** 步骤建议 — 每个汇合点的输出类型 */
export interface StepSuggestion {
  /** 步骤描述 */
  description: string
  /** 优先级（越小越优先）*/
  priority: number
  /** 关联的知识分类（可选）*/
  category?: LearningCategory
  /** 信心权重因子（内部使用，用于加权融合）*/
  weight?: number
}

/** 困难评估输出 */
export interface DifficultyAssessmentOutput {
  /** 知识点 ID */
  conceptId: string
  /** 知识点名称 */
  conceptName: string
  /** 困难分类 */
  category: string
  /** 频次 */
  frequency: number
  /** 困难描述 */
  description: string
}

/** 策略建议输出 */
export interface StrategySuggestion {
  /** 策略类型 */
  type: LearningStrategyType
  /** 策略描述 */
  description: string
  /** 附加参数 */
  params: Record<string, unknown>
  /** 推荐度 0–1 */
  confidence: number
}

/** 进度评估输出 */
export interface ProgressEvaluationOutput {
  /** 判定结果 */
  verdict: 'improved' | 'worsened' | 'unchanged' | 'not_found'
  /** 建议动作 */
  action: 'keep' | 'rollback' | 'no_action'
  /** 置信度 0–1 */
  confidence: number
  /** 评估依据简述 */
  rationale: string
}

// =============================================================================
// 汇合点定义
// =============================================================================

/** 汇合点名称枚举 */
export type ConvergencePointName = 'step_planning' | 'difficulty' | 'strategy' | 'progress_evaluation'

/**
 * 汇合点仲裁结果
 *
 * 记录两个路径在同一个汇合点的输出对比及仲裁结论。
 */
export interface ConvergenceResult<T> {
  /** 汇合点名称 */
  point: ConvergencePointName
  /** 原始路径输出 */
  originalOutput: HybridPathOutput<T>
  /** 进化路径输出 */
  evolutionOutput: HybridPathOutput<T>
  /** 分歧度 0–1（0=完全一致，1=完全分歧）*/
  divergenceScore: number
  /** 仲裁后采用的输出 */
  arbitratedOutput: T
  /** 仲裁方法 */
  arbitrationMethod: 'identical' | 'pick_original' | 'pick_evolution' | 'weighted_fusion'
  /** 仲裁理由 */
  rationale: string
}

// =============================================================================
// 混合流水线配置
// =============================================================================

/**
 * 混合流水线配置
 */
export interface HybridPipelineConfig {
  /** 是否启用双路径并行（默认 true）*/
  enabled: boolean
  /** 原始路径权重（0–1，融合时使用）*/
  originalPathWeight: number
  /** 进化路径权重（0–1，融合时使用）*/
  evolutionPathWeight: number
  /** 分歧阈值：超过此值才触发仲裁（默认 0.3）*/
  divergenceThreshold: number
  /** 日志详细程度 */
  verbose: boolean
}

export const DEFAULT_HYBRID_CONFIG: HybridPipelineConfig = {
  enabled: true,
  originalPathWeight: 0.6,
  evolutionPathWeight: 0.4,
  divergenceThreshold: 0.3,
  verbose: false,
}

// =============================================================================
// 混合流水线指标
// =============================================================================

/** 混合流水线运行统计数据 */
export interface HybridPipelineMetrics {
  /** 总汇合次数 */
  totalConvergences: number
  /** 各汇合点处理次数 */
  perPointCount: Record<ConvergencePointName, number>
  /** 各仲裁方法使用次数 */
  perMethodCount: Record<string, number>
  /** 平均分歧度 */
  avgDivergence: number
  /** 最近一次仲裁结果 */
  lastResult?: ConvergenceResult<unknown>
  /** 最近运行时间戳 */
  lastRunAt: number
}
