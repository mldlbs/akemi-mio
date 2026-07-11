/**
 * i-4-replay-durability — Historical Compatibility & Decision Reproducibility
 *
 * 验证：
 * - 启动 catchup 覆盖：重启后 catchup 正确重放
 * - Historical Decision 可复现性
 */

import { describe, it, expect } from 'vitest'
import { GuardrailProgressAnalyzer } from '../GuardrailProgressAnalyzer'
import { DefaultGuardrailPolicy } from '../GuardrailPolicy'
import { toRuntimeAction, DEFAULT_GUARDRAIL_POLICY_CONFIG } from '../GuardrailTypes'
import { GuardrailConfigStore } from '../GuardrailConfigStore'
import { InMemoryEvaluationRepository } from '../__test_support__'
import { ProgressObserver } from '../ProgressObserver'
import type { ProgressConsumer, ProgressSnapshot } from '../progress'
import type { EvaluationEvent, EventType } from '../types'
import type { GuardrailDecision, RuntimeAction, GuardrailPolicyConfig } from '../GuardrailTypes'

// ── Helper ──

interface ReplayInput {
  events: EvaluationEvent[]
  policyConfig?: GuardrailPolicyConfig
}

interface ReplayResult {
  snapshot: ProgressSnapshot
  decision: GuardrailDecision
  runtimeAction: RuntimeAction
}

function replay(input: ReplayInput): ReplayResult {
  const { events, policyConfig } = input
  const traceId = events.length > 0 ? events[0].traceId : 'replay'
  const snapshot = GuardrailProgressAnalyzer.compute(traceId, events)
  const config = policyConfig ?? DEFAULT_GUARDRAIL_POLICY_CONFIG
  const policy = new DefaultGuardrailPolicy()
  const decision = policy.evaluate({ snapshot, config })
  const runtimeAction = toRuntimeAction(decision.action)
  return { snapshot, decision, runtimeAction }
}

function expectDecisionIdentityEqual(a: GuardrailDecision, b: GuardrailDecision): void {
  expect(a.action).toBe(b.action)
  expect(a.signals).toEqual(b.signals)
  expect(a.policyVersion).toBe(b.policyVersion)
}

let idCounter = 0
function makeEvent(overrides: Partial<EvaluationEvent> & { type: EventType; payload: any }): EvaluationEvent {
  idCounter++
  return {
    id: `durability_${idCounter}`,
    timestamp: 5000 + idCounter,
    traceId: overrides?.traceId ?? 'durability_trace',
    sessionId: 'durability_session',
    source: 'test',
    ...overrides,
  } as any
}

// ── Template traces ──

let nextTs = Date.now() - 60000
function nextTimestamp(): number {
  nextTs += 100
  return nextTs
}

function healthyTrace3(traceId = 'durability_healthy'): EvaluationEvent[] {
  return [
    makeEvent({
      type: 'model.invoked' as any,
      payload: { type: 'model.invoked', modelName: 'test', promptLength: 50 },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'tool.invoked' as any,
      payload: { type: 'tool.invoked', toolName: 'get_weather', args: {} },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'tool.completed' as any,
      payload: { type: 'tool.completed', toolName: 'get_weather', output: 'sunny', durationMs: 200 },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'model.completed' as any,
      payload: { type: 'model.completed', modelName: 'test', durationMs: 400, inputTokens: 50, outputTokens: 100, responseLength: 200 },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'agent.response' as any,
      payload: { type: 'agent.response', length: 200, durationMs: 10 },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'model.invoked' as any,
      payload: { type: 'model.invoked', modelName: 'test', promptLength: 30 },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'tool.invoked' as any,
      payload: { type: 'tool.invoked', toolName: 'search', args: {} },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'tool.completed' as any,
      payload: { type: 'tool.completed', toolName: 'search', output: 'results', durationMs: 150 },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'model.completed' as any,
      payload: { type: 'model.completed', modelName: 'test', durationMs: 350, inputTokens: 30, outputTokens: 80, responseLength: 150 },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'agent.response' as any,
      payload: { type: 'agent.response', length: 150, durationMs: 8 },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'model.invoked' as any,
      payload: { type: 'model.invoked', modelName: 'test', promptLength: 40 },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'model.completed' as any,
      payload: { type: 'model.completed', modelName: 'test', durationMs: 300, inputTokens: 40, outputTokens: 90, responseLength: 180 },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'task.completed' as any,
      payload: { type: 'task.completed', kind: 'chat', outcome: 'completed', durationMs: 2500 },
      traceId,
      timestamp: nextTimestamp(),
    }),
    makeEvent({
      type: 'agent.response' as any,
      payload: { type: 'agent.response', length: 180, durationMs: 10 },
      traceId,
      timestamp: nextTimestamp(),
    }),
  ]
}

// ══════════════════════════════════════════════
// T-1: Startup catch-up covers restart window
// ══════════════════════════════════════════════

