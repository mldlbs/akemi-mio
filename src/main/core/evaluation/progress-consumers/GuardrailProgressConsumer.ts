/**
 * GuardrailProgressConsumer — 第一个实现 ProgressConsumer 的真实 Consumer
 *
 * ADR-004 Option A: Callback Parameter
 *
 * 职责：
 * - 实现 ProgressConsumer.consume(snapshot)
 * - 内部调用 GuardrailPolicy.evaluate(input) 产生 GuardrailDecision
 * - 通过 onDecision callback 将 Decision 交付给 Pipeline（不返回，不侧写）
 *
 * 约束（ADR-004 DI-1 ~ DI-3）：
 * - consume(snapshot): void — 签名完全遵守 ADR-003，不修改接口
 * - 不持有 EvaluationEmitter / EventBus / Store 引用（C-5 合规）
 * - onDecision 同步调用（保障 DI-3）
 * - callback 可选：未接入时使用 no-op，行为不变
 *
 * 依赖方向：
 *   GuardrailProgressConsumer → GuardrailPolicy (evaluate)
 *   GuardrailProgressConsumer → ProgressConsumer (implement)
 *
 * 变更记录：
 *   M4 (2026-07-09): evaluate() 改为 PolicyInput 调用；config 从 Consumer 传递。
 *   M4.3 (2026-07-09): 接受 GuardrailConfigStore 替代静态 GuardrailPolicyConfig；
 *                       consume() 每次读取 getActiveConfig()，支持运行中 Config 切换。
 *
 * 不引用：ChatExecutor, Runtime, EvaluationStore, EvaluationEmitter, EventBus
 */
import type { ProgressConsumer, ProgressSnapshot } from '../progress'
import type { GuardrailPolicy, GuardrailDecision } from '../GuardrailTypes'
import { DefaultGuardrailPolicy } from '../GuardrailPolicy'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from '../GuardrailTypes'
import type { GuardrailConfigStore } from '../GuardrailConfigStore'

export class GuardrailProgressConsumer implements ProgressConsumer {
  private policy: GuardrailPolicy
  private configStore?: GuardrailConfigStore
  private onDecision: (decision: GuardrailDecision) => void

  constructor(policy?: GuardrailPolicy, onDecision?: ((decision: GuardrailDecision) => void) | null, configStore?: GuardrailConfigStore) {
    this.policy = policy ?? new DefaultGuardrailPolicy()
    this.configStore = configStore
    this.onDecision = onDecision ?? (() => {})
  }

  async consume(snapshot: ProgressSnapshot): Promise<void> {
    const { config } = this.configStore
      ? this.configStore.getActiveConfig()
      : { config: DEFAULT_GUARDRAIL_POLICY_CONFIG }
    const decision = this.policy.evaluate({ snapshot, config })
    this.onDecision(decision)
  }
}
