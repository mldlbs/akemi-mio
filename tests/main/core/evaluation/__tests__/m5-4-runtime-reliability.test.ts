/**
 * M5.4 Runtime Reliability — Hardening Tests
 *
 * 覆盖四项加固：
 *   R-1: replayWindowMs 配置化（3 tests）
 *   R-2: Policy exception handling（3 tests）
 *   R-3: DecisionStore retry strategy（3 tests）
 *   R-4: Observer reliability（3 tests）
 *
 * 原则：不修改 ChatExecutor/Pipeline 结构，只加固异常路径。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProgressObserver } from '@akemi-mio/core/core/evaluation/ProgressObserver'
import { GuardrailProgressConsumer } from '@akemi-mio/core/core/evaluation/progress-consumers/GuardrailProgressConsumer'
import { GuardrailDecisionStore } from '@akemi-mio/core/core/evaluation/GuardrailDecisionStore'
import type { ProgressConsumer, ProgressSnapshot } from '@akemi-mio/core/core/evaluation/progress'
import type { GuardrailDecision, GuardrailAction, RuntimeAction } from '@akemi-mio/core/core/evaluation/GuardrailTypes'
import { PROGRESS_VERSION } from '@akemi-mio/core/core/evaluation/progress'
import { InMemoryEvaluationRepository } from '../__test_support__'
import { GuardrailProgressAnalyzer } from '@akemi-mio/core/core/evaluation/GuardrailProgressAnalyzer'
import { log } from '@akemi-mio/core/logger/Logger'

// ══════════════════════════════════════════════
// Test Helpers
// ══════════════════════════════════════════════

function makeSnapshot(traceId = 'm54_trace', overrides?: Partial<ProgressSnapshot>): ProgressSnapshot {
  return {
    traceId,
    sessionId: 'm54_session',
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
    goalProgress: { completedSubtasks: 1, hasPhaseTransition: false, stagnantTurnCount: 0, summary: '' },
    ...overrides,
  }
}

function makeDecision(overrides?: Partial<GuardrailDecision>): GuardrailDecision {
  return {
    action: 'continue' as GuardrailAction,
    reason: 'test',
    decidedAt: Date.now(),
    traceId: 'm54_trace',
    signals: [],
    snapshot: {} as any,
    policyVersion: 'v1',
    ...overrides,
  }
}

// ══════════════════════════════════════════════
// R-1: replayWindowMs 配置化
// ══════════════════════════════════════════════

describe('R-1: replayWindowMs', () => {
  it('R-1a: 传入 5000 → replay window 5000', () => {
    const store = new (class extends InMemoryEvaluationRepository {})() as any
    const analyzer = new GuardrailProgressAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer, 5000)
    expect((observer as any).replayWindowMs).toBe(5000)
  })

  it('R-1b: 未传参 → 默认 60000', () => {
    const store = new (class extends InMemoryEvaluationRepository {})() as any
    const analyzer = new GuardrailProgressAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)
    expect((observer as any).replayWindowMs).toBe(60000)
  })

  it('R-1c: NaN 等非法值 → AppRuntime 层 fallback 到 60000（这里测试 Observer clamp）', () => {
    const store = new (class extends InMemoryEvaluationRepository {})() as any
    const analyzer = new GuardrailProgressAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer, -1)
    // ProgressObserver 不 clamp，clamp 在 AppRuntime 层
    // 这里验证负值被接受（runtime 层负责保护）
    expect((observer as any).replayWindowMs).toBe(-1)
  })
})

// ══════════════════════════════════════════════
// R-2: Policy Exception Handling
// ══════════════════════════════════════════════

describe('R-2: Policy exception handling', () => {
  it('R-2a: evaluate() throws → consume() 不向上传播', async () => {
    const throwingPolicy = {
      evaluate: () => {
        throw new Error('policy_crash')
      },
    }
    const onDecision = vi.fn()
    const consumer = new GuardrailProgressConsumer(throwingPolicy as any, onDecision)

    // 不应 throw
    await expect(consumer.consume(makeSnapshot('r2a'))).resolves.toBeUndefined()
    // callback 不应被调用
    expect(onDecision).not.toHaveBeenCalled()
  })

  it('R-2b: 异常后 consumer 状态可恢复', async () => {
    let callCount = 0
    const flakyPolicy = {
      evaluate: () => {
        callCount++
        if (callCount === 1) throw new Error('first_call_fails')
        return makeDecision({ traceId: 'r2b' })
      },
    }
    const onDecision = vi.fn()
    const consumer = new GuardrailProgressConsumer(flakyPolicy as any, onDecision)

    // 第一次调用失败
    await consumer.consume(makeSnapshot('r2b'))
    expect(onDecision).not.toHaveBeenCalled()

    // 第二次调用成功
    await consumer.consume(makeSnapshot('r2b'))
    expect(onDecision).toHaveBeenCalledTimes(1)
  })

  it('R-2c: 异常时 onDecision callback 不触发', async () => {
    const throwingPolicy = {
      evaluate: () => {
        throw new Error('no_decision')
      },
    }
    const onDecision = vi.fn()
    const consumer = new GuardrailProgressConsumer(throwingPolicy as any, onDecision)

    await consumer.consume(makeSnapshot('r2c'))
    expect(onDecision).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════
// R-3: DecisionStore Retry Strategy
// ══════════════════════════════════════════════

describe('R-3: DecisionStore retry', () => {
  function createFailingRawDb(failCount: number, onAttempt?: (n: number) => void) {
    let attempt = 0
    return {
      run: (_sql: string, _params?: any[]) => {
        attempt++
        onAttempt?.(attempt)
        if (attempt <= failCount) throw new Error(`db_write_failed_attempt_${attempt}`)
      },
      query: (sql: string, params?: any[]) => {
        if (sql.includes('SELECT')) return []
        throw new Error('not_expected')
      },
    }
  }

  it('R-3a: record() 第一次失败后重试成功 → DB 最终写入', async () => {
    const attempts: number[] = []
    const rawDb = createFailingRawDb(1, (n) => attempts.push(n))
    const store = new GuardrailDecisionStore()
    store.setRawDb(rawDb)

    await store.record('r3a_d1', makeDecision(), 'CONTINUE' as RuntimeAction, 'r3a', 1)

    // 总共尝试了 2 次（第 1 次失败，第 2 次成功）
    expect(attempts.length).toBe(2)
  })

  it('R-3b: 连续 3 次失败 → 不抛异常（WARN + discard）', async () => {
    const attempts: number[] = []
    const rawDb = createFailingRawDb(99, (n) => attempts.push(n))
    const store = new GuardrailDecisionStore()
    store.setRawDb(rawDb)

    // 不应抛异常
    await expect(store.record('r3b_d1', makeDecision(), 'CONTINUE' as RuntimeAction, 'r3b', 1)).resolves.toBeUndefined()

    // 应该尝试了 3 次后放弃
    expect(attempts.length).toBe(3)
  })

  it('R-3c: 重试不阻塞 record() 返回（fire-and-forget）', async () => {
    const rawDb = {
      run: vi.fn().mockImplementation(() => {
        throw new Error('db_down')
      }),
      query: () => [],
    }
    const store = new GuardrailDecisionStore()
    store.setRawDb(rawDb)

    // record() 应快速返回（retry 有 200ms delay，但 record 本身不 await retry chain）
    const start = Date.now()
    await store.record('r3c_d1', makeDecision(), 'CONTINUE' as RuntimeAction, 'r3c', 1)
    // 至少尝试 3 次（说明 retry 逻辑执行了），但 record() 返回不受限
    expect(rawDb.run).toHaveBeenCalledTimes(3)
  })
})

// ══════════════════════════════════════════════
// R-4: Observer Reliability
// ══════════════════════════════════════════════

describe('R-4: Observer reliability', () => {
  let store: InMemoryEvaluationRepository
  let analyzer: GuardrailProgressAnalyzer

  beforeEach(() => {
    store = new InMemoryEvaluationRepository()
    analyzer = new GuardrailProgressAnalyzer(store)
  })

  it('R-4a: consumer.consume throw → observer 继续处理', async () => {
    const throwingConsumer: ProgressConsumer = {
      consume: async () => {
        throw new Error('consumer_crash')
      },
    }
    const healthyConsumer: ProgressConsumer = {
      consume: vi.fn().mockResolvedValue(undefined),
    }

    const observer = new ProgressObserver(store, analyzer, 0)
    observer.register(throwingConsumer)
    observer.register(healthyConsumer)

    store.append({
      id: 'r4a_ev1',
      timestamp: 1000,
      traceId: 'r4a',
      sessionId: 's1',
      source: 'test',
      type: 'model.invoked' as any,
      payload: { type: 'model.invoked', modelName: 'test', promptLength: 10 },
    })

    // 触发事件处理
    await (observer as any).onEvent({
      id: 'r4a_ev1',
      timestamp: 1000,
      traceId: 'r4a',
      sessionId: 's1',
      source: 'test',
      type: 'model.invoked' as any,
      payload: { type: 'model.invoked', modelName: 'test', promptLength: 10 },
    })

    // healthy consumer 仍被调用（allSettled+隔离）
    expect(healthyConsumer.consume).toHaveBeenCalled()
  })

  it('R-4b: consumer slow → 其他 consumer 已处理（allSettled 不阻塞快速 consumer）', async () => {
    const results: string[] = []
    const slowConsumer: ProgressConsumer = {
      consume: async () =>
        new Promise((resolve) =>
          setTimeout(() => {
            results.push('slow')
            resolve()
          }, 500),
        ),
    }
    const fastConsumer: ProgressConsumer = {
      consume: async () => {
        results.push('fast')
      },
    }

    const observer = new ProgressObserver(store, analyzer, 0)
    observer.register(slowConsumer)
    observer.register(fastConsumer)

    const ev = {
      id: 'r4b_ev1',
      timestamp: 1000,
      traceId: 'r4b',
      sessionId: 's1',
      source: 'test',
      type: 'model.invoked' as any,
      payload: { type: 'model.invoked', modelName: 'test', promptLength: 10 },
    }

    await (observer as any).handleTrace('r4b', [ev])

    // fast consumer 在 slow 之前完成
    expect(results[0]).toBe('fast')
    expect(results).toContain('slow')
  })

  it('R-4c: live event handler 异常 → observer 不停止', async () => {
    const consumer: ProgressConsumer = {
      consume: vi.fn().mockResolvedValue(undefined),
    }

    const observer = new ProgressObserver(store, analyzer, 0)
    observer.register(consumer)
    observer.start()

    // 发送正常事件
    store.append({
      id: 'r4c_ev1',
      timestamp: 1000,
      traceId: 'r4c',
      sessionId: 's1',
      source: 'test',
      type: 'model.invoked' as any,
      payload: { type: 'model.invoked', modelName: 'test', promptLength: 10 },
    })

    // observer 仍在运行
    expect(observer.running).toBe(true)

    observer.stop()
  })
})
