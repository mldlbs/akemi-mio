/**
 * Guardrail Kernel Tests — 纯函数测试，无需运行 App
 *
 * 覆盖范围：
 * - ProgressAnalyzer.compute() 纯函数（12+ cases）
 * - GuardrailPolicy.evaluate() 纯函数（9 cases）
 * - GuardrailPipeline 集成（4 cases）
 */

import { describe, it, expect } from 'vitest'
import type { EvaluationEvent, EventType } from '../types'
import { GuardrailProgressAnalyzer } from '../GuardrailProgressAnalyzer'
import { DefaultGuardrailPolicy } from '../GuardrailPolicy'
import { GuardrailPipeline } from '../GuardrailPipeline'
import { InMemoryEvaluationRepository } from '../__test_support__'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from '../GuardrailTypes'

// ══════════════════════════════════════════════
// Helpers: 快速构造 EvaluationEvent
// ══════════════════════════════════════════════

let idCounter = 0
function makeEvent(overrides: Partial<EvaluationEvent> & { type: EventType; payload: any }): EvaluationEvent {
  idCounter++
  return {
    id: `test_${idCounter}`,
    timestamp: Date.now() + idCounter,
    traceId: 'test_trace',
    sessionId: 'test_session',
    source: 'test',
    ...overrides,
  }
}

function toolInvoked(toolName: string): EvaluationEvent {
  return makeEvent({ type: 'tool.invoked', payload: { type: 'tool.invoked', toolName } })
}

function toolCompleted(toolName: string, output?: string): EvaluationEvent {
  return makeEvent({ type: 'tool.completed', payload: { type: 'tool.completed', toolName, durationMs: 100, output } })
}

function modelInvoked(): EvaluationEvent {
  return makeEvent({ type: 'model.invoked', payload: { type: 'model.invoked', modelName: 'test-model', promptLength: 100 } })
}

function modelCompleted(responseLength: number, responsePreview?: string): EvaluationEvent {
  return makeEvent({
    type: 'model.completed',
    payload: {
      type: 'model.completed',
      modelName: 'test-model',
      durationMs: 500,
      inputTokens: 1000,
      outputTokens: 50,
      responseLength,
      responsePreview,
    },
  })
}

function agentResponse(): EvaluationEvent {
  return makeEvent({ type: 'agent.response', payload: { type: 'agent.response', length: 50, durationMs: 100 } })
}

function taskCompleted(): EvaluationEvent {
  return makeEvent({ type: 'task.completed', payload: { type: 'task.completed', kind: 'chat', outcome: 'completed', durationMs: 100 } })
}

function workflowStarted(): EvaluationEvent {
  return makeEvent({ type: 'workflow.started', payload: { type: 'workflow.started', workflowId: 'wf1', totalPhases: 3 } })
}

function workflowCompleted(): EvaluationEvent {
  return makeEvent({
    type: 'workflow.completed',
    payload: { type: 'workflow.completed', workflowId: 'wf1', outcome: 'completed', durationMs: 500, agentCount: 3 },
  })
}

// ══════════════════════════════════════════════
// A. ProgressAnalyzer.compute() 纯函数测试
// ══════════════════════════════════════════════

