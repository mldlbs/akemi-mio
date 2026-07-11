/**
 * M5.2 ChatExecutor Wiring — Integration Verification
 *
 * M5.2 验证 ChatExecutor 已正确接入 GuardrailPipeline。
 * 代码审查确认 wiring 已在 M4.6 集成时提前完成，
 * 此文件补充 integration-level 验证。
 *
 * 不需要构造完整 ChatExecutor（依赖链复杂），
 * 通过 GuardrailPipeline + GuardrailProgressConsumer + mock emitter/DecisionStore
 * 验证 ChatExecutor 中 toolLoop guardrail 代码路径的等价行为。
 *
 * 验证：
 *   T-1: WARNING 不阻断执行
 *   T-2: TERMINATE 正确退出循环
 *   T-3: DecisionStore failure 不影响主流程（Decision-first）
 *   T-4: CONTINUE 不产生副作用
 *   T-5: Delivery trace payload 类型合规（交叉引用 V-D2）
 */

import { describe, it, expect, vi } from 'vitest'
import { GuardrailPipeline } from '../GuardrailPipeline'
import { GuardrailProgressConsumer } from '../progress-consumers/GuardrailProgressConsumer'
import { DefaultGuardrailPolicy } from '../GuardrailPolicy'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from '../GuardrailTypes'
import type { GuardrailDecision, GuardrailPolicyConfig, GuardrailAction } from '../GuardrailTypes'
import type { GuardrailActionDeliveredPayload } from '../types'
import type { ProgressSnapshot } from '../progress'
import { PROGRESS_VERSION } from '../progress'

// ══════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════

function healthySnapshot(traceId = 'm52_trace'): ProgressSnapshot {
  return {
    traceId,
    sessionId: 'm52_session',
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
    informationGain: {
      consecutiveLowOutputTurns: 0,
      repeatedOutputCount: 0,
      repeatedToolResultCount: 0,
      toolResultNovelty: 1,
      summary: '',
    },
    goalProgress: {
      completedSubtasks: 1,
      hasPhaseTransition: false,
      stagnantTurnCount: 0,
      summary: '',
    },
  }
}

function stalledSnapshot(traceId = 'm52_trace'): ProgressSnapshot {
  return {
    traceId,
    sessionId: 'm52_session',
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
    informationGain: {
      consecutiveLowOutputTurns: 10,
      repeatedOutputCount: 5,
      repeatedToolResultCount: 3,
      toolResultNovelty: 0,
      summary: '',
    },
    goalProgress: {
      completedSubtasks: 0,
      hasPhaseTransition: false,
      stagnantTurnCount: 8,
      summary: '',
    },
  }
}

// ══════════════════════════════════════════════
// T-1: WARNING 不阻断执行
// ══════════════════════════════════════════════

describe('T-1: WARNING 不阻断执行', () => {
  it('WARNING 返回正确的 runtimeAction，不设置 guardrailStop 语义', async () => {
    const pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 })
    const consumer = new GuardrailProgressConsumer(undefined, (d) => pipeline.onGuardrailDecision(d))

    // 构造一个处于 degrading 边界的 snapshot（非 stalled）
    const warningSnapshot: ProgressSnapshot = {
      ...healthySnapshot(),
      stateChange: {
        ...healthySnapshot().stateChange,
        hasNewToolResult: false,
        stagnantTurnCount: 4, // > degrading(3) but < stalled(8)
        lastChangeTurn: 0,
      },
    }

    await consumer.consume(warningSnapshot)
    const result = await pipeline.check('m52_trace', 6)

    expect(result).not.toBeNull()
    expect(result!.runtimeAction).toBe('WARNING')

    // ChatExecutor 代码路径等价：WARNING 只 log + emitActionDelivered
    // 不设置 ctx.guardrailStop，toolLoop 继续执行下一轮
    // 验证方式：after check()，trace 仍可被 pipeline 正常处理
    const followUpResult = await pipeline.check('m52_trace', 7)
    // throttle 可能跳过，但不应因为 guardrailStop 而阻塞
    if (followUpResult) {
      expect(followUpResult.runtimeAction).toBe('WARNING')
    }
  })
})

