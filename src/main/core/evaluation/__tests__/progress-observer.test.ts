/**
 * ProgressObserver Tests — 验证 Event Pipeline Observer 契约
 *
 * 覆盖范围（Phase A 五项验收标准）：
 * 1. Observer Registration — Runtime 正确注册
 * 2. Event Subscription — 正确订阅 evaluation.event
 * 3. Producer Invocation — 每个事件触发一次 compute()
 * 4. Consumer Dispatch — 多 Consumer 正常分发且错误隔离
 * 5. Boundary — 无 ChatExecutor 依赖，无反向调用
 */

import { describe, it, expect, vi } from 'vitest'
import { ProgressObserver } from '../ProgressObserver'
import { InMemoryEvaluationRepository } from '../__test_support__'
import type { EvaluationEvent, EvaluationRepository } from '../types'
import type { ProgressAnalyzer, ProgressConsumer, ProgressSnapshot } from '../progress'
import { PROGRESS_VERSION } from '../progress'

// ══════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════

function makeEvent(overrides: Partial<EvaluationEvent> & { type: any; payload: any }): EvaluationEvent {
  return {
    id: `e_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    traceId: 'test_trace',
    sessionId: 'test_session',
    source: 'test',
    ...overrides,
  }
}

function makeAnalyzer(store: EvaluationRepository): ProgressAnalyzer & { computeMock: ReturnType<typeof vi.fn> } {
  const computeMock = vi.fn(
    (traceId: string, events: EvaluationEvent[]): ProgressSnapshot => ({
      traceId,
      sessionId: events[0]?.sessionId ?? '',
      version: PROGRESS_VERSION,
      totalTurns: 0,
      elapsedMs: 0,
      observedAt: 0,
      stateChange: {
        hasNewToolResult: false,
        hasNewAssistantContent: false,
        hasPlanningStateChange: false,
        stagnantTurnCount: 0,
        lastChangeTurn: -1,
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
    }),
  )

  return {
    analyze: vi.fn(),
    compute: computeMock,
    computeMock,
  } as any
}

// ══════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════

describe('ProgressObserver', () => {
  it('1. Registration — start 后订阅事件流', () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = makeAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)

    expect(observer.running).toBe(false)

    observer.start()
    expect(observer.running).toBe(true)

    observer.stop()
    expect(observer.running).toBe(false)
  })

  it('2. Producer Invocation — 事件触发 compute()', async () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = makeAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)

    observer.start()

    const event = makeEvent({
      type: 'tool.completed',
      traceId: 'trace1',
      payload: { type: 'tool.completed', toolName: 'test', durationMs: 10 },
    })
    store.append(event)

    // Wait for async handler
    await vi.waitFor(() => {
      expect(analyzer.computeMock).toHaveBeenCalledTimes(1)
    })

    const callArgs = analyzer.computeMock.mock.calls[0]
    expect(callArgs[0]).toBe('trace1') // traceId
    expect(callArgs[1]).toHaveLength(1) // events array
    expect(callArgs[1][0].traceId).toBe('trace1')

    observer.stop()
  })

  it('3. Consumer Dispatch — Snapshot 分发到所有 Consumer', async () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = makeAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)

    const consumer1 = { consume: vi.fn() }
    const consumer2 = { consume: vi.fn() }

    observer.register(consumer1)
    observer.register(consumer2)
    observer.start()

    const event = makeEvent({
      type: 'model.completed',
      traceId: 'trace1',
      payload: { type: 'model.completed', modelName: 'test', durationMs: 10, inputTokens: 0, outputTokens: 0, responseLength: 10 },
    })
    store.append(event)

    await vi.waitFor(() => {
      expect(consumer1.consume).toHaveBeenCalledTimes(1)
      expect(consumer2.consume).toHaveBeenCalledTimes(1)
    })

    const snapshot = consumer1.consume.mock.calls[0][0]
    expect(snapshot.traceId).toBe('trace1')

    observer.stop()
  })

  it('4. Consumer Error Isolation — 一个 Consumer 异常不影响其他', async () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = makeAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)

    const goodConsumer = { consume: vi.fn() }
    const badConsumer = { consume: vi.fn().mockRejectedValue(new Error('consumer error')) }

    observer.register(goodConsumer)
    observer.register(badConsumer)
    observer.start()

    const event = makeEvent({
      type: 'tool.completed',
      traceId: 'trace1',
      payload: { type: 'tool.completed', toolName: 'test', durationMs: 10 },
    })
    store.append(event)

    await vi.waitFor(() => {
      expect(goodConsumer.consume).toHaveBeenCalledTimes(1)
      expect(badConsumer.consume).toHaveBeenCalledTimes(1)
    })

    observer.stop()
  })

  it('5. Multiple traceId events — 每个 traceId 独立 compute', async () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = makeAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)

    observer.start()

    store.append(
      makeEvent({ type: 'tool.completed', traceId: 'trace1', payload: { type: 'tool.completed', toolName: 'a', durationMs: 10 } }),
    )
    store.append(
      makeEvent({ type: 'tool.completed', traceId: 'trace2', payload: { type: 'tool.completed', toolName: 'b', durationMs: 20 } }),
    )

    await vi.waitFor(() => {
      expect(analyzer.computeMock).toHaveBeenCalledTimes(2)
    })

    const traceIds = analyzer.computeMock.mock.calls.map((c: any[]) => c[0])
    expect(traceIds).toContain('trace1')
    expect(traceIds).toContain('trace2')

    observer.stop()
  })

  it('6. Events without traceId are ignored', async () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = makeAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)

    observer.start()

    store.append(makeEvent({ type: 'tool.completed', traceId: '', payload: { type: 'tool.completed', toolName: 'a', durationMs: 10 } }))

    // Small delay to ensure handler runs
    await new Promise((r) => setTimeout(r, 100))
    expect(analyzer.computeMock).not.toHaveBeenCalled()

    observer.stop()
  })

  it('7. Boundary — 无 ChatExecutor 依赖', () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = makeAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)

    // ProgressObserver should not reference ChatExecutor
    const src = ProgressObserver.toString()
    expect(src).not.toContain('ChatExecutor')
    expect(src).not.toContain('chat')

    observer.stop()
  })

  it('8. Unregister consumer — 移除后不再接收分发', async () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = makeAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)

    const consumer = { consume: vi.fn() }
    observer.register(consumer)
    observer.unregister(consumer)
    observer.start()

    store.append(
      makeEvent({ type: 'tool.completed', traceId: 'trace1', payload: { type: 'tool.completed', toolName: 'a', durationMs: 10 } }),
    )

    await new Promise((r) => setTimeout(r, 100))
    expect(consumer.consume).not.toHaveBeenCalled()

    observer.stop()
  })
})
