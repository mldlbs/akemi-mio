import { describe, it, expect, vi } from 'vitest'
import { IdeaFermentationEngine } from '@akemi-mio/creativity/IdeaFermentationEngine'
import type { Hypothesis, IdeaStoreLike } from '@akemi-mio/creativity/types'

const DAY = 24 * 60 * 60 * 1000

function makeHyp(partial: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'h1',
    title: '点子',
    idea: '内容',
    expectedBenefit: '',
    risk: '',
    sourceLabels: ['A'],
    novelty: 60,
    feasibility: 60,
    impact: 60,
    status: 'draft',
    createdAt: Date.now() - 2 * DAY,
    ...partial,
  }
}

function createStore(initial: Hypothesis[] = []) {
  const hyps = [...initial]
  const updates: Array<{ id: string; patch: any }> = []
  return {
    store: {
      getFermentableHypotheses: vi.fn(() => [...hyps]),
      getHypotheses: vi.fn((opts) => {
        let result = [...hyps]
        if (opts?.status) result = result.filter(h => h.status === opts.status)
        return result
      }),
      addHypothesis: vi.fn((h: Hypothesis) => hyps.push(h)),
      updateHypothesisFermentation: vi.fn((id: string, patch: any) => {
        updates.push({ id, patch })
        const h = hyps.find((x) => x.id === id)
        if (h) Object.assign(h, patch)
        return true
      }),
      updateHypothesisStatus: vi.fn(() => true),
    } as unknown as IdeaStoreLike,
    updates,
    hyps,
  }
}

const chatJson = vi.fn()

function makeEngine(store: IdeaStoreLike, signals: any[] = []) {
  return new IdeaFermentationEngine(store, chatJson as any, () => signals as any)
}

describe('IdeaFermentationEngine', () => {
  beforeEach(() => {
    chatJson.mockReset()
  })

  it('promote：满 2 轮且年龄 ≥24h 才升级为 active', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1', fermentCount: 1 })])
    chatJson.mockResolvedValue({
      data: { results: [{ id: 'h1', verdict: 'promote', reason: '成熟', novelty: 80, feasibility: 80, impact: 80 }] },
    })
    const result = await makeEngine(store).ferment()
    expect(result.promoted).toContain('h1')
    expect(updates[0].patch.status).toBe('active')
    expect(updates[0].patch.fermentCount).toBe(2)
  })

  it('promote 但年龄不足时降级为 keep，留在 draft', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1', createdAt: Date.now() - 5 * 60 * 1000, fermentCount: 1 })])
    chatJson.mockResolvedValue({
      data: { results: [{ id: 'h1', verdict: 'promote', reason: '太年轻', novelty: 80, feasibility: 80, impact: 80 }] },
    })
    const result = await makeEngine(store).ferment()
    expect(result.promoted).toHaveLength(0)
    expect(updates[0].patch.status).toBeUndefined()
    expect(updates[0].patch.fermentCount).toBe(2)
  })

  it('keep：分数按 新*0.6 + 旧*0.4 混合', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1', novelty: 60, feasibility: 60, impact: 60 })])
    chatJson.mockResolvedValue({
      data: { results: [{ id: 'h1', verdict: 'keep', reason: '再想想', novelty: 90, feasibility: 70, impact: 80 }] },
    })
    await makeEngine(store).ferment()
    expect(updates[0].patch.novelty).toBe(78) // 60*0.4 + 90*0.6 = 78
    expect(updates[0].patch.feasibility).toBe(66)
  })

  it('reject：标记 rejected 并记录理由', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1' })])
    chatJson.mockResolvedValue({ data: { results: [{ id: 'h1', verdict: 'reject', reason: '不可行' }] } })
    const result = await makeEngine(store).ferment()
    expect(result.rejected).toContain('h1')
    expect(updates[0].patch.status).toBe('rejected')
    expect(updates[0].patch.fermentLog[0].reason).toBe('不可行')
  })

  it('merge：生成合并版 draft，原条目标 rejected + mergedInto', async () => {
    const { store, hyps, updates } = createStore([makeHyp({ id: 'a', sourceLabels: ['A'] }), makeHyp({ id: 'b', sourceLabels: ['B'] })])
    chatJson.mockResolvedValue({
      data: {
        results: [
          {
            id: 'a',
            verdict: 'merge',
            reason: '互补',
            mergeWithId: 'b',
            mergedIdea: {
              title: '合并',
              idea: '合并内容',
              expectedBenefit: 'x',
              risk: 'y',
              sourceLabels: ['A', 'B'],
              novelty: 70,
              feasibility: 70,
              impact: 70,
            },
          },
        ],
      },
    })
    const result = await makeEngine(store).ferment()
    expect(result.merged).toBe(1)
    const merged = hyps.find((h) => h.id.startsWith('hyp_merge_'))
    expect(merged).toBeDefined()
    expect(merged!.status).toBe('draft')
    const aUpdate = updates.find((u) => u.id === 'a')
    const bUpdate = updates.find((u) => u.id === 'b')
    expect(aUpdate?.patch.status).toBe('rejected')
    expect(aUpdate?.patch.mergedInto).toBe(merged!.id)
    expect(bUpdate?.patch.status).toBe('rejected')
  })

  it('满 3 轮仍未升级自动淘汰', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1', fermentCount: 2 })])
    chatJson.mockResolvedValue({ data: { results: [{ id: 'h1', verdict: 'keep', reason: '没动静' }] } })
    await makeEngine(store).ferment()
    expect(updates[0].patch.status).toBe('rejected')
  })

  it('LLM 失败时 skipped=true 且不修改任何数据', async () => {
    const { store, updates } = createStore([makeHyp({ id: 'h1' })])
    chatJson.mockResolvedValue({ error: 'timeout' })
    const result = await makeEngine(store).ferment()
    expect(result.skipped).toBe(true)
    expect(updates).toHaveLength(0)
  })

  it('每批全部 promote', async () => {
    const hyps = [1, 2, 3, 4].map((i) => makeHyp({ id: `h${i}`, fermentCount: 1, title: `创意方案${i}关于不同领域`, idea: `这是一个关于模块${i}的独特改进方案不少于二十个字的内容描述` }))
    const { store, updates } = createStore(hyps)
    chatJson.mockResolvedValue({
      data: {
        results: hyps.map((h) => ({ id: h.id, verdict: 'promote', reason: 'ok', novelty: 80, feasibility: 80, impact: 80 })),
      },
    })
    const result = await makeEngine(store).ferment()
    expect(result.promoted).toHaveLength(4)
    const activeCount = updates.filter((u) => u.patch.status === 'active').length
    expect(activeCount).toBe(4)
  })

  it('使用小批量并放宽超时，避免上游超时', async () => {
    const { store } = createStore([makeHyp({ id: 'h1', fermentCount: 1 })])
    chatJson.mockResolvedValue({ data: { results: [{ id: 'h1', verdict: 'keep', reason: 'ok' }] } })
    await makeEngine(store).ferment()
    expect(store.getFermentableHypotheses).toHaveBeenCalledWith(8)
    expect(chatJson).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeoutMs: 180000 }))
  })
})
