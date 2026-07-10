/**
 * M4.1 Contract Production Verification
 *
 * 将 Consumer Contract 约束从"设计文档中的约定"升级为运行时可验证的 invariant。
 *
 * 覆盖范围：
 *   V-P1b: Pipeline reset 清除 latestDecision → check() 返回 null
 *   V-P3b: Consumer 接收 null callback → consume() 不抛出
 *   V-P3c: policy.evaluate 抛出 → callback 不被调用
 *   V-P4a: 前次 check() 返回 TERMINATE 但当前被 throttle → 返回 null（不复用旧 Decision）
 *   V-P4b: reset() 后 check() → null（latestDecision cleared）
 */
import { describe, it, expect, vi } from 'vitest'
import { GuardrailProgressConsumer } from '../progress-consumers/GuardrailProgressConsumer'
import { GuardrailPipeline } from '../GuardrailPipeline'
import { DefaultGuardrailPolicy } from '../GuardrailPolicy'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from '../GuardrailTypes'
import type {
  GuardrailDecision,
  GuardrailPolicy,
  ProgressSnapshot,
  StateChangeSignal,
  InformationGainSignal,
  GoalProgressSignal,
} from '../GuardrailTypes'
import { PROGRESS_VERSION } from '../progress'

// ══════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════

function makeSnapshot(overrides?: Partial<ProgressSnapshot>): ProgressSnapshot {
  const stateChange: StateChangeSignal = {
    hasNewToolResult: false,
    hasNewAssistantContent: false,
    hasPlanningStateChange: false,
    stagnantTurnCount: 0,
    lastChangeTurn: -1,
    summary: '',
  }
  const informationGain: InformationGainSignal = {
    consecutiveLowOutputTurns: 0,
    repeatedOutputCount: 0,
    repeatedToolResultCount: 0,
    toolResultNovelty: 1,
    summary: '',
  }
  const goalProgress: GoalProgressSignal = {
    completedSubtasks: 0,
    hasPhaseTransition: false,
    stagnantTurnCount: 0,
    summary: '',
  }

  return {
    traceId: 'm41_trace',
    sessionId: 'm41_session',
    version: PROGRESS_VERSION,
    totalTurns: 1,
    elapsedMs: 100,
    observedAt: Date.now(),
    stateChange,
    informationGain,
    goalProgress,
    ...overrides,
  }
}

function makeDecision(
  traceId: string = 'm41_trace',
  action: 'continue' | 'terminate' | 'warning' = 'continue',
  overrides?: Partial<GuardrailDecision>,
): GuardrailDecision {
  return {
    action,
    reason: action === 'terminate' ? 'stalled' : 'healthy',
    decidedAt: Date.now(),
    traceId,
    signals: [],
    policyVersion: '1.0.0',
    snapshot: makeSnapshot({ traceId }),
    ...overrides,
  }
}

// ══════════════════════════════════════════════
// V-P1: Decision 唯一生产源
// ══════════════════════════════════════════════

describe('V-P1: Decision 唯一生产源', () => {
  it('V-P1b: Pipeline reset 清除 latestDecision → check() 返回 null', async () => {
    const pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 })

    // 投递一个 Decision
    pipeline.onGuardrailDecision(makeDecision('trace_a'))
    const r1 = await pipeline.check('trace_a', 5)
    expect(r1).not.toBeNull()
    expect(r1!.runtimeAction).toBe('CONTINUE')

    // reset 清除 latestDecision
    pipeline.reset()

    // 同一 traceId 再 check → 应为 null（latestDecision 已被清除）
    const r2 = await pipeline.check('trace_a', 10)
    expect(r2).toBeNull()
  })
})

// ══════════════════════════════════════════════
// V-P3: Callback 生命周期稳定
// ══════════════════════════════════════════════

describe('V-P3: Callback 生命周期稳定', () => {
  it('V-P3b: Consumer 接收 null callback → consume() 不抛出', async () => {
    const consumer = new GuardrailProgressConsumer(undefined, null)
    const snapshot = makeSnapshot()

    await expect(consumer.consume(snapshot)).resolves.toBeUndefined()
  })

  it('V-P3c: policy.evaluate 抛出 → callback 不被调用', async () => {
    const onDecision = vi.fn()

    // 构造一个 evaluate() 会抛出的 policy
    const throwingPolicy: GuardrailPolicy = {
      evaluate: () => {
        throw new Error('evaluate crash')
      },
    }

    const consumer = new GuardrailProgressConsumer(throwingPolicy, onDecision)
    const snapshot = makeSnapshot()

    // M5.4 R-2: consume 内部 catch 异常，不向上传播
    await expect(consumer.consume(snapshot)).resolves.toBeUndefined()

    // callback 不应被调用
    expect(onDecision).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════
// V-P4: Error Path 明确
// ══════════════════════════════════════════════

describe('V-P4: Error Path 明确', () => {
  it('V-P4a: 前次 check() 返回 TERMINATE 但当前被 throttle → 返回 null', async () => {
    const pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 5 })

    // 投递 TERMINATE Decision
    pipeline.onGuardrailDecision(makeDecision('trace_t', 'terminate'))

    // 第一次 check → 返回 TERMINATE
    const r1 = await pipeline.check('trace_t', 10)
    expect(r1).not.toBeNull()
    expect(r1!.runtimeAction).toBe('TERMINATE')

    // 同一 traceId，但 turn 13 - 10 = 3 < 5，被 throttle
    const r2 = await pipeline.check('trace_t', 13)
    expect(r2).toBeNull()

    // 再次确认：throttle 导致返回 null，而非重复投递旧 Decision
    const r3 = await pipeline.check('trace_t', 16)
    expect(r3).not.toBeNull()
    expect(r3!.runtimeAction).toBe('TERMINATE')
  })

  it('V-P4b: reset() 后 check() → null（latestDecision cleared）', async () => {
    const pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 })

    pipeline.onGuardrailDecision(makeDecision('trace_b', 'terminate'))
    const r1 = await pipeline.check('trace_b', 5)
    expect(r1).not.toBeNull()

    pipeline.reset()

    // reset 后，即使之前有 Decision，check 也返回 null
    const r2 = await pipeline.check('trace_b', 10)
    expect(r2).toBeNull()
  })
})
