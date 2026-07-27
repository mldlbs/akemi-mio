/**
 * Evolution Feedback Loop — 类型定义
 *
 * 自进化行为反馈闭环的核心类型：
 * - EvolutionPlanRecord: 进化计划对模块的修改记录
 * - UserRejectionSignal: 用户拒绝信号（撤销、重试、回滚）
 * - ModuleFeedbackState: 模块级别的反馈累积状态
 */

// =============================================================================
// 进化计划修改记录
// =============================================================================

/** 单次进化计划中涉及的一个模块修改 */
export interface EvolutionModuleChange {
  /** 模块名称（如 'tool', 'tts', 'asr', 'memory' 或具体文件路径标识） */
  moduleName: string
  /** 修改的文件路径列表 */
  affectedFiles: string[]
  /** 修改类型 */
  changeType: 'modify' | 'refactor' | 'optimize' | 'fix' | 'add_feature'
  /** 修改时间戳 */
  timestamp: number
}

/** 一次完整的进化计划执行记录 */
export interface EvolutionPlanRecord {
  /** 计划执行 ID */
  planRunId: string
  /** 计划标题 */
  planTitle: string
  /** 涉及的所有模块修改 */
  moduleChanges: EvolutionModuleChange[]
  /** 计划创建时间 */
  createdAt: number
  /** 计划完成时间 */
  completedAt: number
  /** 计划是否成功 */
  success: boolean
}

// =============================================================================
// 用户拒绝信号
// =============================================================================

/** 用户拒绝信号的类型 */
export type RejectionSignalType =
  | 'git_revert'        // Git 回滚操作
  | 'tool_retry'        // 工具调用重试（失败后立刻重试）
  | 'error_spike'       // 错误率飙升
  | 'undo_operation'    // 用户显式撤销
  | 'repeated_fix'      // 同一问题反复被采集（用户未接受修复）

/** 单个用户拒绝信号 */
export interface RejectionSignal {
  /** 信号类型 */
  type: RejectionSignalType
  /** 关联的模块名 */
  moduleName: string
  /** 信号强度（0~1），越强表示越明确的拒绝 */
  strength: number
  /** 关联的文件路径 */
  affectedFiles: string[]
  /** 信号产生时间 */
  timestamp: number
  /** 信号描述 */
  description: string
  /** 关联的进化计划执行 ID（如果可追溯） */
  relatedPlanRunId?: string
}

// =============================================================================
// 模块反馈累积状态
// =============================================================================

/** 模块反馈累积状态的持久化格式 */
export interface ModuleFeedbackState {
  /** 模块名 */
  moduleName: string
  /** 累积负反馈计数 */
  negativeFeedbackCount: number
  /** 累积正反馈计数 */
  positiveFeedbackCount: number
  /** 最近一次反馈时间戳 */
  lastFeedbackAt: number
  /** 拒绝率 (0~1)：negative / (negative + positive) */
  rejectionRate: number
  /** 当前模块修改优先级系数 (0~1.5) */
  modificationPriority: number
  /** 当前模块回归测试优先级系数 (0~2) */
  regressionTestPriority: number
  /** 反馈时间线（最近 N 条） */
  recentSignals: Array<{
    type: RejectionSignalType
    strength: number
    timestamp: number
  }>
}

/** 完整反馈状态持久化格式 */
export interface FeedbackStore {
  version: number
  updatedAt: number
  modules: Record<string, ModuleFeedbackState>
  /** 最近 N 条进化计划记录，用于关联分析 */
  recentPlanRecords: EvolutionPlanRecord[]
}

// =============================================================================
// 事件载荷
// =============================================================================

/** EventBus: 进化反馈信号产生事件 */
export interface EvolutionFeedbackSignalEvent {
  moduleName: string
  signalType: RejectionSignalType
  strength: number
  description: string
  timestamp: number
}

/** EventBus: 模块权重调整事件 */
export interface ModuleWeightAdjustedEvent {
  moduleName: string
  oldModPriority: number
  newModPriority: number
  oldRegressionPriority: number
  newRegressionPriority: number
  reason: string
}
