/**
 * asr-adapter — ASR→UserBehavior 适配器
 *
 * 将 ASR 领域成熟的数据模型和判断规则改造成 UserBehavior 可消费的输入格式。
 *
 * 使用方式（直接调用）：
 * ```ts
 * import { asrBehaviorAdapter } from './asr-adapter'
 *
 * // 在获得 ASR VoiceEmotion 后
 * const output = asrBehaviorAdapter.adapt({
 *   voiceEmotion: { label: 'calm', confidence: 0.85, ... },
 * })
 * console.log(output.contextHint) // BehaviorContextHint
 * ```
 *
 * 使用方式（UserBehaviorLayer hook）：
 * ```ts
 * import { AsrBehaviorAdapter } from './asr-adapter'
 * import { UserBehaviorLayer } from '../UserBehaviorLayer'
 *
 * const layer = new UserBehaviorLayer(evolutionService, {
 *   features: ['asr_adapter'],
 *   preHooks: [AsrBehaviorAdapter.createPreHook()],
 *   postHooks: [AsrBehaviorAdapter.createPostHook()],
 * })
 * ```
 *
 * POC 阶段特性：
 * - 默认启用 pocMode，仅输出核心映射结果
 * - 支持 VoiceEmotion → BehaviorContextHint 映射
 * - 支持 AcousticEnvironment → BehaviorContextHint 映射
 * - 支持 Confidence → QualitySignal 映射
 * - 提供 UserBehaviorLayer 兼容的 pre/post hooks
 *
 * @module asr-adapter
 */

export { AsrBehaviorAdapter, asrBehaviorAdapter } from './AsrBehaviorAdapter'
export type { AsrBehaviorAdapterConfig, AdapterState } from './AsrBehaviorTypes'
export { DEFAULT_ADAPTER_CONFIG } from './AsrBehaviorTypes'

// ── 输入类型（供消费者使用） ──
export type {
  AsrVoiceEmotionInput,
  AsrEnvironmentInput,
  AsrConfidenceInput,
  AsrDomainStatInput,
} from './AsrBehaviorTypes'

// ── 输出类型（供消费者使用） ──
export type {
  BehaviorContextHint,
  AsrQualitySignal,
  AsrBehaviorOutput,
} from './AsrBehaviorTypes'
