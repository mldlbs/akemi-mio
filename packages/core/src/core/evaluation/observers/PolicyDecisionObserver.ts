/**
 * PolicyDecisionObserver — Phase 3C.2
 *
 * 将 EventBus 上的 policy.decision 瞬时事件持久化为 EvaluationEvent。
 * 使 Activation Gate 条件（samples ≥ 100, execute ≥ 60%, skip ≤ 20%, block = 0）
 * 可通过 EvaluationStore 查询。
 *
 * 职责极薄：subscribe → transform → emit。不引入新状态。
 */
import { eventBus } from '../../EventBus'
import type { EvaluationEmitter } from '../EvaluationEmitter'

export class PolicyDecisionObserver {
  private emitter: EvaluationEmitter
  private unsub?: () => void

  constructor(emitter: EvaluationEmitter) {
    this.emitter = emitter
  }

  start(): void {
    this.unsub = eventBus.on('policy.decision', (event: any) => {
      this.emitter.emit('evolution.policy.decision', {
        type: 'evolution.policy.decision',
        mode: event.mode,
        action: event.action,
        executed: event.executed,
        source: event.source,
        problemId: event.problemId,
        policyVersion: event.policyVersion,
        reason: event.reason,
        evaluatedAt: event.timestamp,
      })
    })
  }

  stop(): void {
    this.unsub?.()
  }
}