describe('GuardrailProgressAnalyzer.compute()', () => {
  it('空 trace → 所有信号默认值', () => {
    const snap = GuardrailProgressAnalyzer.compute('empty', [])
    expect(snap.totalTurns).toBe(0)
    expect(snap.stateChange.stagnantTurnCount).toBe(0)
    expect(snap.stateChange.hasNewToolResult).toBe(false)
    expect(snap.informationGain.toolResultNovelty).toBe(1)
    expect(snap.informationGain.consecutiveLowOutputTurns).toBe(0)
    expect(snap.goalProgress.completedSubtasks).toBe(0)
  })

  it('单次 model.invoked → 1 turn', () => {
    const events = [modelInvoked(), modelCompleted(100, 'hello')]
    const snap = GuardrailProgressAnalyzer.compute('trace1', events)
    expect(snap.totalTurns).toBe(1)
  })

  it('有工具调用的 turn → stateChange.hasNewToolResult = true', () => {
    const events = [modelInvoked(), toolInvoked('read_file'), toolCompleted('read_file', 'file content'), modelCompleted(50, 'found it')]
    const snap = GuardrailProgressAnalyzer.compute('trace1', events)
    expect(snap.stateChange.hasNewToolResult).toBe(true)
    expect(snap.stateChange.stagnantTurnCount).toBe(0)
  })

  it('连续多轮无变化 → stagnantTurnCount 递增', () => {
    // 3 轮，全部只有 model.invoked → model.completed，无操作
    const events = [modelInvoked(), modelCompleted(0), modelInvoked(), modelCompleted(0), modelInvoked(), modelCompleted(0)]
    const snap = GuardrailProgressAnalyzer.compute('trace1', events)
    expect(snap.stateChange.stagnantTurnCount).toBe(3) // 全部 3 轮都在空转
    expect(snap.stateChange.lastChangeTurn).toBe(-1) // 从未发生状态变化
  })

  it('最后一轮有工具调用 → stagnantTurnCount = 0', () => {
    const events = [
      modelInvoked(),
      modelCompleted(0),
      modelInvoked(),
      toolInvoked('calc'),
      toolCompleted('calc', '42'),
      modelCompleted(10, 'answer is 42'),
    ]
    const snap = GuardrailProgressAnalyzer.compute('trace1', events)
    expect(snap.stateChange.hasNewToolResult).toBe(true)
    expect(snap.stateChange.stagnantTurnCount).toBe(0)
  })

  it('连续低输出检测', () => {
    const events = [
      modelInvoked(),
      modelCompleted(5, 'hi'),
      modelInvoked(),
      modelCompleted(10, 'ok'),
      modelInvoked(),
      modelCompleted(3, 'no'),
    ]
    const snap = GuardrailProgressAnalyzer.compute('trace1', events)
    expect(snap.informationGain.consecutiveLowOutputTurns).toBe(3)
  })

  it('正常输出不触发低输出警告', () => {
    const events = [
      modelInvoked(),
      modelCompleted(200, 'a longer response with meaningful content'),
      modelCompleted(150, 'another substantive output'),
    ]
    // Note: second model.completed is not preceded by model.invoked, so it's part of turn 0
    const snap = GuardrailProgressAnalyzer.compute('trace1', events)
    expect(snap.informationGain.consecutiveLowOutputTurns).toBe(0)
  })

  it('重复工具结果 → repeatedToolResultCount 增加', () => {
    const events = [
      modelInvoked(),
      toolInvoked('read_file'),
      toolCompleted('read_file', 'content_a'),
      modelCompleted(20, 'ok'),
      modelInvoked(),
      toolInvoked('read_file'),
      toolCompleted('read_file', 'content_a'),
      modelCompleted(10, 'ok'),
      modelInvoked(),
      toolInvoked('read_file'),
      toolCompleted('read_file', 'content_a'),
      modelCompleted(5, 'ok'),
    ]
    const snap = GuardrailProgressAnalyzer.compute('trace1', events)
    // 3 次调用，但只有 1 个新颖结果，2 个重复
    expect(snap.informationGain.repeatedToolResultCount).toBe(2)
    expect(snap.informationGain.toolResultNovelty).toBeCloseTo(1 / 3, 2)
  })

  it('task.completed 计入 goalProgress', () => {
    const events = [modelInvoked(), taskCompleted(), modelCompleted(10, 'done')]
    const snap = GuardrailProgressAnalyzer.compute('trace1', events)
    expect(snap.goalProgress.completedSubtasks).toBe(1)
  })

  it('workflow.completed → workflow.started → hasPhaseTransition', () => {
    const events = [
      modelInvoked(),
      workflowCompleted(),
      modelCompleted(10, 'phase1'),
      modelInvoked(),
      workflowStarted(),
      modelCompleted(10, 'phase2'),
    ]
    const snap = GuardrailProgressAnalyzer.compute('trace1', events)
    expect(snap.goalProgress.hasPhaseTransition).toBe(true)
  })

  it('复杂多轮 trace 正确计算所有信号', () => {
    // 10 轮混合场景
    const events = [
      // Turn 0: 普通工具调用
      modelInvoked(),
      toolInvoked('search'),
      toolCompleted('search', 'result_a'),
      modelCompleted(100, 'found info'),
      // Turn 1: 助理回复
      modelInvoked(),
      agentResponse(),
      modelCompleted(200, 'let me help you'),
      // Turn 2: 完成子任务
      modelInvoked(),
      taskCompleted(),
      modelCompleted(50, 'done'),
      // Turn 3-8: 连续低输出重复（6 轮）
      modelInvoked(),
      toolInvoked('read'),
      toolCompleted('read', 'same_content'),
      modelCompleted(5, 'ok'),
      modelInvoked(),
      toolInvoked('read'),
      toolCompleted('read', 'same_content'),
      modelCompleted(5, 'ok'),
      modelInvoked(),
      toolInvoked('read'),
      toolCompleted('read', 'same_content'),
      modelCompleted(5, 'ok'),
      modelInvoked(),
      toolInvoked('read'),
      toolCompleted('read', 'same_content'),
      modelCompleted(5, 'ok'),
      modelInvoked(),
      toolInvoked('read'),
      toolCompleted('read', 'same_content'),
      modelCompleted(5, 'ok'),
      modelInvoked(),
      toolInvoked('read'),
      toolCompleted('read', 'same_content'),
      modelCompleted(5, 'ok'),
      // Turn 9: 最后有结果
      modelInvoked(),
      toolInvoked('search'),
      toolCompleted('search', 'new_result'),
      modelCompleted(100, 'found new'),
    ]
    const snap = GuardrailProgressAnalyzer.compute('trace1', events)
    expect(snap.totalTurns).toBe(10)
    // 最后是活跃的，stagnant 应该低
    expect(snap.stateChange.hasNewToolResult).toBe(true)

    // 有子任务完成
    expect(snap.goalProgress.completedSubtasks).toBe(1)

    // read same_content 重复了 6 次
    expect(snap.informationGain.repeatedToolResultCount).toBeGreaterThanOrEqual(5)
  })
})

