/**
 * SessionGovernor 组件单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SessionHealthScorer } from '../SessionHealthScorer'
import { SessionStateMachine } from '../SessionStateMachine'
import { CheckpointV2 } from '../CheckpointV2'
import { SessionRecoveryManager } from '../../agent/SessionRecoveryManager'
import { getHealthLevel, TRANSITION_RULES, RECOVERY_ACTIONS } from '../SessionGovernorTypes'

// =============================================================================
// SessionHealthScorer
// =============================================================================

describe('SessionHealthScorer', () => {
  let scorer: SessionHealthScorer

  beforeEach(() => {
    scorer = new SessionHealthScorer()
  })

  it('starts at 100', () => {
    expect(scorer.getScore()).toBe(100)
    expect(scorer.getLevel()).toBe('HEALTHY')
  })

  it('consecutive failures decrease score', () => {
    for (let i = 0; i < 10; i++) scorer.recordToolResult(false)
    expect(scorer.getScore()).toBeLessThan(100)
    expect(scorer.getScore()).toBeGreaterThan(0)
    expect(scorer.getConsecutiveFailures()).toBe(10)
  })

  it('success resets consecutive failures', () => {
    for (let i = 0; i < 5; i++) scorer.recordToolResult(false)
    expect(scorer.getConsecutiveFailures()).toBe(5)
    scorer.recordToolResult(true)
    expect(scorer.getConsecutiveFailures()).toBe(0)
  })

  it('maintains sliding window of 20 tool results', () => {
    for (let i = 0; i < 15; i++) scorer.recordToolResult(true)
    for (let i = 0; i < 5; i++) scorer.recordToolResult(false)
    const diag = scorer.getDiagnostics()
    expect(diag.toolWindowSize).toBe(20)
  })

  it('guardrail trips affect score', () => {
    for (let i = 0; i < 10; i++) scorer.recordGuardrailTrip()
    const clean = new SessionHealthScorer()
    for (let i = 0; i < 10; i++) scorer.recordToolResult(true)
    for (let i = 0; i < 10; i++) clean.recordToolResult(true)
    expect(scorer.getScore()).toBeLessThanOrEqual(clean.getScore())
  })

  it('snapshot roundtrips', () => {
    for (let i = 0; i < 5; i++) scorer.recordToolResult(false)
    const snap = scorer.getSnapshot()
    const restored = new SessionHealthScorer()
    restored.loadSnapshot(snap as Record<string, unknown>)
    expect(restored.getConsecutiveFailures()).toBe(5)
  })
})

// =============================================================================
// getHealthLevel
// =============================================================================

describe('getHealthLevel', () => {
  it('returns HEALTHY for 95-100', () => {
    expect(getHealthLevel(100)).toBe('HEALTHY')
    expect(getHealthLevel(95)).toBe('HEALTHY')
  })
  it('returns NORMAL for 70-95', () => {
    expect(getHealthLevel(85)).toBe('NORMAL')
    expect(getHealthLevel(70)).toBe('NORMAL')
  })
  it('returns RISKY for 50-70', () => {
    expect(getHealthLevel(60)).toBe('RISKY')
  })
  it('returns CRITICAL for 30-50', () => {
    expect(getHealthLevel(40)).toBe('CRITICAL')
  })
  it('returns CORRUPTED for 0-30', () => {
    expect(getHealthLevel(15)).toBe('CORRUPTED')
    expect(getHealthLevel(0)).toBe('CORRUPTED')
  })
})

// =============================================================================
// SessionStateMachine
// =============================================================================

describe('SessionStateMachine', () => {
  let machine: SessionStateMachine

  beforeEach(() => {
    machine = new SessionStateMachine()
  })

  it('starts in RUNNING', () => {
    expect(machine.state).toBe('RUNNING')
    expect(machine.canRecover()).toBe(true)
  })

  it('evaluates RUNNING → DEGRADED when score < 70', () => {
    expect(machine.evaluateTransition(65, 0)!.to).toBe('DEGRADED')
  })

  it('evaluates RUNNING → FATAL when failures >= 33', () => {
    expect(machine.evaluateTransition(100, 33)!.to).toBe('FATAL')
  })

  it('no transition on healthy state', () => {
    expect(machine.evaluateTransition(100, 0)).toBeNull()
  })

  it('transitionTo records history', () => {
    machine.transitionTo('DEGRADED', 'test', 60)
    expect(machine.state).toBe('DEGRADED')
    expect(machine.getTransitions()).toHaveLength(1)
    expect(machine.getLastTransition()!.from).toBe('RUNNING')
  })

  it('FATAL cannot recover', () => {
    machine.transitionTo('FATAL', 'end', 10)
    expect(machine.canRecover()).toBe(false)
  })

  it('DEGRADED recommends actions 1,2', () => {
    machine.transitionTo('DEGRADED', 'test', 60)
    expect(machine.getRecommendedActions()).toEqual([1, 2])
  })

  it('RECOVERING recommends actions 1,2,3,4', () => {
    machine.transitionTo('RECOVERING', 'test', 40)
    expect(machine.getRecommendedActions()).toEqual([1, 2, 3, 4])
  })

  it('reset goes to RUNNING', () => {
    machine.transitionTo('FATAL', 'test', 10)
    machine.reset()
    expect(machine.state).toBe('RUNNING')
  })
})

// =============================================================================
// RECOVERY_ACTIONS
// =============================================================================

describe('RECOVERY_ACTIONS', () => {
  it('has all 8 levels', () => {
    for (let i = 1; i <= 8; i++) {
      expect(RECOVERY_ACTIONS[i as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8]).toBeDefined()
    }
  })
})

// =============================================================================
// CheckpointV2
// =============================================================================

describe('CheckpointV2', () => {
  it('verifyCheckpointHealth passes when healthy', () => {
    const scorer = new SessionHealthScorer()
    const cp = new CheckpointV2('/tmp/cp_test', {} as SessionRecoveryManager)
    cp.setHealthScorer(scorer)
    expect(cp.verifyCheckpointHealth().passed).toBe(true)
  })

  it('verifyCheckpointHealth fails when corrupted', () => {
    const scorer = new SessionHealthScorer()
    for (let i = 0; i < 15; i++) scorer.recordToolResult(false)
    const cp = new CheckpointV2('/tmp/cp_test', {} as SessionRecoveryManager)
    cp.setHealthScorer(scorer)
    const result = cp.verifyCheckpointHealth()
    expect(result.passed).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it('verifyCheckpointHealth fails at >= 10 consecutive failures', () => {
    const scorer = new SessionHealthScorer()
    for (let i = 0; i < 10; i++) scorer.recordToolResult(false)
    const cp = new CheckpointV2('/tmp/cp_test', {} as SessionRecoveryManager)
    cp.setHealthScorer(scorer)
    expect(cp.verifyCheckpointHealth().passed).toBe(false)
  })
})
