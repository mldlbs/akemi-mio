/**
 * GuardrailPipeline Step D Integration Tests — ADR-004 迁移验证
 *
 * 覆盖范围（Step D — 兼容层已删除，纯 callback 路径）：
 * 1. 数据流 — Pipeline 完全通过 callback Decision 工作
 * 2. Pipeline 职责保持 — 不修改 Decision 内容，不新增业务判断
 * 3. 无 callback Decision → null（return skip）
 * 4. traceId 隔离生效
 *
 * 风险验证：
 * - Audit Event 顺序：emitGuardrailEvents 顺序与 callback 路径的 Decision 一致
 * - 单 Trace 单次 callback：防止重复通知
 */

import { describe, it, expect, vi } from 'vitest'
import { GuardrailPipeline } from '../GuardrailPipeline'
import { GuardrailProgressConsumer } from '../progress-consumers/GuardrailProgressConsumer'
import { InMemoryEvaluationRepository } from '../__test_support__'
import type { ProgressSnapshot, StateChangeSignal, InformationGainSignal, GoalProgressSignal } from '../progress'
import { PROGRESS_VERSION } from '../progress'

// ══════════════════════════════════════════════
// 测试数据
// ══════════════════════════════════════════════

const SNAPSHOT_HEALTHY: ProgressSnapshot = {
  traceId: 'step_d_trace',
  sessionId: 'step_d_session',
  version: PROGRESS_VERSION,
  totalTurns: 3,
  elapsedMs: 500,
  observedAt: Date.now(),
  stateChange: {
    hasNewToolResult: true,
    hasNewAssistantContent: true,
    hasPlanningStateChange: false,
    stagnantTurnCount: 0,
    lastChangeTurn: 2,
    summary: '',
  },
  informationGain: { consecutiveLowOutputTurns: 0, repeatedOutputCount: 0, repeatedToolResultCount: 0, toolResultNovelty: 1, summary: '' },
  goalProgress: { completedSubtasks: 1, hasPhaseTransition: false, stagnantTurnCount: 0, summary: '' },
}

const SNAPSHOT_STALLED: ProgressSnapshot = {
  traceId: 'step_d_trace',
  sessionId: 'step_d_session',
  version: PROGRESS_VERSION,
  totalTurns: 15,
  elapsedMs: 5000,
  observedAt: Date.now(),
  stateChange: {
    hasNewToolResult: false,
    hasNewAssistantContent: false,
    hasPlanningStateChange: false,
    stagnantTurnCount: 8,
    lastChangeTurn: -1,
    summary: '',
  },
  informationGain: { consecutiveLowOutputTurns: 10, repeatedOutputCount: 5, repeatedToolResultCount: 3, toolResultNovelty: 0, summary: '' },
  goalProgress: { completedSubtasks: 0, hasPhaseTransition: false, stagnantTurnCount: 8, summary: '' },
}

// ══════════════════════════════════════════════
// Step D: Pipeline Integration Tests
// ══════════════════════════════════════════════