// ══════════════════════════════════════════════
// B. GuardrailPolicy.evaluate() 纯函数测试
// ══════════════════════════════════════════════

function healthySnapshot(overrides?: any): any {
  return {
    traceId: 'test_trace',
    sessionId: 'test_session',
    totalTurns: 10,
    elapsedMs: 5000,
    computedAt: Date.now(),
    stateChange: {
      hasNewToolResult: true,
      hasNewAssistantContent: false,
      hasPlanningStateChange: false,
      stagnantTurnCount: 0,
      lastChangeTurn: 9,
      summary: 'healthy',
    },
    informationGain: {
      consecutiveLowOutputTurns: 0,
      repeatedOutputCount: 0,
      repeatedToolResultCount: 0,
      toolResultNovelty: 1,
      summary: 'healthy',
    },
    goalProgress: { completedSubtasks: 3, hasPhaseTransition: false, stagnantTurnCount: 0, summary: 'healthy' },
    ...overrides,
  }
}

describe('DefaultGuardrailPolicy.evaluate()', () => {
  it('所有信号 healthy → continue', () => {
    const policy = new DefaultGuardrailPolicy()
    const decision = policy.evaluate(healthySnapshot())
    expect(decision.action).toBe('continue')
    expect(decision.reason).toBe('All signals healthy')
  })

  it('stateChange degrading → warning', () => {
    const policy = new DefaultGuardrailPolicy()
    const decision = policy.evaluate(
      healthySnapshot({
        stateChange: {
          hasNewToolResult: false,
          hasNewAssistantContent: false,
          hasPlanningStateChange: false,
          stagnantTurnCount: 4,
          lastChangeTurn: 3,
          summary: 'stagnant 4 turns',
        },
      }),
    )
    expect(decision.action).toBe('warning')
    expect(decision.signals[0].status).toBe('degrading')
  })

  it('stateChange stalled → terminate', () => {
    const policy = new DefaultGuardrailPolicy()
    const decision = policy.evaluate(
      healthySnapshot({
        stateChange: {
          hasNewToolResult: false,
          hasNewAssistantContent: false,
          hasPlanningStateChange: false,
          stagnantTurnCount: 10,
          lastChangeTurn: 2,
          summary: 'stagnant 10 turns',
        },
      }),
    )
    expect(decision.action).toBe('terminate')
    expect(decision.signals[0].status).toBe('stalled')
  })

  it('informationGain 低输出 degrading → warning', () => {
    const policy = new DefaultGuardrailPolicy()
    const decision = policy.evaluate(
      healthySnapshot({
        informationGain: {
          consecutiveLowOutputTurns: 4,
          repeatedOutputCount: 0,
          repeatedToolResultCount: 0,
          toolResultNovelty: 0.5,
          summary: 'low output',
        },
      }),
    )
    expect(decision.action).toBe('warning')
    expect(decision.signals[1].status).toBe('degrading')
  })

  it('informationGain 低输出 stalled → terminate', () => {
    const policy = new DefaultGuardrailPolicy()
    const decision = policy.evaluate(
      healthySnapshot({
        informationGain: {
          consecutiveLowOutputTurns: 10,
          repeatedOutputCount: 0,
          repeatedToolResultCount: 0,
          toolResultNovelty: 0.5,
          summary: 'very low output',
        },
      }),
    )
    expect(decision.action).toBe('terminate')
    expect(decision.signals[1].status).toBe('stalled')
  })

  it('informationGain 重复内容 degrading → warning', () => {
    const policy = new DefaultGuardrailPolicy()
    const decision = policy.evaluate(
      healthySnapshot({
        informationGain: {
          consecutiveLowOutputTurns: 0,
          repeatedOutputCount: 3,
          repeatedToolResultCount: 0,
          toolResultNovelty: 1,
          summary: 'repeated content',
        },
      }),
    )
    expect(decision.action).toBe('warning')
    expect(decision.signals[1].status).toBe('degrading')
  })

  it('goalProgress degrading → warning', () => {
    const policy = new DefaultGuardrailPolicy()
    const decision = policy.evaluate(
      healthySnapshot({
        goalProgress: { completedSubtasks: 1, hasPhaseTransition: false, stagnantTurnCount: 5, summary: 'no progress' },
      }),
    )
    expect(decision.action).toBe('warning')
    expect(decision.signals[2].status).toBe('degrading')
  })

  it('goalProgress stalled → terminate', () => {
    const policy = new DefaultGuardrailPolicy()
    const decision = policy.evaluate(
      healthySnapshot({
        goalProgress: { completedSubtasks: 1, hasPhaseTransition: false, stagnantTurnCount: 12, summary: 'very stalled' },
      }),
    )
    expect(decision.action).toBe('terminate')
    expect(decision.signals[2].status).toBe('stalled')
  })

  it('两个信号 degrading → warning（不是 terminate）', () => {
    const policy = new DefaultGuardrailPolicy()
    const decision = policy.evaluate(
      healthySnapshot({
        stateChange: {
          hasNewToolResult: false,
          hasNewAssistantContent: false,
          hasPlanningStateChange: false,
          stagnantTurnCount: 5,
          lastChangeTurn: 3,
          summary: 'stagnant',
        },
        informationGain: {
          consecutiveLowOutputTurns: 5,
          repeatedOutputCount: 0,
          repeatedToolResultCount: 0,
          toolResultNovelty: 0.2,
          summary: 'low output',
        },
      }),
    )
    // 两者都是 degrading，但都不是 stalled，所以应该是 warning
    expect(decision.action).toBe('warning')
  })

  it('自定义阈值覆盖默认值', () => {
    const policy = new DefaultGuardrailPolicy({
      stateChange: { degrading: 10, stalled: 20 },
    })
    // 5 轮停滞，但阈值是 10，所以应该是 healthy
    const decision = policy.evaluate(
      healthySnapshot({
        stateChange: {
          hasNewToolResult: false,
          hasNewAssistantContent: false,
          hasPlanningStateChange: false,
          stagnantTurnCount: 5,
          lastChangeTurn: 3,
          summary: '5 turns stagnant',
        },
      }),
    )
    expect(decision.action).toBe('continue')
    expect(decision.signals[0].status).toBe('healthy')
  })

  it('traceId 正确传递到决策结果', () => {
    const policy = new DefaultGuardrailPolicy()
    const decision = policy.evaluate(healthySnapshot({ traceId: 'my_trace_42' }))
    expect(decision.traceId).toBe('my_trace_42')
  })
})

