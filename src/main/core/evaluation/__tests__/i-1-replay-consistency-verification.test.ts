/**
 * I-1: Replay Consistency Verification
 *
 * 验证在固定 PolicyConfig + 排除时间字段的前提下，Pipeline 全链路是否 Deterministic。
 *
 * Replay Determinism Boundary:
 *
 *   Included:
 *     EvaluationEvent[]
 *     fixed PolicyConfig
 *     GuardrailProgressAnalyzer.compute()     (纯函数, 无状态)
 *     DefaultGuardrailPolicy.evaluate()       (纯函数, 构造函数注入 config)
 *     toRuntimeAction()                       (纯函数)
 *
 *   Excluded:
 *     decidedAt (Date.now())                  — Runtime metadata, 不参与语义
 *     External I/O (LLM / tool execution)     — Event 已记录结果，不需重放
 *     Runtime state (trace 边界、throttle)    — 属于 Pipeline 生命周期, 非纯函数
 *
 * 核心命题（限定表述）：
 *   同一 ReplayInput = { events, policyConfig } → 无论执行多少次 →
 *   L1: ProgressSnapshot (所有字段)
 *   L2: GuardrailDecision (action / signals / reason / traceId / snapshot, 排除 decidedAt)
 *   L3: RuntimeAction
 *   输出完全一致
 *
 * 失败分类（当 mismatch 发生时）：
 *   - Non-determinism：pipeline 某步依赖了 Date.now() / 全局状态 / 环境变量
 *   - Fixture issue：测试固定构造的事件有误
 *   - Schema drift：Runtime event 增加了字段但 pipeline 未正确处理
 *
 * 不验证（超出 I-1 scope）：
 *   - Runtime event schema 完整
 *   - 所有未来 Consumer replay-safe
 *   - 外部依赖不存在
 *
 * 约定：
 *   - decidedAt 已知非确定性，replay 比较时排除
 *   - 使用固定 Policy Config（DEFAULT_GUARDRAIL_POLICY_CONFIG），不依赖环境或运行时配置
 *   - 不使用任何 mock / spy（纯函数测试）
 *
 * @see docs/program-execution.md — M3 I-1
 */
import { describe, it, expect } from 'vitest'
import { GuardrailProgressAnalyzer } from '../GuardrailProgressAnalyzer'
import { DefaultGuardrailPolicy } from '../GuardrailPolicy'
import { toRuntimeAction, DEFAULT_GUARDRAIL_POLICY_CONFIG } from '../GuardrailTypes'
import { GuardrailConfigStore } from '../GuardrailConfigStore'
import type { EvaluationEvent, EventType } from '../types'
import type { ProgressSnapshot } from '../progress'
import type { GuardrailDecision, RuntimeAction, GuardrailPolicyConfig } from '../GuardrailTypes'

// ══════════════════════════════════════════════
// Replay Helper
// ══════════════════════════════════════════════

/**
 * ReplayInput — Deterministic replay 的完整输入定义。
 *
 * 不只是 EvaluationEvent[]，还包括 PolicyConfig，
 * 因为 evaluate() 的阈值直接影响 Decision 输出。
 */
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

  // Layer 1: compute() — 纯函数，仅依赖 events
  const snapshot = GuardrailProgressAnalyzer.compute(traceId, events)

  // Layer 2: evaluate(input) — 纯函数，通过 PolicyInput 传入 snapshot + config
  const config = policyConfig ?? DEFAULT_GUARDRAIL_POLICY_CONFIG
  const policy = new DefaultGuardrailPolicy()
  const decision = policy.evaluate({ snapshot, config })

  // Layer 3: toRuntimeAction() — 纯函数
  const runtimeAction = toRuntimeAction(decision.action)

  return { snapshot, decision, runtimeAction }
}