describe('T-1: Startup catch-up covers restart window', () => {
  it('重启后无新事件 → catchup 产生决策', async () => {
    const store = new InMemoryEvaluationRepository()
    const traceId = 'catchup_restart'
    const events = healthyTrace3(traceId)
    for (const ev of events) {
      store.append(ev)
    }

    // 模拟重启后 Observer 启动（窗口覆盖这些事件）
    const analyzer = new GuardrailProgressAnalyzer(store)
    const captureConsumed: ProgressSnapshot[] = []
    const consumer: ProgressConsumer = {
      async consume(snapshot: ProgressSnapshot) {
        captureConsumed.push(snapshot)
      },
    }
    // 大窗口确保覆盖
    const observer = new ProgressObserver(store, analyzer, 3600_000)
    observer.register(consumer)
    await observer.start()
    observer.stop()

    // catchup 应该为 catchup_restart 生成了 snapshot
    const catchupSnapshots = captureConsumed.filter((s) => s.traceId === traceId)
    expect(catchupSnapshots.length).toBeGreaterThan(0)
  })

  it('crash → restart → catchup → 决策 identity 匹配', async () => {
    const store = new InMemoryEvaluationRepository()
    const traceId = 'crash_restart_identity'
    const events = healthyTrace3(traceId)
    for (const ev of events) {
      store.append(ev)
    }

    // 第一轮：对完整事件做 replay 得到预期决策
    const expected = replay({ events })

    // 模拟 crash restart：Observer catchup
    const analyzer = new GuardrailProgressAnalyzer(store)
    const captured: ProgressSnapshot[] = []
    const consumer: ProgressConsumer = {
      async consume(snapshot: ProgressSnapshot) {
        captured.push(snapshot)
      },
    }
    const observer = new ProgressObserver(store, analyzer, 3600_000)
    observer.register(consumer)
    await observer.start()
    observer.stop()

    // catchup 应该产生了 snapshot 且与预期一致
    const snapshot = captured.find((s) => s.traceId === traceId)
    expect(snapshot).toBeDefined()
    expect(snapshot!.totalTurns).toBe(expected.snapshot.totalTurns)
    expect(snapshot!.stateChange).toEqual(expected.snapshot.stateChange)
    expect(snapshot!.informationGain).toEqual(expected.snapshot.informationGain)
    expect(snapshot!.goalProgress).toEqual(expected.snapshot.goalProgress)
  })
})

// ══════════════════════════════════════════════
// T-2: Historical Decision reproducibility
// ══════════════════════════════════════════════

describe('T-2: Historical Decision reproducibility', () => {
  it('全事件 replay 产生一致的 Decision', () => {
    const events = healthyTrace3('reproducible_trace')

    // 两次独立 replay → 决策 identity 一致
    const r1 = replay({ events })
    const r2 = replay({ events })

    expectDecisionIdentityEqual(r2.decision, r1.decision)
    expect(r2.runtimeAction).toBe(r1.runtimeAction)
  })

  it('reconstructed ConfigStore → replay → 与 DEFAULT 决策语义一致', () => {
    const store = new GuardrailConfigStore()
    // 使用 DEFAULT 的 version 以确保 policyVersion 一致
    // 注意：applyActivated 会覆盖 config.version 为传入的 version
    const configVersion = DEFAULT_GUARDRAIL_POLICY_CONFIG.version
    store.applyActivated(configVersion, DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)

    const events = healthyTrace3('reconstructed_config')
    const { config } = store.getActiveConfig()

    const r1 = replay({ events, policyConfig: config })
    const r2 = replay({ events, policyConfig: DEFAULT_GUARDRAIL_POLICY_CONFIG })

    // 阈值相同 → action + signals 一致
    expect(r2.decision.action).toBe(r1.decision.action)
    expect(r2.decision.signals).toEqual(r1.decision.signals)
    expect(r2.runtimeAction).toBe(r1.runtimeAction)
  })

  it('eventSchemaVersion 不影响 replay 输出', () => {
    const events = healthyTrace3('schema_version_effect')

    const withSchemaEvent: EvaluationEvent = {
      id: 'schema_ev',
      timestamp: 500,
      traceId: 'schema_version_effect',
      sessionId: 's1',
      source: 'test',
      type: 'guardrail.config.activated' as any,
      payload: {
        type: 'guardrail.config.activated',
        version: 'v1',
        eventSchemaVersion: 1,
        config: DEFAULT_GUARDRAIL_POLICY_CONFIG,
        activatedAt: 500,
      },
    }

    const mixed = [...events.slice(0, 2), withSchemaEvent, ...events.slice(2)]

    const clean = replay({ events })
    const withSchema = replay({ events: mixed })

    expect(withSchema.snapshot.totalTurns).toBe(clean.snapshot.totalTurns)
    expectDecisionIdentityEqual(withSchema.decision, clean.decision)
  })
})
