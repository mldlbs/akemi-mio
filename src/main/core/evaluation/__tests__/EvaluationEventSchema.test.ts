/**
 * EvaluationEventSchema — 单元测试
 *
 * 覆盖：
 * - getCurrentSchemaVersion 查询
 * - migrateConfigPayload v1→current identity
 * - CONFIG_EVENT_TYPES 白名单完整性（仅 config 三兄弟）
 */
import { describe, it, expect } from 'vitest'
import {
  getCurrentSchemaVersion,
  migrateConfigPayload,
  CONFIG_EVENT_TYPES,
  EVENT_SCHEMA_VERSIONS,
  GOVERNANCE_EVENT_TYPES,
} from '../EvaluationEventSchema'
import { DEFAULT_GUARDRAIL_POLICY_CONFIG } from '../GuardrailTypes'

describe('getCurrentSchemaVersion', () => {
  it('known event type 返回注册版本', () => {
    expect(getCurrentSchemaVersion('guardrail.config.initialized')).toBe(1)
    expect(getCurrentSchemaVersion('guardrail.config.activated')).toBe(1)
    expect(getCurrentSchemaVersion('guardrail.config.rollback')).toBe(1)
  })

  it('未知 event type 返回 1', () => {
    expect(getCurrentSchemaVersion('unknown.type')).toBe(1)
    expect(getCurrentSchemaVersion('guardrail.checked')).toBe(1)
  })
})

describe('migrateConfigPayload', () => {
  it('v1→current identity（字段不变）', () => {
    const payload = {
      version: 'v1',
      config: DEFAULT_GUARDRAIL_POLICY_CONFIG,
      activatedAt: 1000,
    }
    const result = migrateConfigPayload('guardrail.config.activated', payload, 1)
    expect(result.version).toBe('v1')
    expect(result.config).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG)
    expect(result.activatedAt).toBe(1000)
  })

  it('缺失 eventSchemaVersion → 默认 v1 → identity', () => {
    const payload = {
      version: 'v1',
      config: DEFAULT_GUARDRAIL_POLICY_CONFIG,
      activatedAt: 1000,
    }
    const result = migrateConfigPayload('guardrail.config.activated', payload, 0)
    expect(result.version).toBe('v1')
    expect(result.config).toEqual(DEFAULT_GUARDRAIL_POLICY_CONFIG)
  })

  it('fromVersion >= current — 不迁移', () => {
    const payload = {
      version: 'v999',
      config: DEFAULT_GUARDRAIL_POLICY_CONFIG,
      activatedAt: 9999,
    }
    const result = migrateConfigPayload('guardrail.config.activated', payload, 999)
    expect(result).toEqual(payload)
  })
})

describe('CONFIG_EVENT_TYPES', () => {
  it('包含所有 config-related event types', () => {
    expect(CONFIG_EVENT_TYPES.has('guardrail.config.initialized')).toBe(true)
    expect(CONFIG_EVENT_TYPES.has('guardrail.config.activated')).toBe(true)
    expect(CONFIG_EVENT_TYPES.has('guardrail.config.rollback')).toBe(true)
  })

  it('不包含非 config event types', () => {
    expect(CONFIG_EVENT_TYPES.has('guardrail.checked')).toBe(false)
    expect(CONFIG_EVENT_TYPES.has('model.invoked')).toBe(false)
    expect(CONFIG_EVENT_TYPES.has('task.started')).toBe(false)
  })

  it('所有注册的 config type 都在 EVENT_SCHEMA_VERSIONS 中', () => {
    for (const key of CONFIG_EVENT_TYPES) {
      expect(EVENT_SCHEMA_VERSIONS).toHaveProperty(key)
    }
  })
})

describe('GOVERNANCE_EVENT_TYPES', () => {
  it('包含所有 governance event types', () => {
    expect(GOVERNANCE_EVENT_TYPES.has('guardrail.recommendation.created')).toBe(true)
    expect(GOVERNANCE_EVENT_TYPES.has('guardrail.recommendation.approved')).toBe(true)
    expect(GOVERNANCE_EVENT_TYPES.has('guardrail.recommendation.dismissed')).toBe(true)
    expect(GOVERNANCE_EVENT_TYPES.has('guardrail.config.validation_failed')).toBe(true)
    expect(GOVERNANCE_EVENT_TYPES.has('guardrail.projection.rebuilt')).toBe(true)
    expect(GOVERNANCE_EVENT_TYPES.has('guardrail.projection.error')).toBe(true)
    expect(GOVERNANCE_EVENT_TYPES.has('guardrail.health.check')).toBe(true)
  })

  it('不包含非 governance event types', () => {
    expect(GOVERNANCE_EVENT_TYPES.has('guardrail.checked')).toBe(false)
    expect(GOVERNANCE_EVENT_TYPES.has('guardrail.config.activated')).toBe(false)
    expect(GOVERNANCE_EVENT_TYPES.has('guardrail.outcome.observed')).toBe(false)
  })

  it('所有注册的 governance type 都在 EVENT_SCHEMA_VERSIONS 中', () => {
    for (const key of GOVERNANCE_EVENT_TYPES) {
      expect(EVENT_SCHEMA_VERSIONS).toHaveProperty(key)
    }
  })
})
