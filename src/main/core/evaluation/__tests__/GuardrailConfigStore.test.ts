/**
 * GuardrailConfigStore — 单元测试（M4.4 Event Projection API）
 *
 * 覆盖：
 * - applyActivated（4 tests）
 * - applyRollback（4 tests）
 * - loadFromEvents（5 tests）
 * - allocateVersion（2 tests）
 * - getActiveConfig（2 tests）
 * - 查询 / 历史兼容（4 tests）
 */
import { describe, it, expect } from 'vitest'
import { GuardrailConfigStore } from '../GuardrailConfigStore'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from '../GuardrailTypes'
import type { GuardrailPolicyConfig } from '../GuardrailTypes'
import type { EvaluationEvent } from '../types'

// ── Test Fixtures ──

const customConfig: GuardrailPolicyConfig = {
  version: 'ignored',
  stateChange: { degrading: 5, stalled: 15 },
  informationGain: { lowOutputDegrading: 6, lowOutputStalled: 12, repeatedContentDegrading: 3, repeatedContentStalled: 8 },
  goalProgress: { degrading: 8, stalled: 20 },
}

const customConfig2: GuardrailPolicyConfig = {
  version: 'ignored',
  stateChange: { degrading: 10, stalled: 25 },
  informationGain: { lowOutputDegrading: 8, lowOutputStalled: 15, repeatedContentDegrading: 5, repeatedContentStalled: 10 },
  goalProgress: { degrading: 12, stalled: 30 },
}

let eventId = 0
function makeConfigEvent(
  type: 'guardrail.config.initialized' | 'guardrail.config.activated' | 'guardrail.config.rollback',
  payload: Record<string, unknown>,
  timestamp?: number,
): EvaluationEvent {
  eventId++
  return {
    id: `cfg_${eventId}`,
    timestamp: timestamp ?? Date.now() + eventId,
    traceId: 'config_trace',
    sessionId: 'config_session',
    source: 'test',
    type,
    payload: { type, ...payload } as any,
  }
}

// ══════════════════════════════════════════════
// applyActivated
// ══════════════════════════════════════════════

describe('applyActivated', () => {
  it('追加一条 activated 记录后可通过 getConfig 查询', () => {
    const store = new GuardrailConfigStore()
    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
    const config = store.getConfig('v1')
    expect(config).toBeDefined()
    expect(config!.stateChange).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange)
  })

  it('多次 applyActivated 后 active version 为最后一次', () => {
    const store = new GuardrailConfigStore()
    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
    store.applyActivated('v2', customConfig, 2000)
    const { version, config } = store.getActiveConfig()
    expect(version).toBe('v2')
    expect(config.stateChange.degrading).toBe(5)
  })

  it('apply 时 config 的 version 被覆盖为传入的 version', () => {
    const store = new GuardrailConfigStore()
    store.applyActivated('v_custom', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
    const config = store.getConfig('v_custom')!
    expect(config.version).toBe('v_custom')
  })

  it('多个 version 独立存储', () => {
    const store = new GuardrailConfigStore()
    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
    store.applyActivated('v2', customConfig, 2000)
    store.applyActivated('v3', customConfig2, 3000)
    expect(store.getVersionHistory()).toHaveLength(3)
    expect(store.getConfig('v1')!.stateChange.stalled).toBe(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange.stalled)
    expect(store.getConfig('v3')!.stateChange.degrading).toBe(10)
  })
})

// ══════════════════════════════════════════════
// applyRollback
// ══════════════════════════════════════════════

