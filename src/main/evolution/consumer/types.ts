/**
 * Evolution Consumer Contract — 消费者契约类型定义
 *
 * 不再从 Evolution 内部视角定义"它能提供什么"，
 * 而是从消费者视角定义"消费者需要 Evolution 以什么形态存在"。
 *
 * 每个消费者声明自己的输出格式要求、响应速度 SLA 和容错需求，
 * Evolution 根据这些契约反向重构自己的输出。
 *
 * ── 核心思想 ──
 * 1. 消费者（如 Plan/ReasoningChain）定义自己需要什么
 * 2. 契约包含：输出字段、数据量上限、响应时间、容错策略
 * 3. Evolution 根据契约裁剪/格式化自己的输出
 * 4. 消费者无需了解 Evolution 内部实现
 *
 * ── 当前已注册消费者 ──
 * - plan_reasoning_chain: create_reasoning_chain tool
 * - plan_asr: AsrReasoningChainExecutor
 */

import type { ProblemSource } from '../automation/types'

// =============================================================================
// 消费者标识
// =============================================================================

/** 消费者类型注册标识 */
export type ConsumerId =
  | 'plan_reasoning_chain'
  | 'plan_asr'
  | 'plan_blog'
  | 'plan_generic'
  | (string & {})

// =============================================================================
// 消费者视角的 Evolution 上下文
// =============================================================================

/**
 * Evolution 向消费者暴露的上下文。
 * 只包含消费者需要的字段，不暴露 Evolution 内部实现细节。
 *
 * 消费者通过此接口读取 Evolution 状态，不直接访问
 * SelfEvolutionService / PipelineOrchestrator 的内部对象。
 */
export interface EvolutionConsumerContext {
  /** 管道指标摘要（仅消费者要求的字段） */
  pipeline: PipelineSummary | null

  /** 当前已知问题列表（按严重度排序） */
  knownIssues: KnownIssue[]

  /** 调度器状态摘要 */
  scheduler: SchedulerStatus

  /** 按来源分类的问题计数 */
  bySource?: Record<ProblemSource, { collected: number; fixed: number; failed: number }>

  /** 上下文生成时间戳（消费者可用此判断新鲜度） */
  timestamp: number
}

/** 管道指标摘要（精简版，仅暴露消费者需要的字段） */
export interface PipelineSummary {
  totalCollected: number
  totalFixed: number
  totalFailed: number
  queueSize: number
  healthStatus: 'good' | 'degraded' | 'stalled'
}

/** 已知问题摘要 */
export interface KnownIssue {
  source: ProblemSource
  severity: 'error' | 'warning' | 'info'
  title: string
  /** 问题出现次数 */
  occurrenceCount: number
  /** 最近一次出现时间 */
  lastSeen: number
  /** 关联文件（如有） */
  file?: string
}

/** 调度器状态（消费者视角，精简） */
export interface SchedulerStatus {
  state: 'idle' | 'analyzing' | 'cooling_down'
  lastRun: number | null
  consecutiveFailures: number
  isHealthy: boolean
}

// =============================================================================
// 消费者需求规格
// =============================================================================

/**
 * 消费者对 Evolution 的需求规格声明。
 *
 * 每个消费者类型在注册时声明自己的需求，
 * Evolution 根据这些规格裁剪输出。
 */
export interface ConsumerRequirements {
  /** 消费者标识 */
  consumerId: ConsumerId

  /** 需要的输出格式规格 */
  outputFormat: ConsumerOutputFormat

  /** 响应速度 SLA（毫秒） */
  responseTimeSlaMs: number

  /** 容错要求 */
  faultTolerance: ConsumerFaultTolerance
}

/** Evolution 对消费者的输出格式定义 */
export interface ConsumerOutputFormat {
  /** 必须提供的数据字段路径列表（如 "pipeline.totalCollected"） */
  requiredFields: string[]

  /** 可选提供的数据字段路径列表 */
  optionalFields?: string[]

  /** 最大上下文长度（字符数），超过此值的上下文将被裁剪 */
  maxLength?: number
}

/** 容错要求 */
export interface ConsumerFaultTolerance {
  /** 是否允许 Evolution 不可用（消费者仍能正常工作） */
  allowUnavailable: boolean

  /** 不可用或超时的降级策略 */
  fallbackStrategy: 'use_last_known' | 'return_default' | 'return_empty'

  /** 最大可接受的上下文过时时间（毫秒）。
   *  超过此时间的上下文视为过期，应使用降级策略。 */
  maxStalenessMs: number
}

// =============================================================================
// 消费者注册入口
// =============================================================================

/**
 * 已注册的消费者及其需求规格。
 * EvolutionConsumerBridge 根据此表为每个消费者生成定制化输出。
 */
export interface ConsumerRegistration {
  requirements: ConsumerRequirements

  /** 最后一次成功提供给此消费者的上下文快照（用于降级回退） */
  lastKnownContext: EvolutionConsumerContext | null

  /** 上次更新时间 */
  lastUpdatedAt: number
}

// =============================================================================
// 桥接器接口（供 Evolution 消费方使用）
// =============================================================================

/**
 * Evolution 消费者桥接器接口。
 *
 * 消费者无需 import SelfEvolutionService 或 PipelineOrchestrator，
 * 只需通过此接口获取 Evolution 上下文。
 */
export interface IEvolutionConsumerBridge {
  /** 为指定消费者获取 Evolution 上下文（自动应用契约约束） */
  getContext(consumerId: ConsumerId): EvolutionConsumerContext | null

  /** 获取当前消费者契约注册信息 */
  getRegistration(consumerId: ConsumerId): ConsumerRegistration | null

  /** 获取指定消费者的需求规格 */
  getRequirements(consumerId: ConsumerId): ConsumerRequirements | null

  /** 检查指定消费者的上下文是否新鲜（在 maxStalenessMs 内） */
  isFresh(consumerId: ConsumerId): boolean

  /** 手动刷新上下文（由 Evolution 周期完成时调用） */
  refresh(): void

  /** 注册新消费者 */
  registerConsumer(requirements: ConsumerRequirements): void
}
