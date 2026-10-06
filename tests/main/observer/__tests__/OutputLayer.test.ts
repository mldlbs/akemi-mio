import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OutputLayer } from '@akemi-mio/intelligence-observer/OutputLayer'
import type { ObserverStore } from '@akemi-mio/intelligence-observer/ObserverStore'

function makeStore(world: any) {
  return { readWorldModel: vi.fn(() => world) } as unknown as ObserverStore
}

function makeInsight(topic = 'AI 眼镜'): any {
  return { id: 'obs_1', topic, mode: 'neutral', generatedAt: new Date().toISOString(), sections: [], metadata: { llmCalls: 1 } }
}

const DAG = { taskId: 't1', state: 'COMPLETED', startedAt: '2026-10-06T00:00:00Z' } as any

describe('OutputLayer.computeAnomalyScore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('满证据（冲突+事件速度+不确定性全开）得分 1.0，超过 0.7 阈值触发 isAnomaly', async () => {
    const store = makeStore({
      narratives: [{ title: 'AI 眼镜' }],
      events: Array.from({ length: 30 }, (_, i) => ({ id: `e${i}` })),
      uncertainties: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }, { id: 'u4' }],
    })
    const layer = new OutputLayer(store)
    const insight = makeInsight()

    expect(layer.computeAnomalyScore(insight)).toBe(1)
    const envelope = await layer.publishInsight(insight, DAG, Date.now())
    expect(envelope.isAnomaly).toBe(true)
  })

  it('弱证据得分远低于 0.7，不触发 isAnomaly（修复前上界 0.7 恒不触发）', async () => {
    const store = makeStore({
      narratives: [],
      events: [],
      uncertainties: [],
    })
    const layer = new OutputLayer(store)
    const insight = makeInsight()

    const score = layer.computeAnomalyScore(insight)
    expect(score).toBeLessThan(0.7)
    const envelope = await layer.publishInsight(insight, DAG, Date.now())
    expect(envelope.isAnomaly).toBe(false)
  })

  it('事件数爆炸时 velocity 封顶，得分不超过 1.0', async () => {
    const store = makeStore({
      narratives: [{ title: 'AI 眼镜' }],
      events: Array.from({ length: 5000 }, (_, i) => ({ id: `e${i}` })),
      uncertainties: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }, { id: 'u4' }],
    })
    const layer = new OutputLayer(store)
    expect(layer.computeAnomalyScore(makeInsight())).toBeLessThanOrEqual(1)
  })

  it('中间态可达：历史叙事命中 + 事件密集 + 不确定性多 → 恰好越过 0.7 线', async () => {
    const store = makeStore({
      narratives: [{ title: 'AI 眼镜' }],
      events: Array.from({ length: 30 }, (_, i) => ({ id: `e${i}` })),
      uncertainties: [], // 0.2：三项 0.5+1+0.2=1.7/2.1≈0.81 > 0.7
    })
    const layer = new OutputLayer(store)
    expect(layer.computeAnomalyScore(makeInsight())).toBeGreaterThan(0.7)
  })
})
