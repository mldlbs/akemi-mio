import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TensionFieldEngine } from '@akemi-mio/intelligence-observer/TensionFieldEngine'
import { TrendEngine } from '@akemi-mio/intelligence-observer/TrendEngine'
import { DeepResearchEngine } from '@akemi-mio/intelligence-observer/DeepResearchEngine'
import { WorldModelStore } from '@akemi-mio/intelligence-observer/WorldModelStore'
import type { ObserverLlmService } from '@akemi-mio/intelligence-observer/ObserverLlmService'
import type { ObserverStore } from '@akemi-mio/intelligence-observer/ObserverStore'
import { DEFAULT_EVOLUTION_WEIGHTS } from '@akemi-mio/intelligence-observer/types'

function makeLlm(payload: unknown) {
  return { generateJson: vi.fn().mockResolvedValue(payload), generate: vi.fn().mockResolvedValue(payload) } as unknown as ObserverLlmService
}

function makeStore() {
  return {
    getRecentTopics: vi.fn(() => []),
    readWorldModel: vi.fn(() => ({ entities: [{ name: '已知实体' }], uncertainties: [] })),
    saveTopicSelection: vi.fn(),
  } as unknown as ObserverStore
}

const ONE_SIGNAL_TRENDS = {
  signals: [
    {
      keyword: '缓存穿透',
      score: 0.6,
      sourceDiversity: 2,
      occurrenceCount: 5,
      lastSeenAt: new Date().toISOString(),
    },
  ],
  sourceSummary: { totalItemsReceived: 10 },
} as any

describe('TensionFieldEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('suggestFromObservations 过滤非字符串并截断超长 topic（L4）', async () => {
    const llm = makeLlm({
      data: ['正常话题', 42, { topic: '对象' }, 'x'.repeat(100), '', '   '],
    })
    const engine = new TensionFieldEngine(llm, makeStore())

    const out = await (engine as any).suggestFromObservations({ sourceSummary: { totalItemsReceived: 5 } })

    expect(out).toEqual([{ topic: '正常话题' }, { topic: 'x'.repeat(60) }])
  })

  it('suggestFromObservations 对非数组返回空（原实现会 TypeError）（L4）', async () => {
    const llm = makeLlm({ data: { topic: 'not-an-array' } })
    const engine = new TensionFieldEngine(llm, makeStore())

    const out = await (engine as any).suggestFromObservations({ sourceSummary: { totalItemsReceived: 5 } })
    expect(out).toEqual([])
  })

  it('rateNovelty 与 rateContradiction 并行发起（L4：两次串行往返降为一次）', async () => {
    let inflight = 0
    let maxInflight = 0
    const pending: (() => void)[] = []
    const llm = {
      generateJson: vi.fn(() => {
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        return new Promise((resolve) => {
          pending.push(() => {
            inflight--
            resolve({ data: 0.5 })
          })
        })
      }),
    } as unknown as ObserverLlmService
    const engine = new TensionFieldEngine(llm, makeStore())

    const promise = (engine as any).buildCandidates(ONE_SIGNAL_TRENDS, DEFAULT_EVOLUTION_WEIGHTS)
    await Promise.resolve()
    expect(maxInflight).toBeGreaterThanOrEqual(2)

    pending.splice(0).forEach((resolve) => resolve())
    const candidates = await promise
    expect(candidates).toHaveLength(1)
    expect(candidates[0].topic).toBe('缓存穿透')
  })
})

describe('TrendEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extractKeywords 条数上限 25，防止灌爆 dedup 提示词（L5）', async () => {
    const data = Array.from({ length: 40 }, (_, i) => ({ keyword: `关键词${i}`, matched_ids: ['o1'] }))
    const llm = makeLlm({ data })
    const engine = new TrendEngine(llm, {} as ObserverStore)
    const observations = [{ id: 'o1', timestamp: new Date().toISOString(), source: 'rss', content: '内容' }] as any

    const map = await (engine as any).extractKeywords(observations)
    expect(Object.keys(map).length).toBeLessThanOrEqual(25)
    expect(Object.keys(map)).toContain('关键词0')
  })
})

describe('DeepResearchEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('generateFallbackSummary 遇到 LLM error 返回 null 并落日志（L6）', async () => {
    const llm = makeLlm({ error: 'timeout' })
    const engine = new DeepResearchEngine(llm, {} as ObserverStore)

    const out = await (engine as any).generateFallbackSummary('主题', '上下文')
    expect(out).toBeNull()
    expect(llm.generate).toHaveBeenCalled()
  })

  it('generateFallbackSummary 正常返回 summary（L6 回归）', async () => {
    const llm = makeLlm({ data: '一段摘要' })
    const engine = new DeepResearchEngine(llm, {} as ObserverStore)

    const out = await (engine as any).generateFallbackSummary('主题', '上下文')
    expect(out).toBe('一段摘要')
  })
})

describe('WorldModelStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extractUncertainties 同时支持 string 与 string[] 的 evidence（L7）', async () => {
    const store = new WorldModelStore(makeLlm({}), {} as ObserverStore)
    const uncertainties: any[] = []
    const result = {
      conflicts: [
        { partyA: '甲', partyB: '乙', nature: '矛盾', evidence: ['这条说法不确定'] },
        { partyA: '丙', partyB: '丁', nature: '矛盾', evidence: '可能存在问题' },
        { partyA: '戊', partyB: '己', nature: '矛盾', evidence: ['已有确证，无猜测'] },
        { partyA: '庚', partyB: '辛', nature: '矛盾', evidence: undefined },
      ],
    } as any

    ;(store as any).extractUncertainties(result, uncertainties)

    expect(uncertainties.map((u) => u.topic)).toEqual(['甲 vs 乙', '丙 vs 丁'])
  })
})
