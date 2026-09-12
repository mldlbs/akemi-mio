import { log } from '@akemi-mio/core/logger/Logger'
import type { SessionState, StateTransition, RecoveryActionLevel } from './SessionGovernorTypes'
import { TRANSITION_RULES, RECOVERY_ACTIONS } from './SessionGovernorTypes'

/**
 * SessionStateMachine — 会话状态机。
 *
 * 状态迁移由健康分和连续失败次数驱动，支持审计追踪。
 */

export class SessionStateMachine {
  private _state: SessionState = 'RUNNING'
  private history: StateTransition[] = []
  private readonly maxHistory = 50

  get state(): SessionState {
    return this._state
  }

  getTransitions(): StateTransition[] {
    return [...this.history]
  }

  getLastTransition(): StateTransition | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null
  }

  /**
   * 评估是否需要状态迁移。
   */
  evaluateTransition(healthScore: number, consecutiveFailures: number): { to: SessionState; reason: string } | null {
    for (const rule of TRANSITION_RULES) {
      if (rule.from.includes(this._state) && rule.condition(healthScore, consecutiveFailures)) {
        return { to: rule.to, reason: rule.reason }
      }
    }
    return null
  }

  /**
   * 执行状态迁移。
   */
  transitionTo(to: SessionState, reason: string, healthScore: number): boolean {
    if (to === this._state) return false

    const transition: StateTransition = {
      from: this._state,
      to,
      reason,
      timestamp: Date.now(),
      healthScore,
    }

    const prev = this._state
    this._state = to
    this.history.push(transition)
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }

    log('INFO', 'session_state_transition', {
      from: prev,
      to,
      reason,
      healthScore,
      transitionIndex: this.history.length,
    })

    return true
  }

  /**
   * 根据状态推荐恢复动作等级。
   */
  getRecommendedActions(): RecoveryActionLevel[] {
    switch (this._state) {
      case 'RUNNING':
        return []
      case 'DEGRADED':
        return [1, 2]
      case 'RECOVERING':
        return [1, 2, 3, 4]
      case 'SAFE_MODE':
        return [5, 6, 7]
      case 'REBUILDING':
        return [6, 7, 8]
      case 'FATAL':
        return [8]
    }
  }

  canRecover(): boolean {
    return !['FATAL'].includes(this._state)
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      state: this._state,
      transitionsCount: this.history.length,
      lastTransition: this.getLastTransition(),
      canRecover: this.canRecover(),
      recommendedActions: this.getRecommendedActions().map((l) => RECOVERY_ACTIONS[l].name),
    }
  }

  reset(): void {
    this._state = 'RUNNING'
  }
}
