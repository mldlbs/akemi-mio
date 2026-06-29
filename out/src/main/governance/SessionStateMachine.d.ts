import type { SessionState, StateTransition, RecoveryActionLevel } from './SessionGovernorTypes';
/**
 * SessionStateMachine — 会话状态机。
 *
 * 状态迁移由健康分和连续失败次数驱动，支持审计追踪。
 */
export declare class SessionStateMachine {
    private _state;
    private history;
    private readonly maxHistory;
    get state(): SessionState;
    getTransitions(): StateTransition[];
    getLastTransition(): StateTransition | null;
    /**
     * 评估是否需要状态迁移。
     */
    evaluateTransition(healthScore: number, consecutiveFailures: number): {
        to: SessionState;
        reason: string;
    } | null;
    /**
     * 执行状态迁移。
     */
    transitionTo(to: SessionState, reason: string, healthScore: number): boolean;
    /**
     * 根据状态推荐恢复动作等级。
     */
    getRecommendedActions(): RecoveryActionLevel[];
    canRecover(): boolean;
    getDiagnostics(): Record<string, unknown>;
    reset(): void;
}
