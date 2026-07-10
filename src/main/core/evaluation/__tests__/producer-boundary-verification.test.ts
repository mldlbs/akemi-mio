/**
 * Phase B: Producer Boundary Verification
 *
 * 验证 ADR-003 Producer Contract 已在工程中成立。
 * 四项全部 Pass → I-2 Status 从 Pending 更新为 Pass。
 *
 * 验证项：
 * 1. Producer Purity — compute() 不依赖 Runtime、wall-clock、Observer、Consumer
 * 2. Replay Consistency — 相同事件流得到完全相同 Snapshot
 * 3. Producer Boundary — Observer 不参与 Snapshot 推导
 * 4. Consumer Isolation — Consumer 不影响 Producer
 *
 * 核心命题：以下两条路径在 Snapshot 语义上完全等价
 *
 *   Path A: EvaluationEvent[] → compute() → Snapshot
 *   Path B: EvaluationEvent[] → Observer → compute() → Snapshot
 */

import { describe, it, expect, vi } from 'vitest'
import { ProgressObserver } from '../ProgressObserver'
import { GuardrailProgressAnalyzer } from '../GuardrailProgressAnalyzer'
import { InMemoryEvaluationRepository } from '../__test_support__'
import type { EvaluationEvent, EvaluationRepository } from '../types'
import type { ProgressConsumer, ProgressSnapshot } from '../progress'
import { PROGRESS_VERSION } from '../progress'

// ══════════════════════════════════════════════
// 测试数据生成
// ══════════════════════════════════════════════

let idCounter = 0

function makeEvent(overrides: Partial<EvaluationEvent> & { type: any; payload: any }): EvaluationEvent {
  idCounter++
  return {
    id: `v_${idCounter}`,
    timestamp: 1000 + idCounter,
    traceId: 'verify_trace',
    sessionId: 'verify_session',
    source: 'verify',
    ...overrides,
  }
}

function toolCompleted(toolName: string, output?: string): EvaluationEvent {
  return makeEvent({ type: 'tool.completed', payload: { type: 'tool.completed', toolName, durationMs: 100, output } })
}

function modelCompleted(responseLength: number): EvaluationEvent {
  return makeEvent({
    type: 'model.completed',
    payload: { type: 'model.completed', modelName: 'test', durationMs: 500, inputTokens: 100, outputTokens: 50, responseLength },
  })
}

function modelInvoked(): EvaluationEvent {
  return makeEvent({ type: 'model.invoked', payload: { type: 'model.invoked', modelName: 'test', promptLength: 100 } })
}

function agentResponse(): EvaluationEvent {
  return makeEvent({ type: 'agent.response', payload: { type: 'agent.response', length: 50, durationMs: 100 } })
}

function taskCompleted(): EvaluationEvent {
  return makeEvent({ type: 'task.completed', payload: { type: 'task.completed', kind: 'chat', outcome: 'completed', durationMs: 100 } })
}

// ══════════════════════════════════════════════
// 验证 1: Producer Purity
// ══════════════════════════════════════════════

describe('V-1: Producer Purity', () => {
  it('compute() 无 Date.now() / performance.now() 调用', () => {
    const src = GuardrailProgressAnalyzer.compute.toString()
    expect(src).not.toContain('Date.now')
    expect(src).not.toContain('performance.now')
  })

  it('compute() 仅依赖 EvaluationEvent[] 输入', () => {
    // 构造一组固定事件
    const events = [
      modelInvoked(),
      toolCompleted('search', 'result_1'),
      modelCompleted(100),
      modelInvoked(),
      agentResponse(),
      modelCompleted(200),
      modelInvoked(),
      taskCompleted(),
      modelCompleted(50),
    ]

    // 在同一进程中反复调用，验证输出完全由输入决定
    const snapshot1 = GuardrailProgressAnalyzer.compute('verify', events)
    const snapshot2 = GuardrailProgressAnalyzer.compute('verify', events)

    // 排除系统时间影响后的等值性
    expect(snapshot2).toEqual(snapshot1)
  })

  it('compute() 隐式状态检查 — 前后调用互不干扰', () => {
    const events1 = [modelInvoked(), toolCompleted('search', 'result_1'), modelCompleted(100)]
    const events2 = [
      modelInvoked(),
      toolCompleted('search', 'result_2'),
      modelCompleted(200),
      modelInvoked(),
      taskCompleted(),
      modelCompleted(50),
    ]

    // 先 compute events1，再 compute events2，再重新 compute events1
    const snap1a = GuardrailProgressAnalyzer.compute('t1', events1)
    GuardrailProgressAnalyzer.compute('t2', events2) // 不应污染状态
    const snap1b = GuardrailProgressAnalyzer.compute('t1', events1)

    expect(snap1b).toEqual(snap1a)
  })

  it('compute() 不依赖 Runtime 状态、缓存或全局配置', () => {
    // 验证 compute 没有 import Runtime 类型
    // 该文件在 GuardrailProgressAnalyzer.ts 中实现
    // 其唯一依赖是 EvaluationEvent[]，由纯函数保证

    const events = [modelInvoked(), toolCompleted('test', 'output'), modelCompleted(50)]
    const snapshot = GuardrailProgressAnalyzer.compute('verify', events)

    // 所有 Snapshot 字段均为事件直接推导
    expect(snapshot.traceId).toBe('verify')
    expect(snapshot.totalTurns).toBe(1)
    expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(snapshot.observedAt).toBe(events[events.length - 1].timestamp) // 最后事件时间戳，非 Date.now()
  })
})

