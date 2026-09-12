import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CreativityService } from '@akemi-mio/creativity/CreativityService'
import type { IdeaStoreLike, Hypothesis } from '@akemi-mio/creativity/types'

function makeStore(): IdeaStoreLike {
  return {
    addCombo: vi.fn(),
    addHypothesis: vi.fn(),
    addManyHypotheses: vi.fn(),
    addExperiment: vi.fn(),
    logDreamCycle: vi.fn(),
    getHypotheses: vi.fn(() => []),
    getNovelHypotheses: vi.fn(() => []),
    getActiveExperiments: vi.fn(() => []),
    getRecentCombos: vi.fn(() => []),
    getRecentDreamCycles: vi.fn(() => []),
    updateHypothesisStatus: vi.fn(() => true),
    addExploredPair: vi.fn(),
    getExploredPairs: vi.fn(() => []),
    resetExploredPairs: vi.fn(),
    count: vi.fn(() => ({ combos: 0, hypotheses: 0, experiments: 0, dreamCycles: 0 })),
    templateAdoptionStats: vi.fn(() => ({})),
    adoptionReport: vi.fn(() => ''),
    getFermentableHypotheses: vi.fn(() => []),
    updateHypothesisFermentation: vi.fn(() => true),
  }
}

describe('CreativityService 发酵集成', () => {
  let chatJson: ReturnType<typeof vi.fn>
  let store: IdeaStoreLike

  beforeEach(() => {
    vi.clearAllMocks()
    chatJson = vi.fn()
    store = makeStore()
  })

  it('forceFerment 调用发酵引擎并返回结果', async () => {
    const h: Hypothesis = {
      id: 'h1',
      title: 't',
      idea: 'i',
      expectedBenefit: '',
      risk: '',
      sourceLabels: ['A'],
      novelty: 70,
      feasibility: 70,
      impact: 70,
      status: 'draft',
      createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
      fermentCount: 1,
    }
    store.getFermentableHypotheses = vi.fn(() => [h])
    chatJson.mockResolvedValue({
      data: { results: [{ id: 'h1', verdict: 'promote', reason: 'ok', novelty: 80, feasibility: 80, impact: 80 }] },
    })

    const deps = {
      getSources: vi.fn(() => [{ name: 'A', content: 'x', type: 'knowledge', weight: 0.8 }]),
      getInsights: vi.fn(() => []),
      getFailedHypotheses: vi.fn(() => []),
    }
    const service = new CreativityService(store, deps as any, chatJson as any, undefined, 0, 42, undefined, '', undefined, undefined)
    const result = await service.forceFerment()
    expect(result.promoted).toContain('h1')
    expect(store.updateHypothesisFermentation).toHaveBeenCalledWith('h1', expect.objectContaining({ status: 'active' }))
  })

  it('cycle 通过来源总线聚合 external 来源', async () => {
    chatJson.mockResolvedValue({
      data: [
        {
          title: '跨模块缓存优化',
          idea: '这是一个足够描述的改进方案不少于二十个字的内容描述用于验证测试',
          expectedBenefit: '提升响应速度',
          risk: '增加内存占用',
          sourceLabels: ['Agent', 'Memory'],
          novelty: 65,
          feasibility: 75,
          impact: 70,
          relevance: '记忆与模块缓存共享任务上下文并协同提升效率',
        },
      ],
    })
    const deps = {
      getSources: vi.fn(() => [{ name: 'Memory', content: 'a', type: 'knowledge', weight: 0.9 }]),
      getExternalSources: vi.fn(() => [{ name: 'GitHub灵感', content: 'b', type: 'insight', weight: 0.8 }]),
      getInsights: vi.fn(() => []),
      getFailedHypotheses: vi.fn(() => []),
    }
    const service = new CreativityService(store, deps as any, chatJson as any, undefined, 0, 42, undefined, '', undefined, undefined)
    await (service as any).cycle()
    expect(chatJson).toHaveBeenCalledTimes(1)
  })
})
