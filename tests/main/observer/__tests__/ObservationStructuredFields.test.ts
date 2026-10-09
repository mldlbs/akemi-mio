import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HackerNewsCollector } from '@akemi-mio/observer/collectors/HackerNewsCollector'
import { RSSCollector } from '@akemi-mio/observer/collectors/RSSCollector'
import { GitHubTrendingCollector } from '@akemi-mio/observer/collectors/GitHubTrendingCollector'
import type { Observation } from '@akemi-mio/observer/types'

const httpFetchMock = vi.hoisted(() => vi.fn())

vi.mock('@akemi-mio/observer/http', () => ({ httpFetch: httpFetchMock }))
vi.mock('@akemi-mio/observer/logger', () => ({ log: vi.fn() }))

function mockHnApi(stories: Record<string, unknown>[]) {
  httpFetchMock.mockImplementation((url: string) => {
    if (url.includes('topstories')) {
      return Promise.resolve({ ok: true, json: async () => stories.map((s) => s.id) })
    }
    const id = Number(url.match(/item\/(\d+)\.json/)?.[1])
    const story = stories.find((s) => s.id === id)
    return Promise.resolve({ ok: true, json: async () => story })
  })
}

describe('Observation.url/metadata 结构化字段', () => {
  beforeEach(() => {
    httpFetchMock.mockReset()
  })

  it('HN 条目 100% 携带 url（story.url 或 item?id 兜底）', async () => {
    mockHnApi([
      { id: 1, type: 'story', title: 'With URL', score: 42, by: 'alice', time: 1700000000, url: 'https://example.com/post' },
      { id: 2, type: 'story', title: 'Without URL', score: 7, by: 'bob', time: 1700000100 },
    ])

    const obs = await new HackerNewsCollector().collect()

    expect(obs).toHaveLength(2)
    expect(obs.every((o) => typeof o.url === 'string' && o.url.length > 0)).toBe(true)
    expect(obs[0].url).toBe('https://example.com/post')
    expect(obs[1].url).toBe('https://news.ycombinator.com/item?id=2')
    expect(obs[0].content).toContain('With URL (42 points by alice)')
  })

  it('HN 同 url 二次采集仍被去重（url 落库不破坏 seenUrls 语义）', async () => {
    const stories = [{ id: 1, type: 'story', title: 'Once', score: 1, by: 'x', time: 1700000000, url: 'https://a.com/1' }]
    mockHnApi(stories)
    const collector = new HackerNewsCollector()

    const first = await collector.collect()
    const second = await collector.collect()

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('RSS：带 link 的条目 url===link，无 link 的条目不含 url 键', async () => {
    httpFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { title: 'With link', link: 'https://news.example.com/a', pubDate: '2026-10-09T00:00:00Z' },
          { title: 'No link at all', guid: 'guid-2', pubDate: '2026-10-09T01:00:00Z' },
        ],
      }),
    })

    const obs = await new RSSCollector(['https://feed.example.com/rss']).collect()

    expect(obs).toHaveLength(2)
    expect(obs[0].url).toBe('https://news.example.com/a')
    expect('url' in obs[1]).toBe(false)
  })

  it('GH：metadata.description 为完整清洗描述，content 为词边界截断版', async () => {
    const longDesc = 'word '.repeat(40).trim() // 199 chars, well over the 100 cap
    httpFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 0,
        data: [{ title: 'RepoX', description: `<p>${longDesc}</p>`, stars: 5 }],
      }),
    })

    const obs = await new GitHubTrendingCollector().collect()

    expect(obs).toHaveLength(1)
    expect(obs[0].metadata).toEqual({ description: longDesc })
    const descPart = obs[0].content.split('— ')[1]
    expect(descPart.length).toBeLessThan(longDesc.length)
    expect(descPart).toMatch(/^word( word)*$/)
  })

  it('老数据兼容：四字段 JSON 反序列化即为合法 Observation，新字段为 undefined', () => {
    const legacy = JSON.parse('{"id":"x_1","timestamp":"2026-10-01T00:00:00.000Z","source":"system","content":"old shape"}')
    const obs: Observation = legacy
    expect(obs.id).toBe('x_1')
    expect(obs.url).toBeUndefined()
    expect(obs.metadata).toBeUndefined()
    expect(JSON.parse(JSON.stringify(obs))).toEqual({
      id: 'x_1',
      timestamp: '2026-10-01T00:00:00.000Z',
      source: 'system',
      content: 'old shape',
    })
  })
})
