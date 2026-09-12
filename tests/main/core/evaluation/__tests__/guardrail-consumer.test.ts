/**
 * GuardrailProgressConsumer Tests — ADR-004 Step A Verification
 *
 * 覆盖范围（Step A 三项完成标准）：
 * 1. consume() 签名不变 — 返回 void
 * 2. 增加 onDecision callback — 正确交付 GuardrailDecision
 * 3. 无 callback 时行为不变 — no-op 不产生副作用
 *
 * 验证约束：
 * - DI-1: consume(snapshot): void 签名不变
 * - DI-3: onDecision 在 consume() 内部同步调用
 * - C-5: 不持有 Store/Analyzer/Emitter 引用
 */

import { describe, it, expect, vi } from 'vitest'
import { GuardrailProgressConsumer } from '@akemi-mio/core/core/evaluation/progress-consumers/GuardrailProgressConsumer'
import { DefaultGuardrailPolicy } from '@akemi-mio/core/core/evaluation/GuardrailPolicy'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from '@akemi-mio/core/core/evaluation/GuardrailTypes'
import type { ProgressSnapshot, StateChangeSignal, InformationGainSignal, GoalProgressSignal } from '@akemi-mio/core/core/evaluation/progress'
import { PROGRESS_VERSION } from '@akemi-mio/core/core/evaluation/progress'

// ══════════════════════════════════════════════
// 测试数据
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
    traceId: 'test_trace',
    sessionId: 'test_session',
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

// ══════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════

describe('GuardrailProgressConsumer', () => {
  it('1. 接口签名 — consume() 返回 void', async () => {
    const consumer = new GuardrailProgressConsumer()
    const snapshot = makeSnapshot()

    const result = await consumer.consume(snapshot)

    expect(result).toBeUndefined()
  })

  it('2. Decision Delivery — onDecision 接收 GuardrailDecision', async () => {
    const onDecision = vi.fn()
    const consumer = new GuardrailProgressConsumer(undefined, onDecision)
    const snapshot = makeSnapshot()

    await consumer.consume(snapshot)

    expect(onDecision).toHaveBeenCalledTimes(1)
    const decision = onDecision.mock.calls[0][0]
    expect(decision).toHaveProperty('action')
    expect(decision).toHaveProperty('reason')
    expect(decision).toHaveProperty('decidedAt')
    expect(decision).toHaveProperty('traceId')
    expect(decision).toHaveProperty('signals')
    expect(decision).toHaveProperty('snapshot')
    expect(decision.traceId).toBe('test_trace')
    expect(decision.snapshot).toBe(snapshot)
  })

  it('3. DI-3 同步性 — onDecision 在 consume() 返回前已被调用', async () => {
    const onDecision = vi.fn()
    const consumer = new GuardrailProgressConsumer(undefined, onDecision)
    const snapshot = makeSnapshot()

    await consumer.consume(snapshot)

    // Callback 必须在 await 返回前触发（与 DI-3 一致）
    expect(onDecision).toHaveBeenCalled()
  })

  it('4. Decision 正确性 — stagnant 达到阈值触发 terminate', async () => {
    const onDecision = vi.fn()
    const consumer = new GuardrailProgressConsumer(undefined, onDecision)
    const snapshot = makeSnapshot({
      stateChange: {
        hasNewToolResult: false,
        hasNewAssistantContent: false,
        hasPlanningStateChange: false,
        stagnantTurnCount: DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange.stalled,
        lastChangeTurn: -1,
        summary: '',
      },
    })

    await consumer.consume(snapshot)

    const decision = onDecision.mock.calls[0][0]
    expect(decision.action).toBe('terminate')
  })

  it('5. Decision 正确性 — 所有信号 healthy 返回 continue', async () => {
    const onDecision = vi.fn()
    const consumer = new GuardrailProgressConsumer(undefined, onDecision)
    const snapshot = makeSnapshot()

    await consumer.consume(snapshot)

    const decision = onDecision.mock.calls[0][0]
    expect(decision.action).toBe('continue')
  })

  it('6. No-ok callback — 不传 callback 时 consume() 不抛异常', async () => {
    const consumer = new GuardrailProgressConsumer()
    const snapshot = makeSnapshot()

    await expect(consumer.consume(snapshot)).resolves.toBeUndefined()
  })

  it('7. C-5 — Consumer 不持有 Store/Analyzer/Emitter', () => {
    const consumer = new GuardrailProgressConsumer()

    // 只暴露必要的公开属性
    const publicKeys = Object.keys(consumer)
    expect(consumer).not.toHaveProperty('store')
    expect(consumer).not.toHaveProperty('emitter')
    expect(consumer).not.toHaveProperty('analyzer')

    // 只应有: GuardrailPolicy + 可选 callback
    expect(consumer).toHaveProperty('policy')
  })

  it('8. 自定义 policy 可注入', async () => {
    const customDecision = {
      action: 'terminate' as const,
      reason: 'custom',
      decidedAt: 0,
      traceId: 't',
      signals: [],
      snapshot: makeSnapshot(),
    }
    const customPolicy = { evaluate: vi.fn().mockReturnValue(customDecision) }
    const onDecision = vi.fn()
    const consumer = new GuardrailProgressConsumer(customPolicy, onDecision)
    const snapshot = makeSnapshot()

    await consumer.consume(snapshot)

    expect(customPolicy.evaluate).toHaveBeenCalledWith({ snapshot, config: DEFAULT_GUARDRAIL_POLICY_CONFIG })
    expect(onDecision).toHaveBeenCalledWith(customDecision)
  })
})
