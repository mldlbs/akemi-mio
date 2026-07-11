/**
 * Evolution × PiperTTS 深度融合 — 共享类型
 *
 * 定义 Evolution 和 PiperTTS 之间双向数据流的结构化契约。
 * 桥接器（EvolutionPiperBridge）通过此类型系统保证两端的解耦通信。
 */

// ════════════════════════════════════════════
//  方向一：Evolution → PiperTTS
// ════════════════════════════════════════════

/** Evolution 当前调度状态 — PiperTTS 可据此调整行为 */
export type EvolutionSchedulerExposure = 'idle' | 'analyzing' | 'cooldown'

/** Evolution 安全模式 — PiperTTS 可据此选择保守/激进行为 */
export type EvolutionSafetyExposure = 'review' | 'auto'

/**
 * Evolution 暴露给 PiperTTS 的状态快照。
 *
 * 由 SelfEvolutionService 在状态变更时通过桥接器同步，
 * PiperOrchestrator 读取后调整模型选择、语速、队列行为等。
 */
export interface EvolutionToPiperState {
  /** Evolution 调度状态 */
  schedulerState: EvolutionSchedulerExposure

  /** 安全模式 */
  safetyMode: EvolutionSafetyExposure

  /** 连续执行失败次数 */
  executeFailures: number

  /** 是否处于冷却恢复期 */
  inCooldown: boolean

  /** 冷却剩余毫秒（仅 inCooldown=true 时有意义） */
  cooldownRemainingMs: number

  /** 用户是否活跃 */
  userActive: boolean

  /** 最近一次 Evolution 运行的时间戳 */
  lastRunAt: number

  /** 管道中待处理的问题数 */
  pipelineQueueSize: number

  /** 状态快照生成时间 */
  timestamp: number
}

// ════════════════════════════════════════════
//  方向二：PiperTTS → Evolution
// ════════════════════════════════════════════

/** Piper 单模型的性能快照 — Evolution 的输入维度 */
export interface PiperModelPerformanceSnapshot {
  /** 模型名 */
  model: string
  /** 总合成次数 */
  totalSyntheses: number
  /** 成功次数 */
  successCount: number
  /** 失败次数 */
  failureCount: number
  /** 平均延迟（毫秒） */
  avgLatencyMs: number
  /** 回退次数 */
  fallbackCount: number
  /** 最近 10 次成功率（0~1），-1 表示不足 10 次样本 */
  recentSuccessRate: number
}

/**
 * PiperTTS 反馈给 Evolution 的性能数据。
 *
 * 由桥接器定期从 PiperOrchestrator / TtsPiperBridge 采集，
 * Evolution 管道据此生成优化问题。
 */
export interface PiperToEvolutionFeedback {
  /** 各模型的性能快照 */
  models: PiperModelPerformanceSnapshot[]

  /** 当前队列深度 */
  queueDepth: number

  /** 队列是否正在处理 */
  isProcessing: boolean

  /** 当前活跃模型 */
  currentModel: string

  /** 是否有任意模型近期失败率过高 */
  anyModelFailed: boolean

  /** 最近 10 次合成的平均延迟（毫秒），-1 表示无数据 */
  recentAvgLatencyMs: number

  /** 累计合成请求总数 */
  totalRequests: number

  /** 累计合成成功数 */
  totalSuccess: number

  /** 累计合成失败数 */
  totalFailure: number

  /** 反馈生成时间 */
  timestamp: number
}

// ════════════════════════════════════════════
//  共享上下文 — 双向数据载体
// ════════════════════════════════════════════

/**
 * Evolution × PiperTTS 共享上下文。
 *
 * 这是双向数据流的单次快照载体：
 * - evolutionState: 方向 TTS→Piper，SelfEvolutionService 写入
 * - piperFeedback:  方向 Piper→TTS，PiperOrchestrator 写入
 */
export interface EvolutionPiperSharedContext {
  /** Evolution → Piper 的状态 */
  evolutionState: EvolutionToPiperState | null

  /** Piper → Evolution 的反馈 */
  piperFeedback: PiperToEvolutionFeedback | null

  /** 上下文版本（每次更新递增） */
  version: number
}

// ════════════════════════════════════════════
//  桥接器配置
// ════════════════════════════════════════════

export interface EvolutionPiperBridgeConfig {
  /** 反馈采集最小间隔（毫秒），防止高频轮询 */
  feedbackMinIntervalMs: number

  /** Evolution 状态最小同步间隔（毫秒） */
  stateSyncMinIntervalMs: number

  /** 是否启用 Piper → Evolution 自动问题生成 */
  autoProblemGeneration: boolean

  /** Piper 模型失败率超过此阈值时生成 Evolution 问题 */
  modelFailureThreshold: number

  /** Piper 平均延迟超过此阈值（毫秒）时生成 Evolution 问题 */
  latencyThresholdMs: number

  /** Piper 队列深度超过此阈值时生成 Evolution 问题 */
  queueDepthThreshold: number
}

export const DEFAULT_EVOLUTION_PIPER_BRIDGE_CONFIG: EvolutionPiperBridgeConfig = {
  feedbackMinIntervalMs: 60_000,
  stateSyncMinIntervalMs: 10_000,
  autoProblemGeneration: true,
  modelFailureThreshold: 0.3,
  latencyThresholdMs: 5000,
  queueDepthThreshold: 10,
}

// ════════════════════════════════════════════
//  Piper 性能问题类型 — 供 EvolutionPlugin 使用
// ════════════════════════════════════════════

export type PiperProblemCategory =
  | 'model_failure_rate'
  | 'high_latency'
  | 'queue_overload'
  | 'fallback_chain'
  | 'model_unavailable'
  | 'degradation'

/** EvolutionPlugin 报告的 Piper 问题描述 */
export interface PiperProblemDescriptor {
  category: PiperProblemCategory
  model?: string
  currentValue: number
  threshold: number
  detail: string
}