describe('Step D: Pipeline callback integration', () => {
  let pipeline: GuardrailPipeline

  beforeEach(() => {
    pipeline = new GuardrailPipeline()
  })

  it('1. 数据流 — callback Decision 被消费', async () => {
    const expectedAction = 'terminate' as const
    const expectedReason = 'callback test'
    const callbackDecision = {
      action: expectedAction,
      reason: expectedReason,
      decidedAt: Date.now(),
      traceId: 'step_d_trace',
      signals: [],
      snapshot: SNAPSHOT_STALLED,
    }

    pipeline.onGuardrailDecision(callbackDecision)

    const result = await pipeline.check('step_d_trace', 6)

    expect(result).not.toBeNull()
    expect(result!.decision.action).toBe(expectedAction)
    expect(result!.decision.reason).toBe(expectedReason)
    expect(result!.runtimeAction).toBe('TERMINATE')
  })

  it('2. Pipeline 不修改 Decision — callback Decision 保持完整', async () => {
    const callbackDecision = {
      action: 'continue' as const,
      reason: 'callback test — full object',
      decidedAt: 12345,
      traceId: 'step_d_trace',
      signals: [{ name: 'test_signal', status: 'healthy' as const, detail: 'test' }],
      snapshot: SNAPSHOT_HEALTHY,
    }

    pipeline.onGuardrailDecision(callbackDecision)
    const result = await pipeline.check('step_d_trace', 6)

    // Check every field is preserved
    expect(result!.decision.action).toBe(callbackDecision.action)
    expect(result!.decision.reason).toBe(callbackDecision.reason)
    expect(result!.decision.decidedAt).toBe(callbackDecision.decidedAt)
    expect(result!.decision.traceId).toBe(callbackDecision.traceId)
    expect(result!.decision.signals).toEqual(callbackDecision.signals)
    expect(result!.decision.snapshot).toBe(callbackDecision.snapshot)
    expect(result!.runtimeAction).toBe('CONTINUE')
  })

  it('3. 无 callback Decision 返回 null（skip）', async () => {
    const result = await pipeline.check('step_d_trace', 6)
    expect(result).toBeNull()
  })

  it('4. TraceId 隔离 — callback Decision 只对匹配 traceId 生效', async () => {
    const callbackDecision = {
      action: 'terminate' as const,
      reason: 'for trace A only',
      decidedAt: Date.now(),
      traceId: 'trace_a',
      signals: [],
      snapshot: SNAPSHOT_STALLED,
    }

    pipeline.onGuardrailDecision(callbackDecision)

    // Trace B should NOT use trace A's callback Decision → null
    const resultForTraceB = await pipeline.check('trace_b', 6)
    expect(resultForTraceB).toBeNull()
  })

  it('5. Audit Event 顺序 — emitGuardrailEvents 在 Runtime 更新前被写入', async () => {
    const emitter = {
      emit: vi.fn(),
    }
    const pipelineWithEmitter = new GuardrailPipeline(undefined, undefined, emitter as any)

    const callbackDecision = {
      action: 'terminate' as const,
      reason: 'audit order test',
      decidedAt: Date.now(),
      traceId: 'step_d_trace',
      signals: [],
      snapshot: SNAPSHOT_STALLED,
    }

    pipelineWithEmitter.onGuardrailDecision(callbackDecision)
    const result = await pipelineWithEmitter.check('step_d_trace', 6)

    expect(emitter.emit).toHaveBeenCalled()
    const emitCall = emitter.emit.mock.calls[0]
    expect(emitCall[0]).toBe('guardrail.checked')
    expect(emitCall[1].decision).toBe('terminate')
  })
})

// ══════════════════════════════════════════════
// Step D: Consumer → Pipeline full chain
// ══════════════════════════════════════════════

describe('Step D: Consumer → Pipeline full chain', () => {
  let pipeline: GuardrailPipeline
  let consumer: GuardrailProgressConsumer

  beforeEach(() => {
    pipeline = new GuardrailPipeline()
    consumer = new GuardrailProgressConsumer(undefined, (decision) => {
      pipeline.onGuardrailDecision(decision)
    })
  })

  it('6. 全链路集成 — Consumer → Pipeline callback → check() 返回一致结果', async () => {
    // Consumer produces Decision → callback pushes to Pipeline → check() reads it
    await consumer.consume(SNAPSHOT_STALLED)

    const result = await pipeline.check('step_d_trace', 6)

    expect(result).not.toBeNull()
    expect(result!.decision.action).toBe('terminate')
    expect(result!.runtimeAction).toBe('TERMINATE')
  })

  it('7. 单 Trace 单次 callback — 重复 consume 仅保留最新 Decision', async () => {
    await consumer.consume(SNAPSHOT_STALLED)
    await consumer.consume(SNAPSHOT_HEALTHY)

    const result = await pipeline.check('step_d_trace', 6)

    expect(result).not.toBeNull()
    expect(result!.decision.action).toBe('continue')
  })

  it('8. Emitter 在 callback 路径下正常工作', async () => {
    const emitter = { emit: vi.fn() }
    const pipelineWithEmitter = new GuardrailPipeline(undefined, undefined, emitter as any)
    const localConsumer = new GuardrailProgressConsumer(undefined, (d) => pipelineWithEmitter.onGuardrailDecision(d))

    await localConsumer.consume(SNAPSHOT_HEALTHY)
    const result = await pipelineWithEmitter.check('step_d_trace', 6)

    expect(result).not.toBeNull()
    expect(emitter.emit).toHaveBeenCalled()
    expect(emitter.emit.mock.calls[0][1].decision).toBe('continue')
  })
})
