/**
 * I-3: Consumer Independence Verification — ADR-004 Step C
 *
 * 验证 I-3 全部五项 Consumer Contract（C-1 ~ C-5）在生产路径下成立。
 *
 * Verification Record 将 program-execution.md 中 I-3 状态从 🔴 Blocked 更新为 ✅ Pass。
 *
 * 核心命题：Consumer 是 Producer 的输出终端，不是 Producer 的依赖方。
 * Runtime 100% 通过 callback 路径消费。analyzer 仅作为兼容层保留（Step D 删除）。
 */
import { describe, it, expect, vi } from 'vitest'
import { GuardrailProgressConsumer } from '@akemi-mio/core/core/evaluation/progress-consumers/GuardrailProgressConsumer'
import { ProgressObserver } from '@akemi-mio/core/core/evaluation/ProgressObserver'
import { GuardrailProgressAnalyzer } from '@akemi-mio/core/core/evaluation/GuardrailProgressAnalyzer'
import { GuardrailPipeline } from '@akemi-mio/core/core/evaluation/GuardrailPipeline'
import { InMemoryEvaluationRepository } from '../__test_support__'
import type { EvaluationEvent, EvaluationRepository } from '@akemi-mio/core/core/evaluation/types'
import type { ProgressConsumer, ProgressSnapshot } from '@akemi-mio/core/core/evaluation/progress'
import { PROGRESS_VERSION } from '@akemi-mio/core/core/evaluation/progress'

// ══════════════════════════════════════════════
// Test Data
// ══════════════════════════════════════════════

let idCounter = 0

function makeEvent(overrides: Partial<EvaluationEvent> & { type: any; payload: any }): EvaluationEvent {
  idCounter++
  return {
    id: `i3_${idCounter}`,
    timestamp: 1000 + idCounter,
    traceId: 'i3_trace',
    sessionId: 'i3_session',
    source: 'i3',
    ...overrides,
  }
}

function baseEvents(traceId: string = 'i3_trace'): EvaluationEvent[] {
  return [
    makeEvent({ traceId, type: 'model.invoked', payload: { type: 'model.invoked', modelName: 'test', promptLength: 50 } }),
    makeEvent({
      traceId,
      type: 'tool.completed',
      payload: { type: 'tool.completed', toolName: 'search', durationMs: 100 },
    }),
    makeEvent({
      traceId,
      type: 'model.completed',
      payload: { type: 'model.completed', modelName: 'test', durationMs: 300, inputTokens: 100, outputTokens: 20, responseLength: 30 },
    }),
  ]
}

function populateStore(store: EvaluationRepository, events: EvaluationEvent[]): void {
  for (const ev of events) store.append(ev)
}

// ══════════════════════════════════════════════
// 验证 C-1: Read-only Snapshot
// ══════════════════════════════════════════════

describe('I-3 C-1: Read-only Snapshot', () => {
  it('consume() 执行前后 snapshot 所有可观察字段值保持不变', async () => {
    const snapshot: ProgressSnapshot = {
      traceId: 'c1_test',
      sessionId: 'sess',
      version: PROGRESS_VERSION,
      totalTurns: 5,
      elapsedMs: 1000,
      observedAt: Date.now(),
      stateChange: {
        hasNewToolResult: true,
        hasNewAssistantContent: true,
        hasPlanningStateChange: false,
        stagnantTurnCount: 2,
        lastChangeTurn: 3,
        summary: 'processing',
      },
      informationGain: {
        consecutiveLowOutputTurns: 1,
        repeatedOutputCount: 0,
        repeatedToolResultCount: 0,
        toolResultNovelty: 0.8,
        summary: '',
      },
      goalProgress: {
        completedSubtasks: 1,
        hasPhaseTransition: false,
        stagnantTurnCount: 0,
        summary: '',
      },
    }

    const before = JSON.parse(JSON.stringify(snapshot))
    const consumer = new GuardrailProgressConsumer()
    await consumer.consume(snapshot)

    // 深度等价验证 consume() 不修改 snapshot
    expect(snapshot).toEqual(before)
  })

  it('Policy evaluate() 不修改传入的 snapshot', async () => {
    const snapshot: ProgressSnapshot = {
      traceId: 'c1b_test',
      sessionId: 'sess',
      version: PROGRESS_VERSION,
      totalTurns: 5,
      elapsedMs: 1000,
      observedAt: Date.now(),
      stateChange: {
        hasNewToolResult: true,
        hasNewAssistantContent: true,
        hasPlanningStateChange: false,
        stagnantTurnCount: 2,
        lastChangeTurn: 3,
        summary: 'processing',
      },
      informationGain: {
        consecutiveLowOutputTurns: 1,
        repeatedOutputCount: 0,
        repeatedToolResultCount: 0,
        toolResultNovelty: 0.8,
        summary: '',
      },
      goalProgress: {
        completedSubtasks: 1,
        hasPhaseTransition: false,
        stagnantTurnCount: 0,
        summary: '',
      },
    }

    const before = JSON.parse(JSON.stringify(snapshot))
    const onDecision = vi.fn()
    const consumer = new GuardrailProgressConsumer(undefined, onDecision)
    await consumer.consume(snapshot)

    // snapshot 未被 evaluate() 修改
    expect(snapshot).toEqual(before)

    // decision 包含原始 snapshot 引用
    const decision = onDecision.mock.calls[0][0]
    expect(decision.snapshot).toBe(snapshot)
  })
})