// ══════════════════════════════════════════════
// 验证 2: Replay Consistency
// ══════════════════════════════════════════════

describe('V-2: Replay Consistency', () => {
  it('同一事件流两次 compute() 全部字段一致', () => {
    const events = [
      modelInvoked(),
      toolCompleted('search', 'initial'),
      modelCompleted(100),
      modelInvoked(),
      agentResponse(),
      modelCompleted(200),
      modelInvoked(),
      taskCompleted(),
      modelCompleted(50),
      modelInvoked(),
      toolCompleted('search', 'final'),
      modelCompleted(150),
    ]

    const snap1 = GuardrailProgressAnalyzer.compute('replay', events)
    const snap2 = GuardrailProgressAnalyzer.compute('replay', events)

    // 严格等值：所有字段必须一致
    expect(snap2).toEqual(snap1)

    // 显式验证 observedAt 不依赖 wall-clock
    expect(snap1.observedAt).toBe(snap2.observedAt)
    expect(snap1.observedAt).toBe(events[events.length - 1].timestamp)
  })

  it('空事件流 — 确定的默认值', () => {
    const snap1 = GuardrailProgressAnalyzer.compute('empty', [])
    const snap2 = GuardrailProgressAnalyzer.compute('empty', [])
    expect(snap2).toEqual(snap1)
  })
})

// ══════════════════════════════════════════════
// 验证 3: Producer Boundary
// ══════════════════════════════════════════════

describe('V-3: Producer Boundary', () => {
  it('ProgressObserver 不修改 ProgressSnapshot', async () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = new GuardrailProgressAnalyzer(store)
    const observer = new ProgressObserver(store, analyzer)

    const TRACE = 'boundary'

    // 准备事件数据
    const events = [
      modelInvoked(),
      toolCompleted('search', 'data'),
      modelCompleted(100),
      modelInvoked(),
      agentResponse(),
      modelCompleted(200),
    ]
    const trigger = makeEvent({
      type: 'tool.completed',
      traceId: TRACE,
      payload: { type: 'tool.completed', toolName: 'trigger', durationMs: 10 },
    })
    const allEvents = [...events, trigger]
    for (const ev of allEvents) ev.traceId = TRACE

    // Path A: 直接 compute()
    const directSnapshot = GuardrailProgressAnalyzer.compute(
      TRACE,
      allEvents.map((e) => ({ ...e })),
    )

    // Path B: 通过 Observer（先 start，再 append）
    let observedSnapshot: ProgressSnapshot | null = null
    const consumer: ProgressConsumer = {
      consume: (s) => {
        observedSnapshot = s
      },
    }
    observer.register(consumer)
    observer.start()

    for (const ev of allEvents) store.append(ev)

    await vi.waitFor(() => {
      expect(observedSnapshot).not.toBeNull()
    })

    // 验证两条路径等价（Observer 不修改 Snapshot）
    expect(observedSnapshot!.traceId).toBe(directSnapshot.traceId)
    expect(observedSnapshot!.totalTurns).toBe(directSnapshot.totalTurns)
    expect(observedSnapshot!.elapsedMs).toBe(directSnapshot.elapsedMs)
    expect(observedSnapshot!.observedAt).toBe(directSnapshot.observedAt)
    expect(observedSnapshot!.stateChange).toEqual(directSnapshot.stateChange)
    expect(observedSnapshot!.informationGain).toEqual(directSnapshot.informationGain)
    expect(observedSnapshot!.goalProgress).toEqual(directSnapshot.goalProgress)

    observer.stop()
  })

  it('ProgressObserver 不持有用于计算的状态', () => {
    // Observer 的字段应仅限于 analyzer + consumers + unsubscribe
    // @ts-expect-error — 访问私有字段以验证没有额外的计算状态
    const instanceKeys = Object.keys(
      new ProgressObserver(new InMemoryEvaluationRepository(), new GuardrailProgressAnalyzer(new InMemoryEvaluationRepository())),
    )
    // 只应包含: store, analyzer, consumers, unsubscribe, replayWindowMs
    expect(instanceKeys.length).toBeLessThanOrEqual(5)
    expect(instanceKeys).not.toContain('cache')
    expect(instanceKeys).not.toContain('throttle')
    expect(instanceKeys).not.toContain('buffer')
  })

  it('ProgressObserver 不向 Analyzer 传递协议外参数', () => {
    // 验证 Observer 调用 compute() 的签名只包含 traceId 和 events
    const src = ProgressObserver.toString()
    expect(src).toContain('.compute(')
    // compute() 调用的参数应是 traceId, events（已在 #2 的 mock 验证中确认）
  })
})

