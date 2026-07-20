/**
 * PlanConsumerContract — Plan/ReasoningChain 消费者契约
 *
 * 从 "推理链" 系统（create_reasoning_chain tool）的视角，
 * 定义 Evolution 必须提供的输出格式、响应速度和容错保证。
 *
 * ── 设计原则 ──
 * 1. 消费者定义需求，Evolution 满足需求
 * 2. 不要求 Evolution 的内部实现细节
 * 3. 明确声明可降级场景和降级策略
 * 4. 保证消费者在 Evolution 不可用时仍能正常工作
 *
 * ── 消费场景 ──
 * create_reasoning_chain 工具在创建推理链时需要:
 * - 当前已知问题列表（影响推理链的优先级和步骤设计）
 * - 管道指标摘要（了解当前系统健康度）
 * - 调度器状态（了解 Evolution 是否在运行）
 *
 * ── SLA 指标 ──
 * - 响应时间: ≤5000ms（推理链创建是异步任务，可容忍中等延迟）
 * - 可用性: Evolution 不可用不阻塞推理链创建
 * - 新鲜度: 上下文在 30min 内视为有效
 * - 数据量: ≤2000 字符
 */

import type { ConsumerRequirements } from './types'

/**
 * Plan/ReasoningChain 消费者对 Evolution 的需求规格。
 *
 * 当 create_reasoning_chain tool 被调用时，Evolution 应以本契约
 * 定义的格式提供上下文。如果 Evolution 不满足本契约，
 * 推理链系统仍可正常工作（降级模式），但推理质量可能下降。
 */
export const PLAN_CONSUMER_REQUIREMENTS: ConsumerRequirements = {
  consumerId: 'plan_reasoning_chain',

  outputFormat: {
    // 推理链创建必需字段
    requiredFields: [
      'knownIssues',           // 已知问题列表 → 影响任务分解的细致度
      'scheduler.state',       // 调度器状态 → 判断是否应等待 Evolution
      'pipeline.healthStatus', // 管道健康度 → 影响推理链的验证标准设置
    ],

    // 增强推理质量的附加字段
    optionalFields: [
      'pipeline.totalCollected',  // 总采集数 → 了解系统问题密度
      'pipeline.totalFixed',      // 已修复数 → 了解 Evolution 活跃度
      'knownIssues[].severity',   // 严重度 → 影响优先级决策
      'knownIssues[].source',     // 来源 → 关联特定子系统
    ],

    // 推理链创建上下文上限 2000 字符
    maxLength: 2000,
  },

  // 推理链创建是异步任务，可接受 ≤5s 的 Evolution 上下文获取
  responseTimeSlaMs: 5000,

  faultTolerance: {
    // 完全允许 Evolution 不可用 → 推理链仍可独立创建
    allowUnavailable: true,

    // 降级时返回空上下文，不使用过期缓存
    fallbackStrategy: 'return_empty',

    // 上下文超过 30 分钟视为过期，需降级
    maxStalenessMs: 30 * 60 * 1000,
  },
}

/**
 * ASR 推理链执行器的 Evolution 需求规格。
 *
 * AsrReasoningChainExecutor 在使用 Plan 执行 ASR 优化时，
 * 需要了解 Evolution 的 ASR 相关管道状态。
 */
export const ASR_PLAN_CONSUMER_REQUIREMENTS: ConsumerRequirements = {
  consumerId: 'plan_asr',

  outputFormat: {
    requiredFields: [
      'pipeline.healthStatus',
      'bySource.log',
    ],
    optionalFields: [
      'knownIssues[].source',
    ],
    maxLength: 1000,
  },

  responseTimeSlaMs: 3000,

  faultTolerance: {
    allowUnavailable: true,
    fallbackStrategy: 'return_empty',
    maxStalenessMs: 15 * 60 * 1000, // ASR 上下文需要更短的新鲜度
  },
}

/**
 * 所有 Plan 相关消费者的契约列表。
 * EvolutionConsumerBridge 使用此列表注册默认消费者。
 */
export const DEFAULT_PLAN_CONSUMERS: ConsumerRequirements[] = [
  PLAN_CONSUMER_REQUIREMENTS,
  ASR_PLAN_CONSUMER_REQUIREMENTS,
]
