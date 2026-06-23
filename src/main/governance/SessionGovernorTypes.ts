/**
 * SessionGovernor 核心类型定义
 *
 * 会话级健康管理、状态迁移、恢复框架的类型系统。
 */

// =============================================================================
// 健康评分
// =============================================================================

export type HealthLevel = 'HEALTHY' | 'NORMAL' | 'RISKY' | 'CRITICAL' | 'CORRUPTED'

export const HEALTH_THRESHOLDS: Record<HealthLevel, [number, number]> = {
  HEALTHY: [95, 100],
  NORMAL: [70, 95],
  RISKY: [50, 70],
  CRITICAL: [30, 50],
  CORRUPTED: [0, 30],
}

export function getHealthLevel(score: number): HealthLevel {
  if (score >= 95) return 'HEALTHY'
  if (score >= 70) return 'NORMAL'
  if (score >= 50) return 'RISKY'
  if (score >= 30) return 'CRITICAL'
  return 'CORRUPTED'
}

export interface HealthScoreInput {
  consecutiveFailures: number
  toolSuccessRate: number
  contextIntegrity: number
  latencyFactor: number
  guardrailTripRate: number
  tokenBudgetUtilization: number
}

export interface HealthScoreResult {
  score: number
  level: HealthLevel
  trend: 'improving' | 'declining' | 'stable'
  inputs: HealthScoreInput
  timestamp: number
}

// =============================================================================
// 状态机
// =============================================================================

export type SessionState = 'RUNNING' | 'DEGRADED' | 'RECOVERING' | 'SAFE_MODE' | 'REBUILDING' | 'FATAL'

export type RecoveryActionLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export interface StateTransition {
  from: SessionState
  to: SessionState
  reason: string
  timestamp: number
  healthScore: number
}

export interface RecoveryAction {
  level: RecoveryActionLevel
  name: string
  description: string
}

export const RECOVERY_ACTIONS: Record<RecoveryActionLevel, RecoveryAction> = {
  1: { level: 1, name: 'context_compress', description: '上下文压缩，清理 orphan tool_call' },
  2: { level: 2, name: 'inject_correction', description: '注入纠偏提示，引导模型行为' },
  3: { level: 3, name: 'model_switch', description: '切换模型，降级到轻量模型' },
  4: { level: 4, name: 'tool_downgrade', description: '工具降级，只允许只读操作' },
  5: { level: 5, name: 'clear_context', description: '清空上下文窗口，保留 sessionId' },
  6: { level: 6, name: 'rebuild_session', description: '重建会话，继承记忆' },
  7: { level: 7, name: 'safe_mode', description: '进入安全模式，只接受有限指令' },
  8: { level: 8, name: 'hibernation', description: '进入休眠，等待用户主动唤醒' },
}

// =============================================================================
// 状态迁移规则
// =============================================================================

export interface TransitionRule {
  from: SessionState[]
  to: SessionState
  condition: (score: number, consecutiveFailures: number) => boolean
  reason: string
}

export const TRANSITION_RULES: TransitionRule[] = [
  {
    from: ['RUNNING'],
    to: 'DEGRADED',
    condition: (score) => score < 70,
    reason: '健康分低于 70，进入降级状态',
  },
  {
    from: ['RUNNING'],
    to: 'FATAL',
    condition: (_score, failures) => failures >= 33,
    reason: '连续 33 次以上失败，不可恢复',
  },
  {
    from: ['DEGRADED'],
    to: 'RECOVERING',
    condition: (score) => score < 50,
    reason: '健康分低于 50，主动恢复',
  },
  {
    from: ['DEGRADED'],
    to: 'RUNNING',
    condition: (score) => score > 75,
    reason: '健康分回升超过 75，恢复正常',
  },
  {
    from: ['RECOVERING'],
    to: 'SAFE_MODE',
    condition: (score) => score < 30,
    reason: '恢复失败，进入安全模式',
  },
  {
    from: ['RECOVERING'],
    to: 'RUNNING',
    condition: (score) => score > 80,
    reason: '恢复成功，验证通过',
  },
  {
    from: ['SAFE_MODE'],
    to: 'REBUILDING',
    condition: (score) => score < 20,
    reason: '安全模式下仍持续恶化，重建会话',
  },
  {
    from: ['SAFE_MODE'],
    to: 'RUNNING',
    condition: (score) => score > 75,
    reason: '降级后功能子集正常运转',
  },
  {
    from: ['REBUILDING'],
    to: 'RUNNING',
    condition: () => true,
    reason: '会话重建完成',
  },
  {
    from: ['REBUILDING', 'SAFE_MODE', 'RECOVERING', 'DEGRADED', 'RUNNING'],
    to: 'FATAL',
    condition: (_score, failures) => failures >= 50,
    reason: '连续 50 次失败，标记为不可恢复',
  },
]

// =============================================================================
// EventBus 事件类型
// =============================================================================

export interface SessionGovEventMap {
  'session.governor.state_changed': {
    previous: SessionState
    current: SessionState
    reason: string
    healthScore: number
  }
  'session.governor.health_updated': {
    score: number
    level: HealthLevel
    trend: string
    inputs: HealthScoreInput
  }
  'session.governor.recovery.started': {
    fromState: SessionState
    action: RecoveryAction
    healthScore: number
  }
  'session.governor.recovery.completed': {
    success: boolean
    newState: SessionState
    actionsTaken: RecoveryActionLevel[]
  }
  'session.governor.checkpoint.verified': {
    path: string
    healthScore: number
    passed: boolean
    reason?: string
  }
}

// =============================================================================
// UI 状态（通过 StateManager 推送）
// =============================================================================

export interface SessionGovernorUIState {
  healthScore: number
  healthLevel: HealthLevel
  sessionState: SessionState
  recoveryActive: boolean
}

// =============================================================================
// Checkpoint v2 健康验证
// =============================================================================

export interface CheckpointHealthVerification {
  passed: boolean
  score: number
  toolSuccessRate: number
  contextIntegrity: number
  hasPendingToolCalls: boolean
  messageStructureValid: boolean
  reason?: string
}