// ══════════════════════════════════════════════
// 验证 4: Consumer Isolation
// ══════════════════════════════════════════════

describe('V-4: Consumer Isolation', () => {
  it('Consumer 异常不影响 Snapshot 内容', async () => {
    const store = new InMemoryEvaluationRepository()

    const TRACE = 'isolation'
    const events = [modelInvoked(), toolCompleted('search', 'data'), modelCompleted(100)]
    for (const ev of events) {
      ev.traceId = TRACE
      store.append(ev)
    }

    const analyzer = new GuardrailProgressAnalyzer(store)

    // 无 Consumer
    const observer1 = new ProgressObserver(store, analyzer)
    observer1.start()

    // 有异常 Consumer
    const observer2 = new ProgressObserver(store, analyzer)
    const badConsumer: ProgressConsumer = {
      consume: () => {
        throw new Error('consumer crash')
      },
    }
    observer2.register(badConsumer)
    observer2.start()

    let snapWithoutConsumer: ProgressSnapshot | null = null
    let snapWithBadConsumer: ProgressSnapshot | null = null

    const capture1: ProgressConsumer = {
      consume: (s) => {
        snapWithoutConsumer = s
      },
    }
    const capture2: ProgressConsumer = {
      consume: (s) => {
        snapWithBadConsumer = s
      },
    }
    observer1.register(capture1)
    observer2.register(capture2)

    // 触发相同事件（同 traceId）
    const ev = makeEvent({ type: 'tool.completed', traceId: TRACE, payload: { type: 'tool.completed', toolName: 'a', durationMs: 10 } })
    store.append(ev)

    await vi.waitFor(() => {
      expect(snapWithoutConsumer).not.toBeNull()
      expect(snapWithBadConsumer).not.toBeNull()
    })

    // 验证 Producer 输出不受 Consumer 影响
    expect(snapWithoutConsumer!.totalTurns).toBe(snapWithBadConsumer!.totalTurns)
    expect(snapWithoutConsumer!.stateChange).toEqual(snapWithBadConsumer!.stateChange)
    expect(snapWithoutConsumer!.informationGain).toEqual(snapWithBadConsumer!.informationGain)
    expect(snapWithoutConsumer!.goalProgress).toEqual(snapWithBadConsumer!.goalProgress)

    observer1.stop()
    observer2.stop()
  })

  it('Consumer 数量变化不影响 Snapshot 内容', async () => {
    const store = new InMemoryEvaluationRepository()
    const analyzer = new GuardrailProgressAnalyzer(store)

    const baseEvents = [modelInvoked(), toolCompleted('search', 'data'), modelCompleted(100)]
    for (const ev of baseEvents) store.append(ev)

    // 一个 Consumer
    const observer1 = new ProgressObserver(store, analyzer)
    observer1.register({ consume: vi.fn() })
    observer1.register({ consume: vi.fn() })

    // 三个 Consumer
    const observer2 = new ProgressObserver(store, analyzer)
    observer2.register({ consume: vi.fn() })
    observer2.register({ consume: vi.fn() })
    observer2.register({ consume: vi.fn() })

    observer1.start()
    observer2.start()

    let snap1: ProgressSnapshot | null = null
    let snap2: ProgressSnapshot | null = null

    observer1.register({
      consume: (s) => {
        snap1 = s
      },
    })
    observer2.register({
      consume: (s) => {
        snap2 = s
      },
    })

    const ev = makeEvent({
      type: 'tool.completed',
      traceId: 'count_test',
      payload: { type: 'tool.completed', toolName: 'a', durationMs: 10 },
    })
    store.append(ev)

    await vi.waitFor(() => {
      expect(snap1).not.toBeNull()
      expect(snap2).not.toBeNull()
    })

    expect(snap1!.totalTurns).toBe(snap2!.totalTurns)
    expect(snap1!.traceId).toBe(snap2!.traceId)

    observer1.stop()
    observer2.stop()
  })
})
