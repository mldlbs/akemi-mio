import { describe, it, expect, vi } from 'vitest'
import { InMemoryEvaluationRepository } from '../__test_support__'
import { ProgressObserver } from '../ProgressObserver'
import { GuardrailProgressAnalyzer } from '../GuardrailProgressAnalyzer'
import type { EvaluationEvent } from '../types'
import type { ProgressConsumer, ProgressSnapshot } from '../progress'

/** 简单 consumer：记录收到的 snapshot */
function makeCollector(): { snapshots: ProgressSnapshot[]; consumer: ProgressConsumer } {
  const snapshots: ProgressSnapshot[] = []
  const consumer: ProgressConsumer = {
    async consume(snapshot: ProgressSnapshot) {
      snapshots.push(snapshot)
    },
  }
  return { snapshots, consumer }
}

describe('ProgressObserver startup catch-up', () => {
  it('空 store → catchup 不报错', async () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = new GuardrailProgressAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)
    const { consumer } = makeCollector()
    observer.register(consumer)

    await observer.start()
    expect(observer.running).toBe(true)
    observer.stop()
  })

  it('有近期事件 → catchup 触发 compute', async () => {
    const store = new InMemoryEvaluationRepository()
    const now = Date.now()

    // 写入一个简单的 trace
    store.append({
      id: 'e1',
      timestamp: now - 1000,
      traceId: 'catchup_trace',
      sessionId: 's1',
      source: 'test',
      type: 'model.invoked',
      payload: { type: 'model.invoked', modelName: 'test', promptLength: 10 },
    })
    store.append({
      id: 'e2',
      timestamp: now - 500,
      traceId: 'catchup_trace',
      sessionId: 's1',
      source: 'test',
      type: 'model.completed',
      payload: { type: 'model.completed', modelName: 'test', durationMs: 100, inputTokens: 10, outputTokens: 20, responseLength: 50 },
    })

    const analyzer = new GuardrailProgressAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)
    const { snapshots, consumer } = makeCollector()
    observer.register(consumer)

    await observer.start()
    observer.stop()

    // catchup 应该产生了 snapshot
    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots[0].traceId).toBe('catchup_trace')
    expect(snapshots[0].totalTurns).toBe(1)
  })

  it('旧事件（超出窗口）→ 不触发 catchup', async () => {
    const store = new InMemoryEvaluationRepository()
    const oldTs = Date.now() - 120_000 // 2 分钟前

    store.append({
      id: 'e_old',
      timestamp: oldTs,
      traceId: 'old_trace',
      sessionId: 's1',
      source: 'test',
      type: 'model.invoked',
      payload: { type: 'model.invoked', modelName: 'test', promptLength: 10 },
    })

    // 使用短窗口：1 秒
    const analyzer = new GuardrailProgressAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer, 1000)
    const { snapshots, consumer } = makeCollector()
    observer.register(consumer)

    await observer.start()
    observer.stop()

    // 旧事件不应触发 catchup
    expect(snapshots.length).toBe(0)
  })
})
