import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseBing,
  parseBaidu,
  parseDuckDuckGo,
  decodeBingRedirectUrl,
  searchWeb,
  webFetchTool,
  stripToText,
  webSearchTool,
} from '@akemi-mio/capabilities/tool/definitions/WebSearchTools'

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetchOnce(html: string, ok = true, status = 200): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok,
    status,
    text: async () => html,
  } as any)
}

function bingHref(target: string): string {
  return `https://cn.bing.com/ck/a?u=${encodeURIComponent(Buffer.from(target).toString('base64'))}`
}

const BING_HTML = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="${bingHref('https://example.com/')}">Example Domain</a></h2>
    <div class="b_caption"><p class="b_lineclamp2">This domain is for use in illustrative examples.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="${bingHref('https://example.org/')}">Example Org &amp; Friends</a></h2>
    <div class="b_caption"><p class="b_lineclamp2">Second snippet here.</p></div>
  </li>
</ol>`

const BAIDU_HTML = `
<div class="result c-container " id="1">
  <h3 class="t"><a href="https://www.baidu.com/link?url=abc123">百度测试结果</a></h3>
  <span class="content-right_8Zs40">这是百度的摘要内容。</span>
</div>`

const DDG_HTML = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2F&rut=1">DDG Result</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2F&rut=1">DDG 摘要文本</a>
</div>`

describe('解析函数', () => {
  it('parseBing 提取标题/解码 URL/摘要', () => {
    const results = parseBing(BING_HTML)
    expect(results).toHaveLength(2)
    expect(results[0].title).toBe('Example Domain')
    expect(results[0].url).toBe('https://example.com/')
    expect(results[0].snippet).toContain('illustrative examples')
    expect(results[1].title).toBe('Example Org & Friends')
  })

  it('parseBaidu 提取标题/链接/摘要', () => {
    const results = parseBaidu(BAIDU_HTML)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('百度测试结果')
    expect(results[0].url).toBe('https://www.baidu.com/link?url=abc123')
    expect(results[0].snippet).toContain('百度的摘要内容')
  })

  it('parseDuckDuckGo 提取标题/解码 uddg URL/摘要', () => {
    const results = parseDuckDuckGo(DDG_HTML)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://ddg.example/')
    expect(results[0].snippet).toContain('DDG 摘要文本')
  })

  it('decodeBingRedirectUrl 解码 base64 真实 URL', () => {
    expect(decodeBingRedirectUrl(bingHref('https://example.com/path?a=1'))).toBe('https://example.com/path?a=1')
    expect(decodeBingRedirectUrl('https://plain.example/')).toBe('https://plain.example/')
  })
})

describe('searchWeb 回退链', () => {
  it('首个后端有结果时返回该后端', async () => {
    mockFetchOnce(BING_HTML)
    const result = await searchWeb('test', 5, 8000)
    expect(result.engine).toBe('Bing')
    expect(result.results).toHaveLength(2)
  })

  it('首个后端无结果时切换到下一个', async () => {
    mockFetchOnce('<ol id="b_results"></ol>')
    mockFetchOnce(BAIDU_HTML)
    const result = await searchWeb('test', 5, 8000)
    expect(result.engine).toBe('Baidu')
    expect(result.results).toHaveLength(1)
  })

  it('全部后端失败时抛出聚合错误', async () => {
    mockFetchOnce('', false, 503)
    mockFetchOnce('', false, 403)
    mockFetchOnce('', false, 500)
    await expect(searchWeb('test', 5, 8000)).rejects.toThrow('所有搜索后端均失败')
  })
})

describe('web_fetch 工具', () => {
  const PAGE_HTML = `
<!DOCTYPE html><html><head>
<title>测试页面</title>
<meta name="description" content="页面简介">
<script>var x = 1;</script>
<style>body { color: red }</style>
</head><body>
<h1>标题一</h1>
<p>第一段文本 <b>加粗</b> 内容&amp;更多。</p>
<div>第二段内容</div>
</body></html>`

  it('提取标题与正文纯文本', async () => {
    mockFetchOnce(PAGE_HTML)
    const result = await webFetchTool.handler({ url: 'https://example.com/page' })
    expect(result.isError).toBe(false)
    expect(result.content[0].text).toContain('标题: 测试页面')
    expect(result.content[0].text).toContain('简介: 页面简介')
    expect(result.content[0].text).toContain('第一段文本 加粗 内容&更多。')
    expect(result.content[0].text).not.toContain('var x')
  })

  it('按 max_chars 截断并标注', async () => {
    const longBody = `<p>${'这是一段用于触发截断的正文内容。'.repeat(40)}</p>`
    mockFetchOnce(`<html><head><title>长页面</title></head><body>${longBody}</body></html>`)
    const result = await webFetchTool.handler({ url: 'https://example.com/page', max_chars: 500 })
    expect(result.isError).toBe(false)
    expect(result.content[0].text).toContain('（已截断）')
    expect(result.content[0].text.length).toBeLessThanOrEqual(520)
  })

  it('拒绝非 http/https URL', async () => {
    const result = await webFetchTool.handler({ url: 'ftp://example.com/file' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('http/https')
  })

  it('stripToText 清理脚本样式并保留块级换行', () => {
    const text = stripToText(PAGE_HTML)
    expect(text).toContain('标题一')
    expect(text).not.toContain('color: red')
  })
})

describe('web_search 工具', () => {
  it('query 为空时返回错误', async () => {
    const result = await webSearchTool.handler({ query: '  ' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('query 不能为空')
  })

  it('返回格式化结果并遵守 max_results', async () => {
    mockFetchOnce(BING_HTML)
    const result = await webSearchTool.handler({ query: 'test', max_results: 1 })
    expect(result.isError).toBe(false)
    expect(result.content[0].text).toContain('来源：Bing')
    expect(result.content[0].text).toContain('Example Domain')
    expect(result.content[0].text).not.toContain('Example Org')
  })

  it('max_results 超界时 clamp 到 1-10', async () => {
    const many = `<ol id="b_results">${Array.from(
      { length: 12 },
      (_, i) => `\n  <li class="b_algo"><h2><a href="${bingHref(`https://example.com/${i}`)}">Result ${i}</a></h2></li>`,
    ).join('')}\n</ol>`
    mockFetchOnce(many)
    const result = await webSearchTool.handler({ query: 'test', max_results: 999 })
    expect(result.isError).toBe(false)
    const numbered = (result.content[0].text.match(/^\d+\./gm) ?? []).length
    expect(numbered).toBe(10)
  })
})