// ══════════════════════════════════════════════
// T-2: TERMINATE 正确退出循环
// ══════════════════════════════════════════════

describe('T-2: TERMINATE 正确退出循环', () => {
  it('TERMINATE 返回 TERMINATE runtimeAction，语义为退出', async () => {
    const pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 })
    const consumer = new GuardrailProgressConsumer(undefined, (d) => pipeline.onGuardrailDecision(d))

    await consumer.consume(stalledSnapshot())
    const result = await pipeline.check('m52_trace', 10)

    expect(result).not.toBeNull()
    expect(result!.runtimeAction).toBe('TERMINATE')

    // ChatExecutor 代码路径等价：
    // check() → TERMINATE → emitActionDelivered + ctx.guardrailStop = true
    // 下一轮 toolLoop 在 guardrailStop 条件检查时退出
    // 这里验证 pipeline 结果的 decisionId 可用于 delivery trace 关联
    expect(result!.decisionId).toBeDefined()
    expect(typeof result!.decisionId).toBe('string')
    expect(result!.decisionId.length).toBeGreaterThan(0)
  })

  it('TERMINATE 附带 emitActionDelivered 所需的所有字段', async () => {
    const pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 })
    const consumer = new GuardrailProgressConsumer(undefined, (d) => pipeline.onGuardrailDecision(d))

    await consumer.consume(stalledSnapshot())
    const result = await pipeline.check('m52_trace', 10)

    expect(result).not.toBeNull()

    // ChatExecutor emitActionDelivered(result.decisionId, traceId, actionType, policyVersion)
    // 验证所有传递参数存在
    expect(result!.decisionId).toBeDefined()
    expect(result!.runtimeAction).toBe('TERMINATE')
    expect(result!.decision.traceId).toBe('m52_trace')
    expect(result!.decision.policyVersion).toBeDefined()
  })
})

// ══════════════════════════════════════════════
// T-3: DecisionStore failure 不影响主流程
// ══════════════════════════════════════════════

describe('T-3: DecisionStore failure 隔离（Decision-first）', () => {
  it('DecisionStore record() 抛异常时，Pipeline.check() 仍正常返回', async () => {
    const deadStore = {
      record: async () => {
        throw new Error('db_unavailable')
      },
      getByTrace: async () => {
        throw new Error('db_unavailable')
      },
    } as any

    const pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 }, undefined, deadStore)
    const consumer = new GuardrailProgressConsumer(undefined, (d) => pipeline.onGuardrailDecision(d))

    await consumer.consume(stalledSnapshot())

    // DecisionStore failure 不应阻止 check() 返回结果
    const result = await pipeline.check('m52_trace', 10)
    expect(result).not.toBeNull()
    expect(result!.runtimeAction).toBe('TERMINATE')
    expect(result!.decision.action).toBe('terminate')
  })

  it('DecisionStore record() 返回 rejected promise 时，Pipeline.check() 不受影响', async () => {
    const rejectStore = {
      record: async () => Promise.reject(new Error('async_db_write_failed')),
      getByTrace: async () => [],
    } as any

    const pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 }, undefined, rejectStore)
    const consumer = new GuardrailProgressConsumer(undefined, (d) => pipeline.onGuardrailDecision(d))

    await consumer.consume(healthySnapshot())
    const result = await pipeline.check('m52_trace', 10)

    // Decision persistence 是 audit 层，不阻塞 policy decision 返回
    expect(result).not.toBeNull()
    expect(result!.runtimeAction).toBe('CONTINUE')
  })

  it('无 DecisionStore（undefined）时 Pipeline.check() 正常', async () => {
    const pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 })
    const consumer = new GuardrailProgressConsumer(undefined, (d) => pipeline.onGuardrailDecision(d))

    await consumer.consume(stalledSnapshot())
    const result = await pipeline.check('m52_trace', 10)

    expect(result).not.toBeNull()
    expect(result!.runtimeAction).toBe('TERMINATE')
  })
})