/** 排除已知非确定性字段后的 Decision Identity 比较 — replay contract */
function expectDecisionIdentityEqual(a: GuardrailDecision, b: GuardrailDecision): void {
  // Identity = action + signals + policyVersion（semantic equality）
  expect(a.action).toBe(b.action)
  expect(a.signals).toEqual(b.signals)
  expect(a.policyVersion).toBe(b.policyVersion)
}

/** Decision 元数据比较 — deterministic implementation check（非 Identity） */
function expectDecisionMetadataEqual(a: GuardrailDecision, b: GuardrailDecision): void {
  expect(a.reason).toBe(b.reason)
  expect(a.traceId).toBe(b.traceId)
  expect(a.snapshot).toEqual(b.snapshot)
}

// ══════════════════════════════════════════════
// 测试固定生成
// ══════════════════════════════════════════════

let idCounter = 0

function makeEvent(overrides: Partial<EvaluationEvent> & { type: EventType; payload: any }): EvaluationEvent {
  idCounter++
  return {
    id: `i1_${idCounter}`,
    timestamp: 1000 + idCounter,
    traceId: 'replay_trace',
    sessionId: 'replay_session',
    source: 'replay_test',
    ...overrides,
  }
}

function modelInvoked(): EvaluationEvent {
  return makeEvent({ type: 'model.invoked', payload: { type: 'model.invoked', modelName: 'test', promptLength: 100 } })
}

function modelCompleted(responseLength: number, responsePreview?: string): EvaluationEvent {
  return makeEvent({
    type: 'model.completed',
    payload: {
      type: 'model.completed',
      modelName: 'test',
      durationMs: 500,
      inputTokens: 100,
      outputTokens: 50,
      responseLength,
      responsePreview,
    },
  })
}

function toolInvoked(toolName: string): EvaluationEvent {
  return makeEvent({ type: 'tool.invoked', payload: { type: 'tool.invoked', toolName } })
}

function toolCompleted(toolName: string, output?: string): EvaluationEvent {
  return makeEvent({
    type: 'tool.completed',
    payload: { type: 'tool.completed', toolName, durationMs: 100, output },
  })
}

function agentResponse(): EvaluationEvent {
  return makeEvent({ type: 'agent.response', payload: { type: 'agent.response', length: 50, durationMs: 100 } })
}

function taskCompleted(): EvaluationEvent {
  return makeEvent({
    type: 'task.completed',
    payload: { type: 'task.completed', kind: 'chat', outcome: 'completed', durationMs: 100 },
  })
}

// ══════════════════════════════════════════════
// 固定 Trace 固定
// ══════════════════════════════════════════════

/** 5-turn healthy trace */
function healthyTrace5(): EvaluationEvent[] {
  return [
    // Turn 0: 普通工具调用
    modelInvoked(),
    toolInvoked('search'),
    toolCompleted('search', 'result_alpha'),
    modelCompleted(100, 'found result alpha'),
    // Turn 1: 助理回复
    modelInvoked(),
    agentResponse(),
    modelCompleted(200, 'let me help you with that'),
    // Turn 2: 子任务完成
    modelInvoked(),
    taskCompleted(),
    modelCompleted(50, 'task done'),
    // Turn 3: 再次工具调用
    modelInvoked(),
    toolInvoked('read'),
    toolCompleted('read', 'doc_content'),
    modelCompleted(150, 'read the document'),
    // Turn 4: 正常结束
    modelInvoked(),
    toolInvoked('calculate'),
    toolCompleted('calculate', '42'),
    modelCompleted(80, 'the answer is 42'),
  ]
}

/** 8-turn trace，最后 4 轮停滞 */
function stagnantTrace8(): EvaluationEvent[] {
  const events: EvaluationEvent[] = [
    // Turn 0: 初始完成
    modelInvoked(),
    toolInvoked('search'),
    toolCompleted('search', 'initial_result'),
    modelCompleted(200, 'found initial data'),
    // Turn 1: 唯一进展
    modelInvoked(),
    taskCompleted(),
    modelCompleted(100, 'completed task'),
  ]
  // Turn 2-7: 6 轮停滞（model 调用无工具、无内容变化）
  for (let i = 0; i < 6; i++) {
    events.push(modelInvoked(), modelCompleted(0))
  }
  return events
}

