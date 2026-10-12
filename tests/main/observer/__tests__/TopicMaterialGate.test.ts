import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractFallbackKeywords } from '@akemi-mio/intelligence-observer/TrendEngine'
import { isPlausibleKeyword, TensionFieldEngine } from '@akemi-mio/intelligence-observer/TensionFieldEngine'
import type { ObserverLlmService } from '@akemi-mio/intelligence-observer/ObserverLlmService'
import type { ObserverStore } from '@akemi-mio/intelligence-observer/ObserverStore'

function makeLlm(payload: unknown) {
  return {
    generateJson: vi.fn().mockResolvedValue(payload),
    generate: vi.fn().mockResolvedValue(payload),
  } as unknown as ObserverLlmService
}

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    getRecentTopics: vi.fn(() => []),
    readWorldModel: vi.fn(() => ({ entities: [], uncertainties: [] })),
    saveTopicSelection: vi.fn(),
    readEvolutionParams: vi.fn(() => null),
    ...overrides,
  } as unknown as ObserverStore
}

describe('extractFallbackKeywords — 残缺词 bug 回归', () => {
  it('英文单词不再被截断成 8 字符残片（"Anthropic" ≠ "Anthropi"）', () => {
    const kws = extractFallbackKeywords('Anthropic 发布了新的 Claude 模型')
    expect(kws).toContain('Anthropic')
    expect(kws).not.toContain('Anthropi')
  })

  it('多个完整词都能提取', () => {
    const kws = extractFallbackKeywords('OpenAI GPT-5 benchmark results')
    expect(kws).toContain('OpenAI')
    expect(kws).toContain('GPT-5')
    expect(kws).toContain('benchmark')
    expect(kws).not.toContain('OpenAI ') // 不带尾部空格
  })

  it('中文内容按空白/标点切分', () => {
    const kws = extractFallbackKeywords('人工智能大模型，安全对齐问题')
    expect(kws).toContain('人工智能大模型')
    expect(kws).toContain('安全对齐问题')
  })

  it('纯数字和单字符被过滤', () => {
    const kws = extractFallbackKeywords('12345 a b 测试内容')
    expect(kws).not.toContain('12345')
    expect(kws).not.toContain('a')
    expect(kws).not.toContain('b')
    expect(kws).toContain('测试内容')
  })

  it('超长 token（>20 字符）被截断丢弃', () => {
    const kws = extractFallbackKeywords('x'.repeat(30) + ' short')
    expect(kws.every((k) => k.length <= 20)).toBe(true)
  })
})

describe('isPlausibleKeyword — 选题门槛回归', () => {
  it('完整英文单词通过', () => {
    expect(isPlausibleKeyword('Anthropic')).toBe(true)
    expect(isPlausibleKeyword('OpenAI')).toBe(true)
    expect(isPlausibleKeyword('Claude')).toBe(true)
  })

  it('中文关键词通过', () => {
    expect(isPlausibleKeyword('人工智能')).toBe(true)
    expect(isPlausibleKeyword('缓存穿透')).toBe(true)
  })

  it('2 字母全大写缩写通过（AI/IT/OS）', () => {
    expect(isPlausibleKeyword('AI')).toBe(true)
    expect(isPlausibleKeyword('IT')).toBe(true)
  })

  it('2 字符非全大写缩写被拒（残片）', () => {
    expect(isPlausibleKeyword('An')).toBe(false)
    expect(isPlausibleKeyword('xY')).toBe(false)
  })

  it('3 字符无元音纯 ASCII 被拒（截断残片）', () => {
    expect(isPlausibleKeyword('xyz')).toBe(false)
    expect(isPlausibleKeyword('str')).toBe(false)
    expect(isPlausibleKeyword('ghz')).toBe(false)
  })

  it('3 字符含元音通过', () => {
    expect(isPlausibleKeyword('Ant')).toBe(true) // 有元音 a
    expect(isPlausibleKeyword('The')).toBe(true)
  })

  it('纯数字被拒', () => {
    expect(isPlausibleKeyword('123')).toBe(false)
    expect(isPlausibleKeyword('2024')).toBe(false)
  })

  it('单字符被拒', () => {
    expect(isPlausibleKeyword('a')).toBe(false)
    expect(isPlausibleKeyword('中')).toBe(false)
  })

  it('纯标点被拒', () => {
    expect(isPlausibleKeyword('。。')).toBe(false)
    expect(isPlausibleKeyword('!!')).toBe(false)
  })
})

describe('TensionFieldEngine.buildCandidates — 不合理关键词不入选', () => {
  beforeEach(() => vi.clearAllMocks())

  it('短残片信号被过滤，不进入候选', async () => {
    const llm = makeLlm({ data: 0.5 }) // rateNovelty/rateContradiction 返回数字
    const engine = new TensionFieldEngine(llm, makeStore())

    const trends = {
      signals: [
        // "An" 是 2 字符非全大写缩写 → isPlausibleKeyword 拒
        {
          keyword: 'An',
          score: 0.9,
          sourceDiversity: 1,
          occurrenceCount: 3,
          lastSeenAt: new Date().toISOString(),
          source: 'rss',
          firstSeenAt: '',
          recentObservationIds: [],
        },
        // "Anthropic" 完整词 → 通过
        {
          keyword: 'Anthropic',
          score: 0.7,
          sourceDiversity: 1,
          occurrenceCount: 5,
          lastSeenAt: new Date().toISOString(),
          source: 'rss',
          firstSeenAt: '',
          recentObservationIds: [],
        },
      ],
      sourceSummary: { totalItemsReceived: 10, feedsContacted: 1, uniqueKeywords: 2 },
    } as any

    const candidates = await (engine as any).buildCandidates(trends, { alpha: 0.3, beta: 0.2, gamma: 0.2, delta: 0.15, epsilon: 0.15 })

    const topics = candidates.map((c: any) => c.topic)
    expect(topics).toContain('Anthropic')
    expect(topics).not.toContain('An')
  })
})