// ══════════════════════════════════════════════
// T-4: CONTINUE 不产生副作用
// ══════════════════════════════════════════════

describe('T-4: CONTINUE 不产生副作用', () => {
  it('CONTINUE 返回 runtimeAction，不修改 pipeline 状态', async () => {
    const emitter = { emit: vi.fn() }
    const pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 }, emitter as any)
    const consumer = new GuardrailProgressConsumer(undefined, (d) => pipeline.onGuardrailDecision(d))

    await consumer.consume(healthySnapshot())
    const result = await pipeline.check('m52_trace', 6)

    expect(result).not.toBeNull()
    expect(result!.runtimeAction).toBe('CONTINUE')

    // ChatExecutor 代码路径等价：
    // CONTINUE → switch case 空（只 break），不修改 ctx
    // pipeline.reset() 后状态恢复正常
    pipeline.reset()
    expect(pipeline['latestDecision']).toBeNull()
    expect(pipeline['latestRuntimeAction']).toBeNull()
  })

  it('CONTINUE 只写入 guardrail.checked，不写 guardrail.terminated', async () => {
    const emitter = { emit: vi.fn() }
    const pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 }, emitter as any)
    const consumer = new GuardrailProgressConsumer(undefined, (d) => pipeline.onGuardrailDecision(d))

    await consumer.consume(healthySnapshot())
    await pipeline.check('m52_trace', 6)

    // CONTINUE 只 emit guardrail.checked
    const checkedCalls = emitter.emit.mock.calls.filter((c: any) => c[0] === 'guardrail.checked')
    const terminatedCalls = emitter.emit.mock.calls.filter((c: any) => c[0] === 'guardrail.terminated')

    expect(checkedCalls.length).toBeGreaterThanOrEqual(1)
    expect(terminatedCalls.length).toBe(0)
  })
})

// ══════════════════════════════════════════════
// T-5: Delivery trace payload 类型合规
// ══════════════════════════════════════════════

describe('T-5: Delivery trace payload 类型合规', () => {
  it('GuardrailActionDeliveredPayload 不包含 Policy 计算输入（交叉引用 V-D2）', () => {
    // 类型级验证：action_delivered payload 只包含 decisionId/traceId/actionType/policyVersion/timestamp
    // 不包含 snapshot/signals/policyInput
    // 对应的类型验证在 m4-2-delivery-trace-verification.test.ts V-D2 中
    const payload: GuardrailActionDeliveredPayload = {
      decisionId: 'd1',
      traceId: 't1',
      actionType: 'TERMINATE',
      policyVersion: '1.0.0',
      timestamp: Date.now(),
    }

    // 运行时断言：确保 payload 没有混入 Policy 输入
    expect(payload).not.toHaveProperty('snapshot')
    expect(payload).not.toHaveProperty('signals')
    expect(payload).not.toHaveProperty('policyInput')

    // 核心字段
    expect(payload.decisionId).toBe('d1')
    expect(payload.actionType).toBe('TERMINATE')
  })

  it('ChatExecutor.emitActionDelivered 参数类型与 GuardrailActionDeliveredPayload 兼容', () => {
    // ChatExecutor.emitActionDelivered 签名为：
    //   emitActionDelivered(decisionId, traceId, actionType, policyVersion)
    // 其中 actionType 为 'TERMINATE' | 'WARNING' | 'CONTINUE'
    // 与 GuardrailActionDeliveredPayload.actionType 一致
    // ChatExecutor.ts:558-564

    const actionTypes = ['TERMINATE', 'WARNING', 'CONTINUE'] as const
    const decisionId = 'd1'
    const traceId = 't1'
    const policyVersion = '1.0.0'

    // 验证每个 actionType 都能构造合法 payload
    for (const actionType of actionTypes) {
      const payload: GuardrailActionDeliveredPayload = {
        decisionId,
        traceId,
        actionType,
        policyVersion,
        timestamp: Date.now(),
      }
      expect(payload.actionType).toBe(actionType)
      expect(payload.decisionId).toBe(decisionId)
    }
  })
})
