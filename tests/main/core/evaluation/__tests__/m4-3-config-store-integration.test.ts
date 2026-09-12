/**
 * M4.4 Config Store Integration — Projection + Consumer + Event emission
 *
 * 覆盖：
 * - Consumer 从 ConfigStore 读 config（而非静态 DEFAULT）
 * - Config 切换在 consume() 边界生效
 * - 无 ConfigStore 时回退 DEFAULT（向后兼容）
 * - Producer emit event → ConfigStore.apply* 模式
 */
import { describe, it, expect, vi } from 'vitest'
import { GuardrailProgressConsumer } from '@akemi-mio/core/core/evaluation/progress-consumers/GuardrailProgressConsumer'
import { GuardrailConfigStore } from '@akemi-mio/core/core/evaluation/GuardrailConfigStore'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from '@akemi-mio/core/core/evaluation/GuardrailTypes'
import type { GuardrailPolicyConfig } from '@akemi-mio/core/core/evaluation/GuardrailTypes'
import type { ProgressSnapshot, StateChangeSignal, InformationGainSignal, GoalProgressSignal } from '@akemi-mio/core/core/evaluation/progress'
import { PROGRESS_VERSION } from '@akemi-mio/core/core/evaluation/progress'

// ── Test Fixtures ──

const customConfig: GuardrailPolicyConfig = {
  version: 'ignored',
  stateChange: { degrading: 10, stalled: 20 },
  informationGain: { lowOutputDegrading: 6, lowOutputStalled: 12, repeatedContentDegrading: 3, repeatedContentStalled: 8 },
  goalProgress: { degrading: 8, stalled: 20 },
}

function makeSnapshot(threshold: number, stagnantTurnCount?: number): ProgressSnapshot {
  const stateChange: StateChangeSignal = {
    hasNewToolResult: false,
    hasNewAssistantContent: false,
    hasPlanningStateChange: false,
    stagnantTurnCount: stagnantTurnCount ?? threshold,
    lastChangeTurn: -1,
    summary: '',
  }
  const informationGain: InformationGainSignal = {
    consecutiveLowOutputTurns: 0,
    repeatedOutputCount: 0,
    repeatedToolResultCount: 0,
    toolResultNovelty: 1,
    summary: '',
  }
  const goalProgress: GoalProgressSignal = {
    completedSubtasks: 0,
    hasPhaseTransition: false,
    stagnantTurnCount: 0,
    summary: '',
  }

  return {
    traceId: 'm43_int',
    sessionId: 'm43_int_session',
    version: PROGRESS_VERSION,
    totalTurns: 5,
    elapsedMs: 500,
    observedAt: Date.now(),
    stateChange,
    informationGain,
    goalProgress,
  }
}

// ══════════════════════════════════════════════
// Consumer + ConfigStore
// ══════════════════════════════════════════════

describe('Consumer reads config from ConfigStore', () => {
  it('Consumer 从 ConfigStore 读取 applyActivated 的 config 而不是静态 DEFAULT', async () => {
    const store = new GuardrailConfigStore()
    const onDecision = vi.fn()

    // Producer 模式：先 apply 到 ConfigStore
    store.applyActivated('v1', customConfig, Date.now())
    const consumer = new GuardrailProgressConsumer(undefined, onDecision, store)

    // DEFAULT.stalled = 8, customConfig.stalled = 20, snapshot.stagnantTurnCount = 8
    // 使用 customConfig → 8 < 20 → continue
    await consumer.consume(makeSnapshot(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange.stalled, 8))

    const decision = onDecision.mock.calls[0][0]
    expect(decision.action).toBe('continue')
  })

  it('Config 通过 applyActivated 切换后在 consume() 边界生效', async () => {
    const store = new GuardrailConfigStore()
    const onDecision = vi.fn()

    // 先 apply DEFAULT config
    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, Date.now())
    const consumer = new GuardrailProgressConsumer(undefined, onDecision, store)

    // 第一次: DEFAULT.stalled = 8, snapshot.stagnantTurnCount = 8 → terminate
    await consumer.consume(makeSnapshot(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange.stalled, 8))
    expect(onDecision.mock.calls[0][0].action).toBe('terminate')

    // 激活新阈值更高的 config
    store.applyActivated('v2', customConfig, Date.now()) // stalled = 20
    onDecision.mockClear()

    // 第二次: customConfig.stalled = 20, snapshot.stagnantTurnCount = 8 → continue
    await consumer.consume(makeSnapshot(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange.stalled, 8))
    expect(onDecision.mock.calls[0][0].action).toBe('continue')
  })

  it('无 ConfigStore 时回退 DEFAULT（向后兼容）', async () => {
    const onDecision = vi.fn()
    const consumer = new GuardrailProgressConsumer(undefined, onDecision)

    await consumer.consume(makeSnapshot(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange.stalled, 8))

    const decision = onDecision.mock.calls[0][0]
    expect(decision.action).toBe('terminate')
    expect(decision.policyVersion).toBe(DEFAULT_GUARDRAIL_POLICY_CONFIG.version)
  })
})

// ══════════════════════════════════════════════
// Producer emit → ConfigStore.apply 模式
// ══════════════════════════════════════════════

describe('Producer emit → ConfigStore.apply', () => {
  it('Producer 用 allocateVersion() 分配版本 → applyActivated → getActiveConfig 正确', () => {
    const store = new GuardrailConfigStore()

    // Producer 流程
    const version = store.allocateVersion()
    store.applyActivated(version, customConfig, Date.now())

    const { version: activeVersion, config } = store.getActiveConfig()
    expect(activeVersion).toBe('v1')
    expect(config.stateChange.degrading).toBe(10)
  })

  it('allocateVersion 仅作辅助，Producer 可用自定义 version', () => {
    const store = new GuardrailConfigStore()

    // Producer 用自定义 version 绕过 allocateVersion
    store.applyActivated('my-custom-v2', customConfig, Date.now())

    const { version } = store.getActiveConfig()
    expect(version).toBe('my-custom-v2')
  })

  it('applyActivated → applyRollback → getActiveConfig 反映最新状态', () => {
    const store = new GuardrailConfigStore()

    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, Date.now())
    store.applyActivated('v2', customConfig, Date.now())
    expect(store.getActiveConfig().version).toBe('v2')

    store.applyRollback('v2', 'v1', 'automated_guardrail')
    expect(store.getActiveConfig().version).toBe('v1')
  })
})

// ══════════════════════════════════════════════
// 向后兼容
// ══════════════════════════════════════════════

describe('backward compatibility', () => {
  it('无 ConfigStore 时 Consumer 构造不抛异常', () => {
    expect(() => new GuardrailProgressConsumer()).not.toThrow()
    expect(() => new GuardrailProgressConsumer(undefined, null)).not.toThrow()
    expect(() => new GuardrailProgressConsumer(undefined, undefined, undefined)).not.toThrow()
  })
})
