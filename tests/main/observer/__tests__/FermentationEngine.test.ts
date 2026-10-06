import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FermentationEngine } from '@akemi-mio/intelligence-observer/FermentationEngine'
import type { ObserverLlmService } from '@akemi-mio/intelligence-observer/ObserverLlmService'
import type { ObserverStore } from '@akemi-mio/intelligence-observer/ObserverStore'
import type { Observation } from '@akemi-mio/intelligence-observer/types'

const OBS: Observation[] = [
  { id: 'o1', timestamp: new Date().toISOString(), source: 'rss', content: '缓存穿透导致数据库连接数上升' },
]

function makeLlm(payload: unknown) {
  return { generateJson: vi.fn().mockResolvedValue(payload) } as unknown as ObserverLlmService
}

function makeStore(previous: any[] = []) {
  return {
    readRecent: vi.fn(() => OBS),
    readRecentAssociations: vi.fn(() => previous),
    saveAssociation: vi.fn(),
  } as unknown as ObserverStore & { saveAssociation: ReturnType<typeof vi.fn> }
}

describe('FermentationEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('0-100 习惯输出的 strength 归一到 0-1（否则 WritingGate 0.7 线形同虚设）', async () => {
    const llm = makeLlm({
      data: { clusters: [{ theme: '缓存与连接池', associations: ['穿透', '连接数'], strength: 85 }] },
    })
    const store = makeStore()
    const engine = new FermentationEngine(llm, store)

    const result = await engine.ferment('morning')
    expect(result.clusters).toHaveLength(1)
    expect(result.clusters[0].strength).toBeCloseTo(0.85)
    expect(store.saveAssociation).toHaveBeenCalled()
  })

  it('strength < 0.3、非有限值、空主题全部被丢弃', async () => {
    const llm = makeLlm({
      data: {
        clusters: [
          { theme: '太弱', associations: ['a'], strength: 0.25 },
          { theme: '坏了', associations: ['a'], strength: 'high' },
          { theme: '   ', associations: ['a'], strength: 0.9 },
          { theme: '可用', associations: ['a'], strength: 0.9 },
          'not-an-object',
        ],
      },
    })
    const engine = new FermentationEngine(llm, makeStore())

    const result = await engine.ferment('afternoon')
    expect(result.clusters.map((c) => c.theme)).toEqual(['可用'])
  })

  it('输出上限 12 个 cluster，且按 strength 降序保留最强的', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      theme: `主题${i}`,
      associations: ['x'],
      strength: 0.4 + i * 0.01, // 0.40 ~ 0.54
    }))
    const llm = makeLlm({ data: { clusters: many } })
    const engine = new FermentationEngine(llm, makeStore())

    const result = await engine.ferment('night')
    expect(result.clusters).toHaveLength(12)
    expect(result.clusters[0].theme).toBe('主题14')
    for (let i = 1; i < result.clusters.length; i++) {
      expect(result.clusters[i].strength).toBeLessThanOrEqual(result.clusters[i - 1].strength)
    }
  })

  it('associations 去重去空并截断到 8 个，非数组归一为 []', async () => {
    const llm = makeLlm({
      data: {
        clusters: [
          { theme: '多词', associations: ['a', 'a', ' b ', '', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], strength: 0.8 },
          { theme: '坏词表', associations: 'not-array', strength: 0.8 },
        ],
      },
    })
    const engine = new FermentationEngine(llm, makeStore())

    const result = await engine.ferment('morning')
    expect(result.clusters[0].associations).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    expect(result.clusters[1].associations).toEqual([])
  })

  it('prompt 不再含"凭感觉"，改为锚回碎片的要求，并给出输出上限', async () => {
    const generateJson = vi.fn().mockResolvedValue({ data: { clusters: [] } })
    const llm = { generateJson } as unknown as ObserverLlmService
    const engine = new FermentationEngine(llm, makeStore())

    await engine.ferment('morning')
    const prompt = generateJson.mock.calls[0][0] as string
    expect(prompt).not.toContain('不需要准确')
    expect(prompt).toContain('指回碎片本身')
    expect(prompt).toContain('最多输出 12 个 cluster')
    expect(prompt).toContain('0-1 之间的小数')
  })

  it('上轮主题上下文最多带 20 条，防止 prompt 无界膨胀', async () => {
    const previous = [1, 2, 3].map((f) => ({
      generatedAt: new Date().toISOString(),
      clusters: Array.from({ length: 10 }, (_, i) => ({
        theme: `f${f}-t${i}`,
        associations: ['x'],
        observations: [],
        strength: 0.5,
      })),
    }))
    const generateJson = vi.fn().mockResolvedValue({ data: { clusters: [] } })
    const llm = { generateJson } as unknown as ObserverLlmService
    const engine = new FermentationEngine(llm, makeStore(previous))

    await engine.ferment('morning')
    const prompt = generateJson.mock.calls[0][0] as string
    const themeLines = prompt.split('\n').filter((l) => l.startsWith('- '))
    expect(themeLines.length).toBeLessThanOrEqual(20)
    expect(themeLines.length).toBeGreaterThan(0)
  })

  it('LLM 报错时返回空结果且不落盘', async () => {
    const llm = { generateJson: vi.fn().mockResolvedValue({ error: 'timeout' }) } as unknown as ObserverLlmService
    const store = makeStore()
    const engine = new FermentationEngine(llm, store)

    const result = await engine.ferment('night')
    expect(result.clusters).toEqual([])
    expect(store.saveAssociation).not.toHaveBeenCalled()
  })
})