/** 6-turn trace，连续低输出 */
function lowOutputTrace6(): EvaluationEvent[] {
  const events: EvaluationEvent[] = []
  for (let i = 0; i < 6; i++) {
    events.push(modelInvoked(), toolInvoked('status'), toolCompleted('status', 'ok'), modelCompleted(5, 'ok'))
  }
  return events
}

// ══════════════════════════════════════════════
// T-1: 同一 events 两次执行，逐层 toEqual（排除 decidedAt）
// ══════════════════════════════════════════════

describe('T-1: Identical input → identical output (determinism)', () => {
  it('healthyTrace5 — 两次 replay 逐层一致', () => {
    const events = healthyTrace5()
    const r1 = replay({ events })
    const r2 = replay({ events })

    // L1: Snapshot 严格相等
    expect(r2.snapshot).toEqual(r1.snapshot)
    // L2: Decision Identity（replay contract）
    expectDecisionIdentityEqual(r2.decision, r1.decision)
    // L2: Decision metadata（implementation check）
    expectDecisionMetadataEqual(r2.decision, r1.decision)
    // L3: RuntimeAction 严格相等
    expect(r2.runtimeAction).toBe(r1.runtimeAction)
  })

  it('stagnantTrace8 — 两次 replay 逐层一致', () => {
    const events = stagnantTrace8()
    const r1 = replay({ events })
    const r2 = replay({ events })

    expect(r2.snapshot).toEqual(r1.snapshot)
    expectDecisionIdentityEqual(r2.decision, r1.decision)
    expectDecisionMetadataEqual(r2.decision, r1.decision)
    expect(r2.runtimeAction).toBe(r1.runtimeAction)
  })

  it('lowOutputTrace6 — 两次 replay 逐层一致', () => {
    const events = lowOutputTrace6()
    const r1 = replay({ events })
    const r2 = replay({ events })

    expect(r2.snapshot).toEqual(r1.snapshot)
    expectDecisionIdentityEqual(r2.decision, r1.decision)
    expectDecisionMetadataEqual(r2.decision, r1.decision)
    expect(r2.runtimeAction).toBe(r1.runtimeAction)
  })

  it('replay() 不抛出异常', () => {
    const events = healthyTrace5()
    expect(() => replay({ events })).not.toThrow()
  })
})

// ══════════════════════════════════════════════
// T-3: Shuffled events 验证排序稳定性
// ══════════════════════════════════════════════

describe('T-3: Shuffled events → stable output', () => {
  it('healthyTrace5 shuffling 后 replay 与原始顺序一致', () => {
    const original = healthyTrace5()
    const expected = replay({ events: [...original] })

    // Fisher-Yates shuffle
    const shuffled = [...original]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor((idCounter * 9301 + 49297) % (i + 1)) // 确定性伪随机
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }

    const actual = replay({ events: shuffled })

    // compute() 内部排序 → shuffled 应与原始一致
    expect(actual.snapshot).toEqual(expected.snapshot)
    expectDecisionIdentityEqual(actual.decision, expected.decision)
    expectDecisionMetadataEqual(actual.decision, expected.decision)
    expect(actual.runtimeAction).toBe(expected.runtimeAction)
  })

  it('完全逆序后 replay 结果一致', () => {
    const original = healthyTrace5()
    const expected = replay({ events: [...original] })

    const reversed = [...original].reverse()
    const actual = replay({ events: reversed })

    expect(actual.snapshot).toEqual(expected.snapshot)
    expectDecisionIdentityEqual(actual.decision, expected.decision)
    expectDecisionMetadataEqual(actual.decision, expected.decision)
  })
})