describe('applyRollback', () => {
  it('回滚到已知版本后 getActiveConfig 返回该版本的 config', () => {
    const store = new GuardrailConfigStore()
    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
    store.applyActivated('v2', customConfig, 2000) // active = v2
    store.applyRollback('v2', 'v1', 'manual', 'test')
    const { version, config } = store.getActiveConfig()
    expect(version).toBe('v1')
    expect(config.stateChange.degrading).toBe(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange.degrading)
  })

  it('回滚到当前 active 版本时抛出', () => {
    const store = new GuardrailConfigStore()
    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
    expect(() => store.applyRollback('v1', 'v1', 'manual')).toThrow('is already active')
  })

  it('回滚到不存在的版本时抛出', () => {
    const store = new GuardrailConfigStore()
    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
    expect(() => store.applyRollback('v1', 'v_unknown', 'manual')).toThrow('unknown version')
  })

  it('多次回滚可切换 active version', () => {
    const store = new GuardrailConfigStore()
    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
    store.applyActivated('v2', customConfig, 2000)
    store.applyRollback('v2', 'v1', 'manual') // → v1
    store.applyActivated('v3', customConfig2, 3000) // → v3
    store.applyRollback('v3', 'v1', 'automated_guardrail') // → v1
    const { version } = store.getActiveConfig()
    expect(version).toBe('v1')
  })
})

// ══════════════════════════════════════════════
// loadFromEvents 启动重建
// ══════════════════════════════════════════════

describe('loadFromEvents', () => {
  it('空 events → 无历史，getActiveConfig 返回 DEFAULT', () => {
    const store = new GuardrailConfigStore()
    store.loadFromEvents([])
    expect(store.getVersionHistory()).toHaveLength(0)
    const { version, config } = store.getActiveConfig()
    expect(version).toBe(DEFAULT_GUARDRAIL_POLICY_CONFIG.version)
    expect(config).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG)
  })

  it('单 activated 事件 → 正确重建', () => {
    const store = new GuardrailConfigStore()
    const events = [
      makeConfigEvent('guardrail.config.activated', { version: 'v1', config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 }, 1000),
    ]
    store.loadFromEvents(events)
    const { version, config } = store.getActiveConfig()
    expect(version).toBe('v1')
    expect(config.stateChange).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange)
  })

  it('activated + rollback 链 → 正确重建', () => {
    const store = new GuardrailConfigStore()
    const events = [
      makeConfigEvent('guardrail.config.activated', { version: 'v1', config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 }, 1000),
      makeConfigEvent('guardrail.config.activated', { version: 'v2', config: customConfig, activatedAt: 2000 }, 2000),
      makeConfigEvent(
        'guardrail.config.rollback',
        { fromVersion: 'v2', toVersion: 'v1', trigger: 'manual' as const, reason: 'test' },
        3000,
      ),
    ]
    store.loadFromEvents(events)
    const { version } = store.getActiveConfig()
    expect(version).toBe('v1')
  })

  it('timeline fracture — rollback 目标版本不存在 → throw', () => {
    const store = new GuardrailConfigStore()
    const events = [
      makeConfigEvent('guardrail.config.activated', { version: 'v1', config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 }, 1000),
      makeConfigEvent(
        'guardrail.config.rollback',
        { fromVersion: 'v1', toVersion: 'v_never_existed', trigger: 'automated_guardrail' as const },
        2000,
      ),
    ]
    expect(() => store.loadFromEvents(events)).toThrow('unknown version')
  })

  it('第一个 event 是 rollback → throw', () => {
    const store = new GuardrailConfigStore()
    const events = [makeConfigEvent('guardrail.config.rollback', { fromVersion: 'v2', toVersion: 'v1', trigger: 'manual' as const }, 1000)]
    expect(() => store.loadFromEvents(events)).toThrow('unknown version')
  })

  it('乱序 events → 按 timestamp 排序后重建正确', () => {
    const store = new GuardrailConfigStore()
    const v1Event = makeConfigEvent(
      'guardrail.config.activated',
      { version: 'v1', config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 },
      1000,
    )
    const v2Event = makeConfigEvent('guardrail.config.activated', { version: 'v2', config: customConfig, activatedAt: 2000 }, 2000)
    const rollbackEvent = makeConfigEvent(
      'guardrail.config.rollback',
      { fromVersion: 'v2', toVersion: 'v1', trigger: 'manual' as const },
      3000,
    )
    // 逆序传入
    store.loadFromEvents([rollbackEvent, v1Event, v2Event])
    const { version } = store.getActiveConfig()
    expect(version).toBe('v1')
  })

  // ══════════════════════════════════════════════
  // M4.5 — Config Schema Evolution
  // ══════════════════════════════════════════════

  it('guardrail.config.initialized 事件 → 正确重建', () => {
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

  it('initialized + activated 混合 → 正确 timeline', () => {
    const store = new GuardrailConfigStore()
    const events = [
      makeConfigEvent(
        'guardrail.config.initialized',
        { version: 'v1', eventSchemaVersion: 1, config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 },
        1000,
      ),
      makeConfigEvent(
        'guardrail.config.activated',
        { version: 'v2', eventSchemaVersion: 1, config: customConfig, activatedAt: 2000 },
        2000,
      ),
    ]
    store.loadFromEvents(events)
    const { version, config } = store.getActiveConfig()
    expect(version).toBe('v2')
    expect(config.stateChange.degrading).toBe(5)
  })

  it('旧事件（无 eventSchemaVersion）→ 默认 v1 处理', () => {
    const store = new GuardrailConfigStore()
    const events = [
      makeConfigEvent('guardrail.config.activated', { version: 'v1', config: DEFAULT_GUARDRAIL_POLICY_CONFIG, activatedAt: 1000 }, 1000),
    ]
    // payload 中无 eventSchemaVersion 字段 — simulate old event
    delete (events[0].payload as any).eventSchemaVersion
    store.loadFromEvents(events)
    const { version } = store.getActiveConfig()
    expect(version).toBe('v1')
  })
})

