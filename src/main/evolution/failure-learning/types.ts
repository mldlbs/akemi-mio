/**
 * Failure Learning — 类型定义
 *
 * 失败学习的核心类型，覆盖：
 * - 失败记录（与数据库表对应）
 * - 改进建议（LLM 分析产出）
 * - 配置快照（回滚支持）
 * - LLM 分析结果的结构化输出
 */

// ── 失败来源类型 ──
export type FailureErrorType = 'tool' | 'llm' | 'intent' | 'timeout' | 'crash' | 'task'

// ── 改进建议类型 ──
export type SuggestionType = 'modify_system_prompt' | 'modify_tool_description' | 'modify_task_template' | 'modify_agent_config'

// ── 建议状态 ──
export type SuggestionStatus = 'pending' | 'applied' | 'rejected' | 'rollback_needed' | 'rollback_applied'

// ── LLM 分析结果（结构化输出） ──
export interface FailureAnalysisResult {
  /** 根因摘要 */
  rootCause: string
  /** 置信度 0-1 */
  confidence: number
  /** 失败分类 */
  category: 'tool_description_ambiguity' | 'task_decomposition' | 'prompt_instruction' | 'timeout_underestimation' | 'llm_capability_limit' | 'configuration_error' | 'unknown'
  /** 具体分析 */
  detail: string
  /** 改进建议列表 */
  suggestions: AnalysisSuggestion[]
}

export interface AnalysisSuggestion {
  /** 建议类型 */
  type: SuggestionType
  /** 目标名称 */
  targetName: string
  /** 当前值 */
  currentValue: string
  /** 建议的新值 */
  suggestedValue: string
  /** 变更理由 */
  rationale: string
  /** 预期收益描述 */
  expectedBenefit: string
}

// ── 失败率统计（用于回滚判定） ──
export interface FailureRateSnapshot {
  /** 周期标识 */
  cycleId: string
  /** 周期开始时间 */
  timestamp: number
  /** 该周期内失败次数 */
  failureCount: number
  /** 该周期内总执行次数 */
  totalCount: number
  /** 失败率 */
  failureRate: number
  /** 与上一周期相比的变化 */
  delta?: number
}

// ── 配置快照上下文 ──
export interface ConfigSnapshotContext {
  snapshotId: string
  snapshotType: string
  configKey: string
  oldValue: string
  newValue: string | null
  createdAt: number
  preFailureRate: number
  postFailureRate: number | null
}

// ── FailureLearningService 配置 ──
export interface FailureLearningConfig {
  /** 每次分析的最大失败记录数 */
  maxFailuresToAnalyze: number
  /** 连续失败率上升阈值（超过此值触发回滚） */
  rollbackThreshold: number
  /** 最小失败样本数（低于此值不触发分析） */
  minFailureSamples: number
  /** 建议自动应用（true）或仅报告（false） */
  autoApply: boolean
  /** 回滚自动执行（true）或仅报告（false） */
  autoRollback: boolean
  /** 是否启用此服务 */
  enabled: boolean
}

export const DEFAULT_FAILURE_LEARNING_CONFIG: FailureLearningConfig = {
  maxFailuresToAnalyze: 20,
  rollbackThreshold: 0.15,
  minFailureSamples: 3,
  autoApply: false,
  autoRollback: false,
  enabled: true,
}