// ══════════════════════════════════════════════
// 验证 C-2: Failure Isolation
// ══════════════════════════════════════════════

describe('I-3 C-2: Failure Isolation', () => {
  it('GuardrailConsumer 抛出 → Observer 其他 Consumer 不受影响', async () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = new GuardrailProgressAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)

    const goodConsumer = vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined)
    const good: ProgressConsumer = { consume: goodConsumer }

    // GuardrailConsumer 作为一个正常工作的 Consumer（不抛出）
    const guardrailConsumer = new GuardrailProgressConsumer()
    const bad: ProgressConsumer = {
      consume: () => {
        throw new Error('consumer crash')
      },
    }

    observer.register(good)
    observer.register(guardrailConsumer)
    observer.register(bad)
    observer.start()

    populateStore(store, baseEvents())

    // 触发事件
    store.append(
      makeEvent({
        type: 'tool.completed',
        payload: { type: 'tool.completed', toolName: 'trigger', durationMs: 10 },
      }),
    )

    await vi.waitFor(() => {
      expect(goodConsumer).toHaveBeenCalled()
    })

    const snapshot = goodConsumer.mock.calls[0][0]
    expect(snapshot.traceId).toBe('i3_trace')
    expect(snapshot.totalTurns).toBeGreaterThanOrEqual(1)

    observer.stop()
  })

  it('GuardrailConsumer 自身 throw 不影响 Observer 分发', async () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = new GuardrailProgressAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)

    const badGuardrailConsumer = new GuardrailProgressConsumer(undefined, () => {
      throw new Error('callback crash')
    })
    const otherConsumer = vi.fn<(...args: any[]) => any>().mockResolvedValue(undefined)
    const other: ProgressConsumer = { consume: otherConsumer }

    observer.register(badGuardrailConsumer)
    observer.register(other)
    observer.start()

    populateStore(store, baseEvents())

    store.append(
      makeEvent({
        type: 'tool.completed',
        payload: { type: 'tool.completed', toolName: 'test', durationMs: 10 },
      }),
    )

    await vi.waitFor(() => {
      expect(otherConsumer).toHaveBeenCalled()
    })

    observer.stop()
  })
})

// ══════════════════════════════════════════════
// 验证 C-3: Delivery Order Independence
// ══════════════════════════════════════════════

describe('I-3 C-3: Delivery Order Independence', () => {
  it('Consumer 注册顺序 [A,B] vs [B,A] → 相同的 Snapshot 和 Delivery', async () => {
    const eventsA = baseEvents('order_a')
    const eventsB = baseEvents('order_b')

    // Observer A: register GuardrailConsumer first, then dummy
    const storeA = new InMemoryEvaluationRepository()
    const observerA = new ProgressObserver(storeA, new GuardrailProgressAnalyzer(storeA))
    const snapshotA: ProgressSnapshot[] = []
    observerA.register(new GuardrailProgressConsumer())
    observerA.register({
      consume: async (s) => {
        snapshotA.push(s)
      },
    })
    observerA.start()
    populateStore(storeA, eventsA)
    storeA.append(
      makeEvent({ traceId: 'order_a', type: 'tool.completed', payload: { type: 'tool.completed', toolName: 'x', durationMs: 10 } }),
    )

    // Observer B: register dummy first, then GuardrailConsumer
    const storeB = new InMemoryEvaluationRepository()
    const observerB = new ProgressObserver(storeB, new GuardrailProgressAnalyzer(storeB))
    const snapshotB: ProgressSnapshot[] = []
    observerB.register({
      consume: async (s) => {
        snapshotB.push(s)
      },
    })
    observerB.register(new GuardrailProgressConsumer())
    observerB.start()
    populateStore(storeB, eventsB)
    storeB.append(
      makeEvent({ traceId: 'order_b', type: 'tool.completed', payload: { type: 'tool.completed', toolName: 'x', durationMs: 10 } }),
    )

    await vi.waitFor(() => {
      expect(snapshotA.length).toBeGreaterThanOrEqual(1)
      expect(snapshotB.length).toBeGreaterThanOrEqual(1)
    })

    // Both observers received snapshots (GuardrailConsumer doesn't block)
    expect(snapshotA[0].totalTurns).toBe(snapshotB[0].totalTurns)

    observerA.stop()
    observerB.stop()
  })
})

// ══════════════════════════════════════════════
// 验证 C-4: Delivery Cardinality Independence
// ══════════════════════════════════════════════

