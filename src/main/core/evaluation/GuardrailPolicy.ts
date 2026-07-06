/**
 * GuardrailPolicy — 基于 ProgressSnapshot 做出决策的纯函数
 *
 * 职责：
 * - 接收 ProgressSnapshot，返回 GuardrailDecision
 * - 无内部状态（stateless），阈值通过构造函数配置
 * - 决策逻辑：任意 signal stalled → terminate；任意 signal degrading → warning；其余 → continue
 *
 * 不依赖 EventBus / Runtime / 存储。
 */

import type { GuardrailPolicy, GuardrailDecision, GuardrailPolicyConfig, SignalState, ProgressSnapshot } from './GuardrailTypes'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from './GuardrailTypes'

export class DefaultGuardrailPolicy implements GuardrailPolicy {
  private config: GuardrailPolicyConfig

  constructor(config?: Partial<GuardrailPolicyConfig>) {
    this.config = {
      stateChange: { ...DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange, ...config?.stateChange },
      informationGain: { ...DEFAULT_GUARDRAIL_POLICY_CONFIG.informationGain, ...config?.informationGain },
      goalProgress: { ...DEFAULT_GUARDRAIL_POLICY_CONFIG.goalProgress, ...config?.goalProgress },
    }
  }

  evaluate(snapshot: ProgressSnapshot): GuardrailDecision {
    const signals: SignalState[] = [
      this.evaluateStateChange(snapshot),
      this.evaluateInformationGain(snapshot),
      this.evaluateGoalProgress(snapshot),
    ]

    const stalled = signals.filter((s) => s.status === 'stalled')
    const degrading = signals.filter((s) => s.status === 'degrading')

    let action: GuardrailDecision['action']
    let reason: string

    if (stalled.length > 0) {
      action = 'terminate'
      reason = `Signal stalled: ${stalled.map((s) => s.name).join(', ')} — ${stalled.map((s) => s.detail).join('; ')}`
    } else if (degrading.length > 0) {
      action = 'warning'
      reason = `Signal degrading: ${degrading.map((s) => s.name).join(', ')} — ${degrading.map((s) => s.detail).join('; ')}`
    } else {
      action = 'continue'
      reason = 'All signals healthy'
    }

    return { action, reason, decidedAt: Date.now(), traceId: snapshot.traceId, signals, snapshot }
  }

  private evaluateStateChange(snapshot: ProgressSnapshot): SignalState {
    const cfg = this.config.stateChange
    const sc = snapshot.stateChange

    if (sc.stagnantTurnCount >= cfg.stalled) {
      return { name: 'state_change', status: 'stalled', detail: `已停滞 ${sc.stagnantTurnCount} 轮（阈值: ${cfg.stalled}）` }
    }
    if (sc.stagnantTurnCount >= cfg.degrading) {
      return { name: 'state_change', status: 'degrading', detail: `已停滞 ${sc.stagnantTurnCount} 轮（阈值: ${cfg.degrading}）` }
    }
    return { name: 'state_change', status: 'healthy', detail: '最近轮次有状态变化' }
  }

  private evaluateInformationGain(snapshot: ProgressSnapshot): SignalState {
    const cfg = this.config.informationGain
    const ig = snapshot.informationGain

    if (ig.consecutiveLowOutputTurns >= cfg.lowOutputStalled) {
      return {
        name: 'information_gain',
        status: 'stalled',
        detail: `连续 ${ig.consecutiveLowOutputTurns} 轮低输出（阈值: ${cfg.lowOutputStalled}）`,
      }
    }
    if (ig.repeatedOutputCount >= cfg.repeatedContentStalled) {
      return {
        name: 'information_gain',
        status: 'stalled',
        detail: `连续 ${ig.repeatedOutputCount} 轮重复内容（阈值: ${cfg.repeatedContentStalled}）`,
      }
    }
    if (ig.consecutiveLowOutputTurns >= cfg.lowOutputDegrading) {
      return {
        name: 'information_gain',
        status: 'degrading',
        detail: `连续 ${ig.consecutiveLowOutputTurns} 轮低输出（阈值: ${cfg.lowOutputDegrading}）`,
      }
    }
    if (ig.repeatedOutputCount >= cfg.repeatedContentDegrading) {
      return {
        name: 'information_gain',
        status: 'degrading',
        detail: `连续 ${ig.repeatedOutputCount} 轮重复内容（阈值: ${cfg.repeatedContentDegrading}）`,
      }
    }
    return { name: 'information_gain', status: 'healthy', detail: '信息增益正常' }
  }

  private evaluateGoalProgress(snapshot: ProgressSnapshot): SignalState {
    const cfg = this.config.goalProgress
    const gp = snapshot.goalProgress

    if (gp.stagnantTurnCount >= cfg.stalled) {
      return { name: 'goal_progress', status: 'stalled', detail: `连续 ${gp.stagnantTurnCount} 轮无推进（阈值: ${cfg.stalled}）` }
    }
    if (gp.stagnantTurnCount >= cfg.degrading) {
      return { name: 'goal_progress', status: 'degrading', detail: `连续 ${gp.stagnantTurnCount} 轮无推进（阈值: ${cfg.degrading}）` }
    }
    return { name: 'goal_progress', status: 'healthy', detail: `已完成 ${gp.completedSubtasks} 个子任务` }
  }
}
