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

  it('expansion 提示词禁止外部记忆并要求「推测：」前缀（M3）', () => {
    const engine = new DeepResearchEngine(makeLlm({}), {} as ObserverStore)
    const prompt = (engine as any).buildPhasePrompt('expansion', '主题', '已知信息')
    expect(prompt).toContain('禁止引入外部记忆或常识编造')
    expect(prompt).toContain('「推测：」')
  })

  it('assemble 对结构化数组按 10/8/5 上限截断且容忍非数组（M3）', () => {
    const engine = new DeepResearchEngine(makeLlm({}), {} as ObserverStore)
    const phases = [
      {
        phase: 'structural_modeling',
        startedAt: '',
        output: JSON.stringify({
          facts: Array.from({ length: 20 }, (_, i) => `事实${i}`),
          timeline: Array.from({ length: 15 }, (_, i) => ({ time: `t${i}`, event: `e${i}` })),
          causalLinks: Array.from({ length: 9 }, (_, i) => ({ cause: `c${i}`, effect: `f${i}`, confidence: 0.5 })),
          perspectives: 'not-array',
        }),
      },
      {
        phase: 'conflict_analysis',
        startedAt: '',
        output: JSON.stringify({
          conflicts: Array.from({ length: 9 }, (_, i) => ({ partyA: `A${i}`, partyB: `B${i}`, nature: 'n', evidence: 'e' })),
        }),
      },
    ] as any

    const out = (engine as any).assemble('tid', phases)
    expect(out.facts).toHaveLength(10)
    expect(out.timeline).toHaveLength(8)
    expect(out.causalLinks).toHaveLength(5)
    expect(out.conflicts).toHaveLength(5)
    expect(out.perspectives).toEqual([])
  })

  it('结构化阶段失败时回退 facts 也截断到 10 条（M3）', () => {
    const engine = new DeepResearchEngine(makeLlm({}), {} as ObserverStore)
    const output = Array.from({ length: 18 }, (_, i) => `- 第${i}条足够长的事实内容`).join('\n')
    const phases = [{ phase: 'expansion', startedAt: '', output }] as any

    const out = (engine as any).assemble('tid', phases)
    expect(out.facts).toHaveLength(10)
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

  it('extractEntities 上限 15 + type 白名单 + aliases 清洗（M4）', async () => {
    const data = Array.from({ length: 25 }, (_, i) => ({
      name: `实体${i}`,
      type: i === 0 ? 'monster' : 'person',
      aliases: ['别名', 42, '', '  ', '真别名'],
    }))
    const store = new WorldModelStore(makeLlm({ data }), {} as ObserverStore)
    const result = { facts: ['一条事实'], perspectives: [], conflicts: [] } as any

    const entities = await (store as any).extractEntities(result)

    expect(entities).toHaveLength(15)
    expect(entities[0].type).toBe('concept')
    expect(entities[0].aliases).toEqual(['别名', '真别名'])
  })

  it('叙事标题匹配对引号/空白/大小写归一（M4）', async () => {
    const llm = makeLlm({ data: ' "AI 眼镜"  ' })
    const store = new WorldModelStore(llm, {} as ObserverStore)
    const narratives = [
      { id: 'n1', title: 'AI 眼镜', eventIds: ['e0'], entityIds: [], confidence: 0.4, lastUpdated: new Date().toISOString(), evolution: [] },
    ]
    const event = { id: 'e1', title: '新事件', entityIds: [], timestamp: new Date().toISOString(), summary: '', significance: 0.5 }

    await (store as any).updateNarratives(narratives, event, [], { facts: [] } as any)

    expect(narratives).toHaveLength(1)
    expect(narratives[0].eventIds).toContain('e1')
    expect(narratives[0].confidence).toBeGreaterThan(0.4)
  })

  it('causalLink confidence 超界时归一到 0-1（M4）', () => {
    const store = new WorldModelStore(makeLlm({}), {} as ObserverStore)
    const result = {
      causalLinks: [
        { cause: '甲导致', effect: '乙发生', confidence: 150 },
        { cause: '甲导致', effect: '丙发生', confidence: 0.4 },
        { cause: '甲导致', effect: '丁发生', confidence: Number.NaN },
      ],
      conflicts: [],
    } as any
    const newEntities = [
      { id: 'e1', name: '甲' },
      { id: 'e2', name: '乙' },
      { id: 'e3', name: '丙' },
      { id: 'e4', name: '丁' },
    ] as any
    const relations: any[] = []

    ;(store as any).extractRelations(result, relations, newEntities, newEntities)

    expect(relations.find((r) => r.to === 'e2').weight).toBe(1)
    expect(relations.find((r) => r.to === 'e3').weight).toBe(0.4)
    expect(relations.find((r) => r.to === 'e4').weight).toBe(0.5)
  })

  it('事件滚动保留 200 条、实体保留 300 个（M4）', async () => {
    const now = Date.now()
    const oldEvents = Array.from({ length: 250 }, (_, i) => ({
      id: `e${i}`,
      title: `t${i}`,
      entityIds: [],
      timestamp: new Date(now - (i + 1) * 1000).toISOString(),
      summary: '',
      significance: 0.1,
    }))
    const entities = Array.from({ length: 305 }, (_, i) => ({
      id: `en${i}`,
      name: `实体${i}`,
      type: 'concept',
      firstSeen: '',
      lastSeen: '',
      occurrences: 1,
      aliases: [],
      properties: {},
    }))
    const saved: any[] = []
    const store = {
      readWorldModel: vi.fn(() => ({ entities, events: oldEvents, trends: [], narratives: [], uncertainties: [], relations: [] })),
      saveWorldModel: vi.fn((m: any) => saved.push(m)),
    } as unknown as ObserverStore

    await new WorldModelStore(makeLlm({ data: [] }), store).update(
      { facts: [], timeline: [], causalLinks: [], perspectives: [], conflicts: [] } as any,
      { topic: '主题', metadata: { confidence: 0.5 } } as any,
    )

    expect(saved).toHaveLength(1)
    expect(saved[0].events).toHaveLength(200)
    expect(saved[0].events.some((e: any) => e.id.startsWith('evt_'))).toBe(true)
    expect(saved[0].events.some((e: any) => e.id === 'e249')).toBe(false)
    expect(saved[0].entities).toHaveLength(300)
  })
})
