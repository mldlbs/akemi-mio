/**
 * Parameter Self-Evolution — 类型定义
 *
 * 记忆驱动的参数自进化系统全部类型。
 * 定义可分析指标、可调参数、调整提案和反馈数据点。
 */

// ═══════════════════════════════════════════════
//  可调参数分类
// ═══════════════════════════════════════════════

export type ParameterCategory =
  | 'agent' // Agent 行为（温度、回复长度等）
  | 'tts' // TTS 语音（语速、音高、音量等）
  | 'memory' // 记忆系统（衰减率、权重等）
  | 'evolution' // 进化系统（周期、阈值等）
  | 'asr' // ASR 识别（热词频次、阈值等）
  | 'tool' // 工具系统（缓存、个性化策略等）

// ═══════════════════════════════════════════════
//  可调参数定义
// ═══════════════════════════════════════════════

export interface TunableParameter {
  /** 唯一标识键 */
  key: string
  /** 人类可读名称 */
  name: string
  /** 描述此参数控制的内容 */
  description: string
  /** 当前值 */
  currentValue: number
  /** 最小值（安全边界） */
  min: number
  /** 最大值（安全边界） */
  max: number
  /** 调整步长 */
  step: number
  /** 单位（可选） */
  unit?: string
  /** 所属子系统分类 */
  category: ParameterCategory
  /** 单次调整最大变化量（防止突变） */
  maxDeltaPerAdjustment: number
}

// ═══════════════════════════════════════════════
//  反馈度量分类
// ═══════════════════════════════════════════════

export type FeedbackMetricCategory =
  | 'user_satisfaction' // 用户满意度（点赞/踩）
  | 'task_success' // 任务成功率
  | 'interruption' // 用户中断率
  | 'latency' // 响应延迟
  | 'repeat_question' // 用户重复提问率
  | 'error_frequency' // 错误/失败频率

// ═══════════════════════════════════════════════
//  时间序列反馈数据点
// ═══════════════════════════════════════════════

export interface FeedbackDataPoint {
  /** 时间戳（ms since epoch） */
  timestamp: number
  /** 指标名称 */
  metric: string
  /** 指标值 */
  value: number
  /** 指标分类 */
  category: FeedbackMetricCategory
  /** 可选上下文信息 */
  context?: string
}

// ═══════════════════════════════════════════════
//  反馈度量分析结果
// ═══════════════════════════════════════════════

export interface FeedbackMetricAnalysis {
  /** 指标名称 */
  metric: string
  /** 分类 */
  category: FeedbackMetricCategory
  /** 分析窗口大小（小时） */
  windowHours: number
  /** 当前值（最近窗口） */
  currentValue: number
  /** 前值（更早窗口，用于比较） */
  previousValue: number
  /** 趋势方向 */
  trend: 'improving' | 'degrading' | 'stable' | 'volatile'
  /** 样本数 */
  sampleCount: number
  /** 此指标是否处于令人担忧的状态 */
  isConcerning: boolean
  /** 如果令人担忧，建议的操作 */
  suggestion?: string
}

// ═══════════════════════════════════════════════
//  LLM 生成的参数调整提案
// ═══════════════════════════════════════════════

export interface ParameterAdjustmentProposal {
  /** 目标参数键 */
  parameterKey: string
  /** 建议的新值 */
  proposedValue: number
  /** 调整前的当前值 */
  currentValue: number
  /** 调整原因 */
  reason: string
  /** 对此提案的置信度 (0-1) */
  confidence: number
  /** 预期影响描述 */
  expectedImpact: string
  /** 安全检查：是否在安全范围内 */
  withinSafeBounds: boolean
  /** 子系统分类 */
  category: ParameterCategory
  /** 关联的反馈指标（哪些指标趋势触发了此提案） */
  relatedMetrics: string[]
}

// ═══════════════════════════════════════════════
//  完整分析报告
// ═══════════════════════════════════════════════

export interface ParameterSelfEvolutionReport {
  /** 报告 ID */
  id: string
  /** 创建时间戳 */
  createdAt: number
  /** 分析的反馈数据点范围 */
  feedbackWindowStart: number
  feedbackWindowEnd: number
  /** 所有度量分析 */
  metricAnalyses: FeedbackMetricAnalysis[]
  /** 详细指标摘要文本 */
  metricsSummary: string
  /** LLM 生成的调整提案 */
  proposals: ParameterAdjustmentProposal[]
  /** 总体建议摘要 */
  summary: string
  /** 是否有任何需要操作的发现 */
  hasActionableFindings: boolean
}

// ═══════════════════════════════════════════════
//  参数快照（用于回滚）
// ═══════════════════════════════════════════════

export interface ParameterSnapshot {
  /** 快照 ID */
  id: string
  /** 时间戳 */
  timestamp: number
  /** 此时间点的所有参数值 */
  values: Record<string, number>
  /** 快照原因 */
  reason: string
  /** 是否为自动应用（而非手动） */
  isAutoApplied: boolean
}

// ═══════════════════════════════════════════════
//  回滚记录
// ═══════════════════════════════════════════════

export interface RollbackRecord {
  /** 回滚 ID */
  id: string
  /** 回滚时间 */
  timestamp: number
  /** 回滚的目标快照 ID */
  snapshotId: string
  /** 回滚原因（如自动检测到指标恶化） */
  reason: string
  /** 回滚后的参数值 */
  restoredValues: Record<string, number>
}

// ═══════════════════════════════════════════════
//  EventBus 事件载荷
// ═══════════════════════════════════════════════

export interface ParameterAdjustedEvent {
  /** 调整的参数列表 */
  changes: Array<{ key: string; oldValue: number; newValue: number; reason: string }>
  /** 提案置信度 */
  confidence: number
  /** 关联的快照 ID */
  snapshotId: string
  /** 时间戳 */
  timestamp: number
}

export interface ParameterRollbackEvent {
  /** 回滚的目标快照 ID */
  snapshotId: string
  /** 回滚原因 */
  reason: string
  /** 受影响参数数量 */
  affectedParams: number
  /** 时间戳 */
  timestamp: number
}

// ═══════════════════════════════════════════════
//  持久化存储格式
// ═══════════════════════════════════════════════

export interface FeedbackStoreData {
  version: number
  updatedAt: number
  dataPoints: FeedbackDataPoint[]
}

export interface ParameterStoreData {
  version: number
  updatedAt: number
  snapshots: ParameterSnapshot[]
  rollbacks: RollbackRecord[]
}
