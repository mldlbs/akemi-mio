/**
 * SessionGovernor 核心类型定义
 *
 * 会话级健康管理、状态迁移、恢复框架的类型系统。
 */
export type HealthLevel = 'HEALTHY' | 'NORMAL' | 'RISKY' | 'CRITICAL' | 'CORRUPTED';
export declare const HEALTH_THRESHOLDS: Record<HealthLevel, [number, number]>;
export declare function getHealthLevel(score: number): HealthLevel;
export interface HealthScoreInput {
    consecutiveFailures: number;
    toolSuccessRate: number;
    contextIntegrity: number;
    latencyFactor: number;
    guardrailTripRate: number;
    tokenBudgetUtilization: number;
}
export interface HealthScoreResult {
    score: number;
    level: HealthLevel;
    trend: 'improving' | 'declining' | 'stable';
    inputs: HealthScoreInput;
    timestamp: number;
}
export type SessionState = 'RUNNING' | 'DEGRADED' | 'RECOVERING' | 'SAFE_MODE' | 'REBUILDING' | 'FATAL';
export type RecoveryActionLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export interface StateTransition {
    from: SessionState;
    to: SessionState;
    reason: string;
    timestamp: number;
    healthScore: number;
}
export interface RecoveryAction {
    level: RecoveryActionLevel;
    name: string;
    description: string;
}
export declare const RECOVERY_ACTIONS: Record<RecoveryActionLevel, RecoveryAction>;
export interface TransitionRule {
    from: SessionState[];
    to: SessionState;
    condition: (score: number, consecutiveFailures: number) => boolean;
    reason: string;
}
export declare const TRANSITION_RULES: TransitionRule[];
export interface SessionGovEventMap {
    'session.governor.state_changed': {
        previous: SessionState;
        current: SessionState;
        reason: string;
        healthScore: number;
    };
    'session.governor.health_updated': {
        score: number;
        level: HealthLevel;
        trend: string;
        inputs: HealthScoreInput;
    };
    'session.governor.recovery.started': {
        fromState: SessionState;
        action: RecoveryAction;
        healthScore: number;
    };
    'session.governor.recovery.completed': {
        success: boolean;
        newState: SessionState;
        actionsTaken: RecoveryActionLevel[];
    };
    'session.governor.checkpoint.verified': {
        path: string;
        healthScore: number;
        passed: boolean;
        reason?: string;
    };
}
export interface SessionGovernorUIState {
    healthScore: number;
    healthLevel: HealthLevel;
    sessionState: SessionState;
    recoveryActive: boolean;
}
export interface CheckpointHealthVerification {
    passed: boolean;
    score: number;
    toolSuccessRate: number;
    contextIntegrity: number;
    hasPendingToolCalls: boolean;
    messageStructureValid: boolean;
    reason?: string;
}