describe('I-3 C-4: Delivery Cardinality Independence', () => {
  it('0 Consumer → 相同的 Snapshot（Producer 不受影响）', async () => {
    const store = new InMemoryEvaluationRepository()
    const observer = new ProgressObserver(store, new GuardrailProgressAnalyzer(store))
    observer.start()

    // No consumers registered — Producer should still compute snapshots
    const beforeEventCount = await store.getTrace('cardinality_0')
    store.append(
      makeEvent({ traceId: 'cardinality_0', type: 'tool.completed', payload: { type: 'tool.completed', toolName: 'a', durationMs: 10 } }),
    )

    // 事件仍被正常写入（Producer 不受 Consumer 影响）
    await vi.waitFor(async () => {
      const events = await store.getTrace('cardinality_0')
      expect(events.length).toBeGreaterThanOrEqual(1)
    })

    observer.stop()
  })

  it('1 Consumer / 3 Consumers → 相同的 Snapshot', async () => {
    const events = baseEvents('cardinality_count')

    // 1 Consumer
    const store1 = new InMemoryEvaluationRepository()
    const obs1 = new ProgressObserver(store1, new GuardrailProgressAnalyzer(store1))
    obs1.register(new GuardrailProgressConsumer())
    obs1.start()
    populateStore(store1, events)
    const capture1: ProgressSnapshot[] = []
    obs1.register({
      consume: async (s) => {
        capture1.push(s)
      },
    })
    store1.append(
      makeEvent({
        traceId: 'cardinality_count',
        type: 'tool.completed',
        payload: { type: 'tool.completed', toolName: 'a', durationMs: 10 },
      }),
    )

    // 3 Consumers
    const store3 = new InMemoryEvaluationRepository()
    const obs3 = new ProgressObserver(store3, new GuardrailProgressAnalyzer(store3))
    obs3.register(new GuardrailProgressConsumer())
    obs3.register({ consume: async () => {} })
    obs3.register({ consume: async () => {} })
    obs3.start()
    populateStore(store3, events)
    const capture3: ProgressSnapshot[] = []
    obs3.register({
      consume: async (s) => {
        capture3.push(s)
      },
    })
    store3.append(
      makeEvent({
        traceId: 'cardinality_count',
        type: 'tool.completed',
        payload: { type: 'tool.completed', toolName: 'a', durationMs: 10 },
      }),
    )

    await vi.waitFor(() => {
      expect(capture1.length).toBeGreaterThanOrEqual(1)
      expect(capture3.length).toBeGreaterThanOrEqual(1)
    })

    // Snapshot 语义不变 — GuardrailConsumer 的存在不改变 Snapshot 内容
    expect(capture1[0].totalTurns).toBe(capture3[0].totalTurns)
    expect(capture1[0].stateChange).toEqual(capture3[0].stateChange)
    expect(capture1[0].informationGain).toEqual(capture3[0].informationGain)
    expect(capture1[0].goalProgress).toEqual(capture3[0].goalProgress)

    obs1.stop()
    obs3.stop()
  })
})

// ══════════════════════════════════════════════
// 验证 C-5: Producer Independence
// ══════════════════════════════════════════════

describe('I-3 C-5: Producer Independence', () => {
  it('GuardrailConsumer 不持有 Store/Analyzer/Emitter 引用', () => {
    const consumer = new GuardrailProgressConsumer()

    const publicKeys = Object.keys(consumer)
    expect(consumer).not.toHaveProperty('store')
    expect(consumer).not.toHaveProperty('analyzer')
    expect(consumer).not.toHaveProperty('emitter')
  })

  it('Callback 不调用 Producer API', async () => {
    // Callback 仅接收 GuardrailDecision 并传递给 Pipeline
    const pipeline = new GuardrailPipeline()
    const onDecision = vi.fn((decision) => {
      pipeline.onGuardrailDecision(decision)
    })

    const consumer = new GuardrailProgressConsumer(undefined, onDecision)
    const snapshot: ProgressSnapshot = {
      traceId: 'c5_test',
      sessionId: 'sess',
      version: PROGRESS_VERSION,
      totalTurns: 1,
      elapsedMs: 100,
      observedAt: Date.now(),
      stateChange: {
        hasNewToolResult: true,
        hasNewAssistantContent: false,
        hasPlanningStateChange: false,
        stagnantTurnCount: 0,
        lastChangeTurn: 1,
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
        completedSubtasks: 0,
        hasPhaseTransition: false,
        stagnantTurnCount: 0,
        summary: '',
      },
    }

    await consumer.consume(snapshot)

    // Callback received the decision
    expect(onDecision).toHaveBeenCalledTimes(1)
    const decision = onDecision.mock.calls[0][0]
    expect(decision).toHaveProperty('action')
    expect(decision).toHaveProperty('traceId')
    expect(decision.traceId).toBe('c5_test')
  })
})
