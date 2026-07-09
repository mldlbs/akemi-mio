/**
 * GuardrailConfigStore — 单元测试
 *
 * 覆盖：
 * - 激活（5 tests）
 * - 版本生命周期（4 tests）
 * - 回滚（4 tests）
 * - 版本历史（1 test）
 *
 * 以 DEFAULT_GUARDRAIL_POLICY_CONFIG 为 seed config 基座。
 */

import { describe, it, expect } from 'vitest'
import { GuardrailConfigStore } from '../GuardrailConfigStore'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from '../GuardrailTypes'
import type { GuardrailPolicyConfig } from '../GuardrailTypes'

// ── Test Fixtures ──

const customConfig: GuardrailPolicyConfig = {
  version: 'ignored', // ConfigStore 接管 version 生成
  stateChange: { degrading: 5, stalled: 15 },
  informationGain: { lowOutputDegrading: 6, lowOutputStalled: 12, repeatedContentDegrading: 3, repeatedContentStalled: 8 },
  goalProgress: { degrading: 8, stalled: 20 },
}

// ══════════════════════════════════════════════
// 激活
// ══════════════════════════════════════════════

describe('activateConfig', () => {
  it('seed config 生成 v1', () => {
    const store = new GuardrailConfigStore(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    const { version } = store.getActiveConfig()
    expect(version).toBe('v1')
  })

  it('单调递增 v1 → v2', () => {
    const store = new GuardrailConfigStore(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    store.activateConfig(customConfig)
    const { version } = store.getActiveConfig()
    expect(version).toBe('v2')
  })

  it('getActiveConfig 返回最新激活的 config', () => {
    const store = new GuardrailConfigStore(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    store.activateConfig(customConfig)
    const { config } = store.getActiveConfig()
    expect(config.stateChange.degrading).toBe(5)
    expect(config.stateChange.stalled).toBe(15)
  })

  it('activateConfig 返回 version 和 activatedAt', () => {
    const store = new GuardrailConfigStore()
    const result = store.activateConfig(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    expect(result.version).toBe('v1')
    expect(result.activatedAt).toBeGreaterThan(0)
  })

  it('activateConfig 将 seed config 的 version 覆盖为 ConfigStore 生成的 version', () => {
    const store = new GuardrailConfigStore(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    const record = store.getConfig('v1')!
    expect(record.version).toBe('v1')
  })
})

// ══════════════════════════════════════════════
// 版本生命周期
// ══════════════════════════════════════════════

describe('version lifecycle', () => {
  it('getConfig 返回已激活的版本', () => {
    const store = new GuardrailConfigStore(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    const config = store.getConfig('v1')
    expect(config).toBeDefined()
    expect(config!.stateChange).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange)
  })

  it('getConfig 对未知 version 返回 undefined', () => {
    const store = new GuardrailConfigStore()
    expect(store.getConfig('v_unknown')).toBeUndefined()
  })

  it('hasVersion 对已激活版本返回 true', () => {
    const store = new GuardrailConfigStore(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    expect(store.hasVersion('v1')).toBe(true)
  })

  it('hasVersion 对未知版本返回 false', () => {
    const store = new GuardrailConfigStore()
    expect(store.hasVersion('v1')).toBe(false)
  })
})

// ══════════════════════════════════════════════
// 回滚
// ══════════════════════════════════════════════

describe('rollback', () => {
  it('回滚到已知版本后 getActiveConfig 返回该版本的 config', () => {
    const store = new GuardrailConfigStore(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    store.activateConfig(customConfig) // active = v2
    store.rollback('v1', 'manual', 'test rollback')
    const { config } = store.getActiveConfig()
    expect(config.stateChange.degrading).toBe(DEFAULT_GUARDRAIL_POLICY_CONFIG.stateChange.degrading)
  })

  it('回滚到当前 active 版本时抛出', () => {
    const store = new GuardrailConfigStore(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    expect(() => store.rollback('v1', 'manual')).toThrow('is already active')
  })

  it('回滚到不存在的版本时抛出', () => {
    const store = new GuardrailConfigStore(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    expect(() => store.rollback('v_unknown', 'manual')).toThrow('not found')
  })

  it('rollback 返回正确的 fromVersion 和 toVersion', () => {
    const store = new GuardrailConfigStore(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    store.activateConfig(customConfig) // active = v2
    const result = store.rollback('v1', 'manual', 'test')
    expect(result.fromVersion).toBe('v2')
    expect(result.toVersion).toBe('v1')
  })
})

// ══════════════════════════════════════════════
// 版本历史
// ══════════════════════════════════════════════

describe('getVersionHistory', () => {
  it('返回全部版本记录，按激活时间升序', () => {
    const store = new GuardrailConfigStore(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    store.activateConfig(customConfig) // v2
    const history = store.getVersionHistory()
    expect(history).toHaveLength(2)
    expect(history[0].version).toBe('v1')
    expect(history[1].version).toBe('v2')
    expect(history[0].activatedAt).toBeLessThanOrEqual(history[1].activatedAt)
  })
})

// ══════════════════════════════════════════════
// getActiveConfig — 无 seed config 回退
// ══════════════════════════════════════════════

describe('getActiveConfig fallback', () => {
  it('无 seed 且未 activate 时返回 DEFAULT', () => {
    const store = new GuardrailConfigStore()
    const { version, config } = store.getActiveConfig()
    expect(version).toBe(DEFAULT_GUARDRAIL_POLICY_CONFIG.version)
    expect(config).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG)
  })
})