// ══════════════════════════════════════════════
// allocateVersion 辅助方法
// ══════════════════════════════════════════════

describe('allocateVersion', () => {
  it('单调递增 v1 → v2 → v3', () => {
    const store = new GuardrailConfigStore()
    expect(store.allocateVersion()).toBe('v1')
    expect(store.allocateVersion()).toBe('v2')
    expect(store.allocateVersion()).toBe('v3')
  })

  it('多个 ConfigStore 实例独立计数', () => {
    const storeA = new GuardrailConfigStore()
    const storeB = new GuardrailConfigStore()
    expect(storeA.allocateVersion()).toBe('v1')
    expect(storeB.allocateVersion()).toBe('v1')
  })
})

// ══════════════════════════════════════════════
// getActiveConfig — 无历史回退
// ══════════════════════════════════════════════

describe('getActiveConfig fallback', () => {
  it('无任何 apply/loadFromEvents 时返回 DEFAULT', () => {
    const store = new GuardrailConfigStore()
    const { version, config } = store.getActiveConfig()
    expect(version).toBe(DEFAULT_GUARDRAIL_POLICY_CONFIG.version)
    expect(config).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG)
  })
})

// ══════════════════════════════════════════════
// 查询接口向后兼容
// ══════════════════════════════════════════════

describe('query API backward compat', () => {
  it('getConfig 返回已激活版本', () => {
    const store = new GuardrailConfigStore()
    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
    expect(store.getConfig('v1')).toBeDefined()
    expect(store.getConfig('v_unknown')).toBeUndefined()
  })

  it('hasVersion 正确', () => {
    const store = new GuardrailConfigStore()
    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 1000)
    expect(store.hasVersion('v1')).toBe(true)
    expect(store.hasVersion('v2')).toBe(false)
  })

  it('getVersionHistory 按激活时间升序', () => {
    const store = new GuardrailConfigStore()
    store.applyActivated('v1', DEFAULT_GUARDRAIL_POLICY_CONFIG, 100)
    store.applyActivated('v2', customConfig, 200)
    const history = store.getVersionHistory()
    expect(history).toHaveLength(2)
    expect(history[0].version).toBe('v1')
    expect(history[1].version).toBe('v2')
  })

  it('peekNextVersion 不推进计数器', () => {
    const store = new GuardrailConfigStore()
    expect(store.peekNextVersion()).toBe('v1')
    expect(store.peekNextVersion()).toBe('v1') // 不推进
    store.allocateVersion()
    expect(store.peekNextVersion()).toBe('v2')
  })
})