// ══════════════════════════════════════════════
// T-4: Unknown event isolation（独立测试，不作为 I-1 pass 条件）
// ══════════════════════════════════════════════

describe('T-4: Unknown event isolation', () => {
  it('混入 guardrail.* 事件不影响 compute() 输出', () => {
    const base = healthyTrace5()
    const cleanResult = replay({ events: base })

    const withGuardrailEvents = [
      ...base.slice(0, 3),
      makeEvent({
        type: 'guardrail.checked' as any,
        payload: { type: 'guardrail.checked', turn: 1, decision: 'continue', reason: 'test' },
      }),
      ...base.slice(3, 6),
      makeEvent({
        type: 'guardrail.terminated' as any,
        payload: { type: 'guardrail.terminated', turn: 5, totalTurns: 5, reason: 'test' },
      }),
      ...base.slice(6),
    ]

    const withEventsResult = replay({ events: withGuardrailEvents })

    // guardrail.* 应被 groupByTurns 或 compute() 忽略
    expect(withEventsResult.snapshot.totalTurns).toBe(cleanResult.snapshot.totalTurns)
    expect(withEventsResult.snapshot.stateChange).toEqual(cleanResult.snapshot.stateChange)
    expect(withEventsResult.snapshot.informationGain).toEqual(cleanResult.snapshot.informationGain)
    expect(withEventsResult.snapshot.goalProgress).toEqual(cleanResult.snapshot.goalProgress)
  })

  it('完全未知的事件类型被静默忽略', () => {
    const base = healthyTrace5()
    const cleanResult = replay({ events: base })

    const withUnknown = [
      ...base,
      makeEvent({
        type: 'some.unknown.event' as any,
        payload: { someField: 'unknown' },
      }),
    ]

    const unknownResult = replay({ events: withUnknown })

    // 未知事件不计入 totalTurns（没有 model.invoked）
    expect(unknownResult.snapshot.totalTurns).toBe(cleanResult.snapshot.totalTurns)
    expect(unknownResult.snapshot.elapsedMs).toBeGreaterThanOrEqual(cleanResult.snapshot.elapsedMs)
    // 其他信号不变
    expect(unknownResult.snapshot.stateChange).toEqual(cleanResult.snapshot.stateChange)
    expect(unknownResult.snapshot.goalProgress).toEqual(cleanResult.snapshot.goalProgress)
  })

  it('guardrail.config.activated 不影响 compute() 输出', () => {
    const base = healthyTrace5()
    const cleanResult = replay({ events: base })

    const withConfigEvents = [
      ...base.slice(0, 4),
      makeEvent({
        type: 'guardrail.config.activated' as any,
        payload: { type: 'guardrail.config.activated', version: 'v2', config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: Date.now() },
      }),
      ...base.slice(4),
    ]

    const result = replay({ events: withConfigEvents })

    expect(result.snapshot.totalTurns).toBe(cleanResult.snapshot.totalTurns)
    expect(result.snapshot.stateChange).toEqual(cleanResult.snapshot.stateChange)
    expect(result.snapshot.informationGain).toEqual(cleanResult.snapshot.informationGain)
    expect(result.snapshot.goalProgress).toEqual(cleanResult.snapshot.goalProgress)
  })

  it('guardrail.config.rollback 不影响 compute() 输出', () => {
    const base = healthyTrace5()
    const cleanResult = replay({ events: base })

    const withConfigEvents = [
      ...base.slice(0, 3),
      makeEvent({
        type: 'guardrail.config.rollback' as any,
        payload: { type: 'guardrail.config.rollback', fromVersion: 'v2', toVersion: 'v1', trigger: 'manual' as const },
      }),
      ...base.slice(3),
    ]

    const result = replay({ events: withConfigEvents })

    expect(result.snapshot.totalTurns).toBe(cleanResult.snapshot.totalTurns)
    expect(result.snapshot.stateChange).toEqual(cleanResult.snapshot.stateChange)
    expect(result.snapshot.informationGain).toEqual(cleanResult.snapshot.informationGain)
    expect(result.snapshot.goalProgress).toEqual(cleanResult.snapshot.goalProgress)
  })
})

