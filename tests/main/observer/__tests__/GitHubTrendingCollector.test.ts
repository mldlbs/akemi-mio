import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GitHubTrendingCollector, truncateAtWord, validRepoPath } from '@akemi-mio/observer/collectors/GitHubTrendingCollector'

const httpFetchMock = vi.hoisted(() => vi.fn())

vi.mock('@akemi-mio/observer/http', () => ({ httpFetch: httpFetchMock }))
vi.mock('@akemi-mio/observer/logger', () => ({ log: vi.fn() }))

function makeArticle(inner: string): string {
  return `<article class="Box-row">\n${inner}\n</article>`
}

describe('truncateAtWord', () => {
  it('回退到词边界，不产词中截断', () => {
    expect(truncateAtWord('word '.repeat(30).trim(), 12)).toBe('word word')
  })

  it('短于上限原样返回', () => {
    expect(truncateAtWord('short desc', 100)).toBe('short desc')
  })

  it('无空格长串不退化成极短前缀（超过半窗才回退）', () => {
    expect(truncateAtWord('a'.repeat(200), 100)).toHaveLength(100)
  })

  it('空格过早（首半窗内）时同样不回退', () => {
    expect(truncateAtWord(`x ${'b'.repeat(200)}`, 100)).toHaveLength(100)
  })
})

describe('validRepoPath', () => {
  it('合法两段 /owner/repo 通过', () => {
    expect(validRepoPath('owner/repo')).toBe('owner/repo')
  })

  it('login?return_to=… 拒（去 query 后单段）', () => {
    expect(validRepoPath('login?return_to=%2Ftrending')).toBeNull()
  })

  it('sponsors/… 拒（blocklist）', () => {
    expect(validRepoPath('sponsors/someone')).toBeNull()
  })

  it('两段站点链接 topics/… 拒（blocklist）', () => {
    expect(validRepoPath('topics/ai')).toBeNull()
  })

  it('多段路径拒', () => {
    expect(validRepoPath('a/b/c')).toBeNull()
  })

  it('单段路径拒', () => {
    expect(validRepoPath('torvalds')).toBeNull()
  })

  it('含非法字符（语言链接的 % 编码）拒', () => {
    expect(validRepoPath('languages/python%2Bjbd')).toBeNull()
  })
})

describe('GitHubTrendingCollector.collect', () => {
  beforeEach(() => {
    httpFetchMock.mockReset()
  })

  it('API 路径：title/desc 经 stripHtml，空标题条目丢弃，无任何 HTML 片段', async () => {
    httpFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        code: 0,
        data: [
          { title: '⭐<span class="text-warning">Foo</span> Bar', description: '<p>Desc with <b>HTML</b> tags</p>', stars: 100 },
          { title: '<em></em>', description: 'orphan desc', stars: 1 },
          { title: 'LongDesc', description: 'word '.repeat(40), stars: 2 },
        ],
      }),
    })

    const obs = await new GitHubTrendingCollector().collect()

    expect(obs).toHaveLength(2)
    expect(obs[0].content).toBe('【GitHub】⭐Foo Bar ⭐100 — Desc with HTML tags')
    expect(obs.every((o) => !o.content.includes('<'))).toBe(true)

    const descPart = obs[1].content.split('— ')[1]
    expect(descPart).toMatch(/^word( word)*$/)
    expect(descPart.length).toBeLessThanOrEqual(100)
    expect(obs[1].content).toBe(`【GitHub】LongDesc ⭐2 — ${truncateAtWord('word '.repeat(40), 100)}`)
  })

  it('fallback：href 扫描跳过 login/sponsors/topics，只收合法 /owner/repo', async () => {
    const html = [
      makeArticle(
        [
          '<a href="/login?return_to=%2Flogin">sign in</a>',
          '<a href="/owner/repo">owner/repo</a>',
          '<p class="col-9 color-fg-muted my-1 pr-4">A fine <b>description</b> here</p>',
          '<span class="d-inline-block float-right"><span class="d-inline-block mb-1"><svg class="octicon-star"></svg></span><span class="d-inline-block mb-1">1,234</span></span>',
        ].join('\n'),
      ),
      makeArticle(['<a href="/sponsors/someone">sponsor</a>', '<a href="/login?return_to=%2Fx">login</a>'].join('\n')),
      makeArticle(
        [
          '<a href="/topics/ai">ai</a>',
          '<a href="/someone/cool">someone/cool</a>',
          '<p class="col-9 color-fg-muted my-1 pr-4">Cool tool</p>',
        ].join('\n'),
      ),
    ].join('\n')

    httpFetchMock
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, text: async () => html })

    const obs = await new GitHubTrendingCollector().collect()

    expect(obs).toHaveLength(2)
    expect(obs[0].content).toBe('【GitHub】owner/repo ⭐1,234 — A fine description here')
    expect(obs[1].content).toBe('【GitHub】someone/cool ⭐? — Cool tool')
    expect(obs.every((o) => !o.content.includes('<'))).toBe(true)
    expect(obs.some((o) => /login|sponsors|topics/.test(o.content))).toBe(false)
  })

  it('API 与 fallback 全失败时返回空数组', async () => {
    httpFetchMock.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ ok: false })

    const obs = await new GitHubTrendingCollector().collect()
    expect(obs).toEqual([])
  })
})