// ══════════════════════════════════════════════
// C. GuardrailPipeline 集成测试
// ══════════════════════════════════════════════

describe('GuardrailPipeline', () => {
  it('minTurnsBeforeCheck = 5 时，turn 2 返回 null', async () => {
    const repo = new InMemoryEvaluationRepository()
    const pipeline = new GuardrailPipeline(repo, undefined, { minTurnsBeforeCheck: 5, checkIntervalTurns: 3 })
    const result = await pipeline.check('trace_a', 2)
    expect(result).toBeNull()
  })

  it('checkIntervalTurns = 3 时，连续检查跳过', async () => {
    const repo = new InMemoryEvaluationRepository()
    // 添加一些事件使 analyze 返回有效结果
    repo.append(modelInvoked())
    repo.append(modelCompleted(100, 'hello'))

    const pipeline = new GuardrailPipeline(repo, undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 3 })

    // Turn 0 应该触发
    const r1 = await pipeline.check('test_trace', 0)
    expect(r1).not.toBeNull()
    expect(r1!.runtimeAction).toBe('CONTINUE')

    // Turn 1 应该被 throttle（1 - 0 < 3）
    const r2 = await pipeline.check('test_trace', 1)
    expect(r2).toBeNull()

    // Turn 3 应该触发（3 - 0 >= 3）
    const r3 = await pipeline.check('test_trace', 3)
    expect(r3).not.toBeNull()
  })

  it('reset() 清除 throttle 状态', async () => {
    const repo = new InMemoryEvaluationRepository()
    repo.append(modelInvoked())
    repo.append(modelCompleted(50, 'hi'))

    const pipeline = new GuardrailPipeline(repo, undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 5 })
    await pipeline.check('test_trace', 0) // triggers
    await pipeline.check('test_trace', 2) // throttled
    expect(await pipeline.check('test_trace', 2)).toBeNull()

    pipeline.reset()
    // reset 后应该可以立即检测
    const r = await pipeline.check('test_trace', 2)
    expect(r).not.toBeNull()
  })

  it('带停滞 trace 的完整流 → terminate', async () => {
    const repo = new InMemoryEvaluationRepository()
    // 10 轮全部空转（无工具调用、无回复）
    for (let i = 0; i < 10; i++) {
      repo.append(
        makeEvent({ type: 'model.invoked', traceId: 'stuck_trace', payload: { type: 'model.invoked', modelName: 'm', promptLength: 10 } }),
      )
      repo.append(
        makeEvent({
          type: 'model.completed',
          traceId: 'stuck_trace',
          payload: { type: 'model.completed', modelName: 'm', durationMs: 100, inputTokens: 10, outputTokens: 1, responseLength: 0 },
        }),
      )
    }

    const pipeline = new GuardrailPipeline(repo, undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 })
    const result = await pipeline.check('stuck_trace', 10)
    expect(result).not.toBeNull()
    expect(result!.runtimeAction).toBe('TERMINATE')
    expect(result!.decision.reason).toContain('stalled')
  })

  it('存储异常时优雅降级（返回 null）', async () => {
    // 使用一个会抛错的 source
    const brokenSource = {
      getTrace: async () => {
        throw new Error('db down')
      },
    }
    const pipeline = new GuardrailPipeline(brokenSource, undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 })
    const result = await pipeline.check('any', 5)
    expect(result).toBeNull()
  })

  it('guardrail.checked 事件通过 emitter 写入', async () => {
    const repo = new InMemoryEvaluationRepository()
    repo.append(modelInvoked())
    repo.append(modelCompleted(100, 'hello'))

    const events: any[] = []
    const mockEmitter = { emit: (type: string, payload: any, meta?: any) => events.push({ type, payload, meta }) } as any
    const pipeline = new GuardrailPipeline(repo, undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 }, mockEmitter)

    const result = await pipeline.check('test_trace', 0)
    expect(result).not.toBeNull()

    const checkedEvent = events.find((e) => e.type === 'guardrail.checked')
    expect(checkedEvent).toBeDefined()
    expect(checkedEvent.payload.turn).toBe(0)
    expect(checkedEvent.payload.decision).toBe('continue')
    expect(checkedEvent.meta.traceId).toBe('test_trace')

    const terminatedEvent = events.find((e) => e.type === 'guardrail.terminated')
    expect(terminatedEvent).toBeUndefined()
  })

  it('terminate 时写入 guardrail.terminated', async () => {
    const repo = new InMemoryEvaluationRepository()
    for (let i = 0; i < 10; i++) {
      repo.append(
        makeEvent({ type: 'model.invoked', traceId: 'stuck2', payload: { type: 'model.invoked', modelName: 'm', promptLength: 10 } }),
      )
      repo.append(
        makeEvent({
          type: 'model.completed',
          traceId: 'stuck2',
          payload: { type: 'model.completed', modelName: 'm', durationMs: 100, inputTokens: 10, outputTokens: 1, responseLength: 0 },
        }),
      )
    }

    const events: any[] = []
    const mockEmitter = { emit: (type: string, payload: any, meta?: any) => events.push({ type, payload, meta }) } as any
    const pipeline = new GuardrailPipeline(repo, undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 1 }, mockEmitter)

    const result = await pipeline.check('stuck2', 10)
    expect(result).not.toBeNull()
    expect(result!.runtimeAction).toBe('TERMINATE')

    const terminatedEvent = events.find((e) => e.type === 'guardrail.terminated')
    expect(terminatedEvent).toBeDefined()
    expect(terminatedEvent.payload.turn).toBe(10)
    expect(terminatedEvent.payload.reason).toBeTruthy()
    expect(terminatedEvent.meta.traceId).toBe('stuck2')
  })
})
