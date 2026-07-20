/**
 * Evolution Consumer Module — 消费者驱动契约出口
 *
 * 从消费者视角定义 Evolution 的输出格式、响应速度和容错要求。
 * 消费者只需通过 EvolutionConsumerBridge 获取上下文，
 * 不直接访问 Evolution 内部实现。
 *
 * ═══════════════════════════════════════════════════════
 * 使用示例（ReasoningChainTools 中）:
 *
 *   import { evolutionConsumerBridge } from '../evolution/consumer'
 *
 *   const ctx = evolutionConsumerBridge.getContext('plan_reasoning_chain')
 *   if (ctx?.knownIssues.length > 0) {
 *     // 将已知问题注入推理链 prompt
 *   }
 * ═══════════════════════════════════════════════════════
 */

export { EvolutionConsumerBridge, evolutionConsumerBridge } from './EvolutionConsumerBridge'
export { PLAN_CONSUMER_REQUIREMENTS, ASR_PLAN_CONSUMER_REQUIREMENTS, DEFAULT_PLAN_CONSUMERS } from './PlanConsumerContract'
export type {
  EvolutionConsumerContext,
  ConsumerId,
  ConsumerRegistration,
  ConsumerRequirements,
  ConsumerOutputFormat,
  ConsumerFaultTolerance,
  IEvolutionConsumerBridge,
  KnownIssue,
  PipelineSummary,
  SchedulerStatus,
} from './types'
