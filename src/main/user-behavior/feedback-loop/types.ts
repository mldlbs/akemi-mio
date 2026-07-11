/**
 * MCP ↔ UserBehavior 强化回路 — 类型定义
 *
 * @description
 * 定义反馈回路所需的所有类型：工具质量快照、参数调整指令、
 * 收敛度指标、阻尼状态等。
 *
 * @integration
 * - MCPFeedbackLoopService 使用此文件中的所有类型
 * - EventBus 事件 payload 引用其中部分类型
 */

// ══════════════════════════════════════════
//  工具质量快照
// ══════════════════════════════════════════

/** 单次工具执行的质量评价 */
export interface ToolExecutionQuality {
  /** 工具名 */
  toolName: string
  /** 是否执行成功 */
  success: boolean
  /** 耗时 (ms) */
  latencyMs: number
  /** 输出内容长度（字符数，作为输出丰富度的代理指标） */
  outputLength: number
  /** 错误信息（失败时） */
  error?: string
  /** 时间戳 */
  timestamp: number
  /** 是否来自预加载缓存 */
  fromCache: boolean
}

/** 工具在分析窗口内的聚合质量指标 */
export interface ToolQualitySnapshot {
  /** 工具名 */
  toolName: string
  /** 窗口内总调用次数 */
  totalCalls: number
  /** 成功次数 */
  successCount: number
  /** 失败次数 */
  failureCount: number
  /** 成功率 (0-1) */
  successRate: number
  /** 平均延迟 (ms) */
  avgLatency: number
  /** 中位延迟 (ms) */
  medianLatency: number
  /** P95 延迟 (ms) */
  p95Latency: number
  /** 延迟标准差 */
  latencyStdDev: number
  /** 平均输出长度 */
  avgOutputLength: number
  /** 缓存命中次数 */
  cacheHitCount: number
  /** 趋势方向: improving / stable / degrading */
  trend: 'improving' | 'stable' | 'degrading'
  /** 时间戳 */
  timestamp: number
}

// ══════════════════════════════════════════
//  参数调整
// ══════════════════════════════════════════

/** 可调整的 UserBehavior 参数 */
export interface BehaviorParameterSet {
  /** UserBehaviorAnalyzer 分析窗口大小 */
  analysisWindow: number
  /** 高频工具判定阈值（最少出现次数） */
  highFreqToolThreshold: number
  /** BehaviorPredictor 预加载置信度阈值 */
  preloadConfidenceThreshold: number
  /** BehaviorPredictor 模式频率缩放因子 */
  confidenceFreqScale: number
  /** BehaviorPredictor 近因缩放因子 */
  confidenceRecencyScale: number
  /** BehaviorPredictor 序列长度缩放因子 */
  confidenceLengthScale: number
  /** BehaviorFeatureExtractor 停顿判定阈值 (ms) */
  pauseThresholdMs: number
  /** BehaviorFeatureExtractor 最小序列频率 */
  minSequenceFrequency: number
}

/** 参数调整类型标签 */
export type ParameterAdjustmentType =
  | 'window_size'
  | 'frequency_threshold'
  | 'confidence_threshold'
  | 'pause_threshold'
  | 'sequence_frequency'
  | 'confidence_weights'

/** 单次参数调整记录 */
export interface ParameterAdjustment {
  /** 调整类型 */
  type: ParameterAdjustmentType
  /** 调整前的值 */
  previousValue: number
  /** 调整后的值（经阻尼） */
  newValue: number
  /** 调整的原始目标值（未阻尼） */
  targetValue: number
  /** 本次应用的阻尼因子 (0-1) */
  dampingFactorUsed: number
  /** 调整理由 */
  reason: string
  /** 时间戳 */
  timestamp: number
}

// ══════════════════════════════════════════
//  阻尼机制
// ══════════════════════════════════════════

/** 阻尼状态 */
export interface DampingState {
  /** 当前阻尼因子 (0-1)，越接近 1 变化越激进 */
  currentFactor: number
  /** 初始阻尼因子 */
  initialFactor: number
  /** 最小阻尼因子（达到后不再降低） */
  minFactor: number
  /** 阻尼衰减率：每次调整后 factor *= decayRate */
  decayRate: number
  /** 自上次调整以来的观察次数 */
  observationsSinceLastAdjust: number
  /** 收敛计数（连续小幅度调整的次数） */
  convergenceCount: number
}

// ══════════════════════════════════════════
//  收敛监测
// ══════════════════════════════════════════

/** 收敛状态 */
export type ConvergenceState = 'diverging' | 'exploring' | 'converging' | 'converged'