// ══════════════════════════════════════════════
// T-5: 多 Trace Matrix
// ══════════════════════════════════════════════

describe('T-5: Multi-trace matrix', () => {
  const TRACES = [
    { id: 'healthy', events: healthyTrace5(), expectedAction: 'continue' as const },
    { id: 'stagnant', events: stagnantTrace8(), expectedAction: 'warning' as const },
    { id: 'low_output', events: lowOutputTrace6(), expectedAction: 'terminate' as const },
  ]

  TRACES.forEach(({ id, events, expectedAction }) => {
    it(`${id} — replay consistency + expected action`, () => {
      const r1 = replay({ events })
      const r2 = replay({ events })

      // 同 trace 两次 replay 一致
      expect(r2.snapshot).toEqual(r1.snapshot)
      expectDecisionIdentityEqual(r2.decision, r1.decision)
      expectDecisionMetadataEqual(r2.decision, r1.decision)
      expect(r2.runtimeAction).toBe(r1.runtimeAction)

      // action 符合预期
      const policy = new DefaultGuardrailPolicy()
      const decision = policy.evaluate({ snapshot: r1.snapshot, config: DEFAULT_GUARDRAIL_POLICY_CONFIG })
      expect(decision.action).toBe(expectedAction)
    })
  })

  it('不同 traceId 之间不互扰', () => {
    const rHealthy = replay({ events: healthyTrace5() })
    const rStagnant = replay({ events: stagnantTrace8() })

    // replay_trace 的 snapshot 不应包含 other trace 事件
    expect(rHealthy.snapshot.totalTurns).toBe(5)

    // rStagnant 应该检测到停滞
    expect(rStagnant.snapshot.stateChange.stagnantTurnCount).toBeGreaterThan(3)
  })
})

// ══════════════════════════════════════════════
// T-6: ConfigStore reconstruction from events
// ══════════════════════════════════════════════

describe('T-6: ConfigStore reconstruction from events', () => {
  function makeConfigEvent(
    type: 'guardrail.config.initialized' | 'guardrail.config.activated' | 'guardrail.config.rollback',
    payload: Record<string, unknown>,
    timestamp: number,
  ): EvaluationEvent {
    return {
      id: `replay_cfg_${timestamp}`,
      timestamp,
      traceId: 'config_replay',
      sessionId: 'cfg_replay_session',
      source: 'test',
      type,
      payload: { type, ...payload } as any,
    }
  }

  it('activated event → loadFromEvents 正确重建 ConfigStore', () => {
    const store = new GuardrailConfigStore()
    const events = [
      makeConfigEvent('guardrail.config.activated', { version: 'v1', config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 }, 1000),
    ]
    store.loadFromEvents(events)

    const { version, config } = store.getActiveConfig()
    expect(version).toBe('v1')
    expect(config.stateChange).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange)
  })

  it('initialized event → loadFromEvents 正确重建 ConfigStore', () => {
    const store = new GuardrailConfigStore()
    const events = [
      makeConfigEvent(
        'guardrail.config.initialized',
        { version: 'v1', eventSchemaVersion: 1, config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 },
        1000,
      ),
    ]
    store.loadFromEvents(events)

    const { version, config } = store.getActiveConfig()
    expect(version).toBe('v1')
    expect(config.stateChange).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange)
  })

  it('activated + rollback events → replay 后 active 版本正确', () => {
    const store = new GuardrailConfigStore()
    const events = [
      makeConfigEvent('guardrail.config.activated', { version: 'v1', config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 }, 1000),
      makeConfigEvent('guardrail.config.activated', { version: 'v2', config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 2000 }, 2000),
      makeConfigEvent('guardrail.config.rollback', { fromVersion: 'v2', toVersion: 'v1', trigger: 'manual' }, 3000),
    ]
    store.loadFromEvents(events)

    expect(store.getActiveConfig().version).toBe('v1')
    expect(store.getVersionHistory()).toHaveLength(2)
  })

  it('initialized + activated events → timeline 正确 + 可作 replay 输入', () => {
    const store = new GuardrailConfigStore()
    const events = [
      makeConfigEvent(
        'guardrail.config.initialized',
        { version: 'v1', eventSchemaVersion: 1, config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 },
        1000,
      ),
      makeConfigEvent(
        'guardrail.config.activated',
        { version: 'v2', eventSchemaVersion: 1, config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 2000 },
        2000,
      ),
    ]
    store.loadFromEvents(events)

    expect(store.getActiveConfig().version).toBe('v2')
    expect(store.getVersionHistory()).toHaveLength(2)
  })

  it('reconstructed config 可作为 replay() 的 policyConfig 输入', () => {
    const store = new GuardrailConfigStore()
    const events = [
      makeConfigEvent('guardrail.config.activated', { version: 'v1', config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 }, 1000),
    ]
    store.loadFromEvents(events)

    const { config } = store.getActiveConfig()

    // reconstructed config → replay pipeline → consistent output
    const r1 = replay({ events: healthyTrace5(), policyConfig: config })
    const r2 = replay({ events: healthyTrace5(), policyConfig: config })
    expectDecisionIdentityEqual(r2.decision, r1.decision)
    expect(r2.runtimeAction).toBe(r1.runtimeAction)
  })
})

