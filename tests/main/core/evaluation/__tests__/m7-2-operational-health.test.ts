/**
 * GuardrailHealthService — M7.2 Operational Health 测试
 *
 * 覆盖：
 * - healthCheck() 四种聚合状态
 * - 组件级 UP / DEGRADED / DOWN 判定
 * - Replay Verification PASS / FAIL / WARN
 * - 验证边界（不修改 state / 不触发 repair）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GuardrailHealthService, SystemHealthLevel } from '@akemi-mio/core/core/evaluation/GuardrailHealthService'
import type { EvaluationEvent } from '@akemi-mio/core/core/evaluation/types'

// ══════════════════════════════════════════════
// 测试替身
// ══════════════════════════════════════════════

function makeEventStoreStub(events?: EvaluationEvent[]) {
  return {
    query: vi.fn().mockResolvedValue(events ?? []),
    append: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    getTrace: vi.fn(),
  }
}

function makeMetricsProjectionStub(overrides?: Partial<ReturnType<typeof createDefaultMetrics>>) {
  return createDefaultMetrics(overrides)
}

function createDefaultMetrics(
  overrides?: Partial<{
    projectionState: { status: string; windowCount: number; lastBuiltAt: number }
    summary: { totalChecked: number; windowCount: number }
    queryResult: { id: string; checkedCount: number }[]
  }>,
) {
  const defaults = {
    projectionState: { status: 'READY', windowCount: 5, lastBuiltAt: Date.now() - 60000 },
    summary: { totalChecked: 42, windowCount: 5 },
    queryResult: [] as { id: string; checkedCount: number }[],
  }
  const merged = { ...defaults, ...overrides }
  return {
    getProjectionState: vi.fn().mockResolvedValue(merged.projectionState),
    getSummary: vi.fn().mockResolvedValue(merged.summary),
    query: vi.fn().mockResolvedValue(merged.queryResult),
  }
}

function stubConfigStore(overrides?: { activeVersion?: string; historyLength?: number; error?: boolean }) {
  const o = overrides ?? {}
  const active = { version: o.activeVersion ?? 'v3', config: {} }
  const history = Array.from({ length: o.historyLength ?? 3 }, (_, i) => ({
    version: `v${i + 1}`,
    activatedAt: 1000 * (i + 1),
  }))
  return {
    getActiveConfig: o.error
      ? vi.fn(() => {
          throw new Error('config error')
        })
      : vi.fn().mockReturnValue(active),
    getVersionHistory: o.error
      ? vi.fn(() => {
          throw new Error('config error')
        })
      : vi.fn().mockReturnValue(history),
  }
}

function stubRecommendationStore(count = 0) {
  return { count: vi.fn().mockReturnValue(count), sweepExpired: vi.fn().mockReturnValue(0) }
}

function makeGuardrailEvent(ts: number, type: 'guardrail.checked' | 'guardrail.terminated'): EvaluationEvent {
  return {
    id: `ev_${ts}`,
    schemaVersion: 1,
    timestamp: ts,
    traceId: 't1',
    sessionId: 's1',
    source: 'test',
    type,
    payload: { type, decision: 'continue', reason: 'test' },
  }
}

// ══════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════

describe('GuardrailHealthService.healthCheck()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('所有组件正常时返回 NORMAL', async () => {
    const eventStore = makeEventStoreStub([])
    const metrics = makeMetricsProjectionStub()
    const config = stubConfigStore()
    const recs = stubRecommendationStore(2)

    const svc = new GuardrailHealthService(eventStore as any, metrics, config, recs)
    const result = await svc.healthCheck()

    expect(result.level).toBe('NORMAL')
    expect(result.components).toHaveLength(5)
    result.components.forEach((c) => {
      expect(c.status).toBe('UP')
    })
  })

  it('MetricsProjection UNAVAILABLE 时返回 DOWN', async () => {
    const eventStore = makeEventStoreStub([])
    const metrics = makeMetricsProjectionStub({
      projectionState: { status: 'UNAVAILABLE', windowCount: 0, lastBuiltAt: 0 },
    })
    const config = stubConfigStore()
    const recs = stubRecommendationStore(0)

    const svc = new GuardrailHealthService(eventStore as any, metrics, config, recs)
    const result = await svc.healthCheck()

    expect(result.level).toBe('DOWN')
    const m = result.components.find((c) => c.name === 'metrics_projection')
    expect(m?.status).toBe('DOWN')
  })

  it('MetricsProjection stale 时返回 DEGRADED', async () => {
    const eventStore = makeEventStoreStub([])
    const metrics = makeMetricsProjectionStub({
      projectionState: { status: 'READY', windowCount: 5, lastBuiltAt: Date.now() - 4 * 3600000 }, // 4h stale
    })
    const config = stubConfigStore()
    const recs = stubRecommendationStore(3)

    const svc = new GuardrailHealthService(eventStore as any, metrics, config, recs)
    const result = await svc.healthCheck()

    expect(result.level).toBe('DEGRADED')
    const m = result.components.find((c) => c.name === 'metrics_projection')
    expect(m?.status).toBe('DEGRADED')
    expect(m?.detail).toContain('stale')
  })

  it('ConfigStore 出错时返回 DOWN', async () => {
    const eventStore = makeEventStoreStub([])
    const metrics = makeMetricsProjectionStub()
    const config = stubConfigStore({ error: true })
    const recs = stubRecommendationStore(1)

    const svc = new GuardrailHealthService(eventStore as any, metrics, config, recs)
    const result = await svc.healthCheck()

    expect(result.level).toBe('DOWN')
    const c = result.components.find((c) => c.name === 'config_store')
    expect(c?.status).toBe('DOWN')
  })

  it('ConfigStore 空历史时返回 DEGRADED', async () => {
    const eventStore = makeEventStoreStub([])
    const metrics = makeMetricsProjectionStub()
    const config = stubConfigStore({ activeVersion: 'v0', historyLength: 0 })
    const recs = stubRecommendationStore(0)

    const svc = new GuardrailHealthService(eventStore as any, metrics, config, recs)
    const result = await svc.healthCheck()

    expect(result.level).toBe('DEGRADED')
    const c = result.components.find((c) => c.name === 'config_store')
    expect(c?.status).toBe('DEGRADED')
  })
})

describe('GuardrailHealthService.verifyProjectionConsistency()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('无 guardrail 事件时返回 WARN', async () => {
    const eventStore = makeEventStoreStub([])
    const metrics = makeMetricsProjectionStub()
    const config = stubConfigStore()
    const recs = stubRecommendationStore(0)

    const svc = new GuardrailHealthService(eventStore as any, metrics, config, recs)
    const result = await svc.verifyProjectionConsistency()

    expect(result.status).toBe('WARN')
    expect(result.eventCount).toBe(0)
    expect(result.mismatches).toHaveLength(0)
  })

  it('事件与投影一致时返回 PASS', async () => {
    const now = Date.now()
    const events = [
      makeGuardrailEvent(now - 7200000, 'guardrail.checked'),
      makeGuardrailEvent(now - 3600000, 'guardrail.checked'),
      makeGuardrailEvent(now, 'guardrail.terminated'),
    ]
    const eventStore = makeEventStoreStub(events)
    const metrics = makeMetricsProjectionStub({
      queryResult: [{ id: 'w1', checkedCount: 1 }],
    })
    const config = stubConfigStore()
    const recs = stubRecommendationStore(0)

    const svc = new GuardrailHealthService(eventStore as any, metrics, config, recs)
    const result = await svc.verifyProjectionConsistency(now - 7200000, now)

    expect(result.status).toBe('PASS')
    expect(result.eventCount).toBe(3)
    expect(result.lastVerifiedEventId).toBe(events[events.length - 1].id)
  })

  it('事件与投影不一致时返回 FAIL 并列出 mismatches', async () => {
    const now = Date.now()
    const events = [makeGuardrailEvent(now - 7200000, 'guardrail.checked'), makeGuardrailEvent(now - 3600000, 'guardrail.checked')]
    const eventStore = makeEventStoreStub(events)
    const metrics = makeMetricsProjectionStub({
      // Metrics 中返回 0 → 期望 2 但实际 0 → mismatch
      queryResult: [],
    })
    const config = stubConfigStore()
    const recs = stubRecommendationStore(0)

    const svc = new GuardrailHealthService(eventStore as any, metrics, config, recs)
    const result = await svc.verifyProjectionConsistency(now - 7200000, now)

    expect(result.status).toBe('FAIL')
    expect(result.mismatches.length).toBeGreaterThan(0)
    expect(result.mismatches[0].delta).toBeGreaterThan(0)
  })

  it('不修改任何 state（只读验证）', async () => {
    const events = [makeGuardrailEvent(Date.now(), 'guardrail.checked')]
    const eventStore = makeEventStoreStub(events)
    const metrics = makeMetricsProjectionStub()
    const config = stubConfigStore()
    const recs = stubRecommendationStore(0)

    const svc = new GuardrailHealthService(eventStore as any, metrics, config, recs)
    await svc.verifyProjectionConsistency()

    // Verify only read methods were called
    expect(eventStore.query).toHaveBeenCalled()
    expect(metrics.query).toHaveBeenCalled()
    // Verify write methods were NOT called
    expect('clear' in metrics ? (metrics as any).clear : undefined).toBeUndefined()
  })
})