/** 收敛度指标 */
export interface ConvergenceMetrics {
  /** 当前收敛状态 */
  state: ConvergenceState
  /** 最近 N 次调整幅度的滑动平均值 */
  recentAdjustmentMagnitude: number
  /** 调整幅度的标准差 */
  adjustmentStdDev: number
  /** 收敛稳定所需的最小连续观察次数 */
  requiredStableObservations: number
  /** 当前已连续稳定的观察次数 */
  stableObservationCount: number
  /** 调整幅度阈值（低于此值视为稳定） */
  stabilityThreshold: number
  /** 发散检测：如果调整幅度超过此值视为发散 */
  divergenceThreshold: number
  /** 是否已达到收敛 */
  hasConverged: boolean
  /** 最后更新时间 */
  lastUpdated: number
}

// ══════════════════════════════════════════
//  回路状态
// ══════════════════════════════════════════

/** 回路运行模式 */
export type FeedbackLoopMode = 'monitor' | 'auto'

/** 回路状态快照（用于日志和监控） */
export interface FeedbackLoopState {
  /** 运行模式 */
  mode: FeedbackLoopMode
  /** 当前阻尼状态 */
  damping: DampingState
  /** 当前收敛指标 */
  convergence: ConvergenceMetrics
  /** 收集到的工具总数 */
  totalToolObservations: number
  /** 已执行的调整次数 */
  totalAdjustments: number
  /** 当前生效的参数集 */
  currentParameters: BehaviorParameterSet
  /** 最近一次调整记录（如有） */
  lastAdjustment: ParameterAdjustment | null
  /** 回路启动时间 */
  startedAt: number
  /** 状态更新时间 */
  updatedAt: number
}

// ══════════════════════════════════════════
//  事件 payload
// ══════════════════════════════════════════

/** 回路状态变更事件 payload */
export interface FeedbackLoopStateChangePayload {
  mode: FeedbackLoopMode
  convergenceState: ConvergenceState
  totalAdjustments: number
  totalObservations: number
  dampingFactor: number
}

/** 参数调整事件 payload */
export interface ParameterAdjustmentPayload {
  type: ParameterAdjustmentType
  previousValue: number
  newValue: number
  dampingFactor: number
  reason: string
}

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

/** 默认阻尼配置 */
export const DEFAULT_DAMPING_CONFIG = {
  /** 初始阻尼因子：每次调整最多变化 30% */
  INITIAL_FACTOR: 0.3,
  /** 最小阻尼因子 */
  MIN_FACTOR: 0.05,
  /** 衰减率：每次调整后 factor *= 0.85 */
  DECAY_RATE: 0.85,
  /** 每次调整前的最小观察次数 */
  MIN_OBSERVATIONS_BEFORE_ADJUST: 20,
} as const

/** 默认收敛检测配置 */
export const DEFAULT_CONVERGENCE_CONFIG = {
  /** 所需稳定观察次数 */
  REQUIRED_STABLE: 5,
  /** 稳定阈值：调整幅度绝对值低于此值视为稳定 */
  STABILITY_THRESHOLD: 0.1,
  /** 发散阈值：调整幅度超过此值视为发散 */
  DIVERGENCE_THRESHOLD: 2.0,
  /** 参数调整评估周期（收集到多少条工具记录后评估一次） */
  EVALUATION_INTERVAL: 15,
} as const

/** 默认参数集（与现有模块级常量保持一致） */
export const DEFAULT_PARAMETERS: BehaviorParameterSet = {
  analysisWindow: 16,
  highFreqToolThreshold: 3,
  preloadConfidenceThreshold: 0.35,
  confidenceFreqScale: 0.4,
  confidenceRecencyScale: 0.3,
  confidenceLengthScale: 0.3,
  pauseThresholdMs: 3000,
  minSequenceFrequency: 2,
} as const

/** 参数取值范围约束 */
export const PARAMETER_BOUNDS: Record<keyof BehaviorParameterSet, { min: number; max: number }> = {
  analysisWindow: { min: 4, max: 64 },
  highFreqToolThreshold: { min: 1, max: 10 },
  preloadConfidenceThreshold: { min: 0.1, max: 0.9 },
  confidenceFreqScale: { min: 0.1, max: 0.9 },
  confidenceRecencyScale: { min: 0.1, max: 0.9 },
  confidenceLengthScale: { min: 0.1, max: 0.9 },
  pauseThresholdMs: { min: 500, max: 15000 },
  minSequenceFrequency: { min: 1, max: 10 },
}