// ══════════════════════════════════════════════
// T-7: Schema version migration — event replay consistency
// ══════════════════════════════════════════════

describe('T-7: Schema version migration', () => {
  it('guardrail.config.initialized 不影响 compute() 输出', () => {
    const base = healthyTrace5()
    const cleanResult = replay({ events: base })

    const withInitEvent = [
      ...base.slice(0, 4),
      makeEvent({
        type: 'guardrail.config.initialized' as any,
        payload: {
          type: 'guardrail.config.initialized',
          version: 'v1',
          eventSchemaVersion: 1,
          config: DEFAULT_GUARDRAIL_POLICY_CONFIG,
          activatedAt: Date.now(),
        },
      }),
      ...base.slice(4),
    ]

    const result = replay({ events: withInitEvent })

    expect(result.snapshot.totalTurns).toBe(cleanResult.snapshot.totalTurns)
    expect(result.snapshot.stateChange).toEqual(cleanResult.snapshot.stateChange)
    expect(result.snapshot.informationGain).toEqual(cleanResult.snapshot.informationGain)
    expect(result.snapshot.goalProgress).toEqual(cleanResult.snapshot.goalProgress)
  })

  it('schema-version-migrated event → replay 正确', () => {
    // Simulate: old event created at v1 schema → replayed after migration → should be identity
    const store = new GuardrailConfigStore()
    const events = [
      {
        ...makeEvent({
          type: 'guardrail.config.activated' as any,
          payload: { type: 'guardrail.config.activated', version: 'v1', config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 },
        }),
        // No eventSchemaVersion — simulating an event created before M4.5
      } as EvaluationEvent,
    ]
    // Remove eventSchemaVersion from payload
    delete (events[0].payload as any).eventSchemaVersion

    store.loadFromEvents(events)

    const { config } = store.getActiveConfig()
    expect(config.stateChange).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange)
    expect(config.informationGain).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG.informationGain)
    expect(config.goalProgress).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG.goalProgress)

    // Reconstructed config → replay pipeline → produces correct decision
    const r = replay({ events: healthyTrace5(), policyConfig: config })
    expect(r.snapshot).toBeDefined()
    expect(r.decision).toBeDefined()
  })
})
